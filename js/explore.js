// 迷霧探索成就頁：探索率、迷霧小地圖、每年新解鎖、最近解鎖、明細、成就徽章、成就明細彈窗
// 改寫自原專案 dashboard/explore.js；資料改由計算 Worker 提供（js/core/client.js）
//
// 用法：
//   const ex = createExplore(document.getElementById('explore'), {
//       loadMap: level => Promise<{ viewBox, paths }>,   // data/map_<level>.json
//       loadDetail: id => Promise<明細>,                  // Worker 的 detail
//   });
//   ex.setData(stats);   // 計算結果（重算後再呼叫一次即可）
//   ex.jumpToGroup('peak');
//
// 與原專案的差異：不顯示照片數；每年新解鎖改為自繪 SVG（不用 Plotly）
// 所需套件：Leaflet（成就明細的小地圖；沒有載入時不顯示地圖）

export const GROUP_LABEL = { milestone: '里程碑', conquer: '制霸', pole: '極點', island: '離島', landmark: '景點', bspot: 'B 級景點', peak: '登山', rail: '臺鐵・高鐵', metro: '捷運', lrt: '輕軌', nature: '國家公園與保護區', travel: '旅行' };
const UNIT_LABEL = { county: '縣市', town: '鄉鎮', village: '村里' };
const PLACE_GROUPS = new Set(['pole', 'island', 'landmark', 'bspot', 'nature']);   // 有小地圖的地點類
const COMPACT_GROUPS = new Set(['island', 'landmark', 'bspot', 'nature']);   // 數量多的類別用小卡片
// 以座標格子計的集點卡（百岳、鐵道車站）：單位與「達成」的說法；明細 id 前綴
const STATION_STAMP = { unit: '站', verb: '到站', prefix: 'rail_' };
export const POINT_STAMPS = { peak: { unit: '座', verb: '登頂', prefix: 'peaks_' }, rail: STATION_STAMP, metro: STATION_STAMP, lrt: STATION_STAMP };
const isPointDetail = id => Object.values(POINT_STAMPS).some(p => id.startsWith(p.prefix));
const TIER_LABEL = { bronze: '銅', silver: '銀', gold: '金', platinum: '白金', legend: '傳奇' };
const EARLY_YEAR = 2015; // 之前的零星紀錄合併顯示，地圖顏色也從這年起算

const pad = n => String(n).padStart(2, '0');
// 紀錄的 time 是「當地時鐘時間當成 UTC」，一律用 getUTC*
const fmtDate = t => { if (!t) return '—'; const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const fmtInt = n => Math.round(n).toLocaleString();
const fmtPct = r => (r * 100).toFixed(r < 0.1 ? 2 : 1) + '%';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const themeColor = name => window.photoTheme ? window.photoTheme.color(name) : '';

export function createExplore(root, { loadMap, loadDetail }) {
    const state = { unit: 'town', metric: 'count', data: null, maps: {}, idx: null };
    let built = false;

    // ---------- 資料整理 ----------

    function buildIndex(d) {
        const county = new Map(d.counties.map(c => [c.code, c]));
        const town = new Map(d.towns.map(t => [t.code, t]));
        const village = new Map(d.villages.map(v => [v.code, v]));
        return { county, town, village };
    }

    function fullName(unit, item) {
        const { county, town } = state.idx;
        if (unit === 'county') return item.name;
        if (unit === 'town') return `${county.get(item.county)?.name || ''} ${item.name}`;
        const t = town.get(item.town);
        return `${t ? county.get(t.county)?.name + ' ' + t.name : ''} ${item.name || '（無名稱）'}`;
    }

    /** 目前單位的「已解鎖項目」：[{code, name, first, area}] */
    function unlockedItems(unit) {
        const d = state.data;
        const list = unit === 'county' ? d.counties.filter(c => c.unlocked)
            : unit === 'town' ? d.towns.filter(t => t.unlocked)
                : d.villages;
        return list.map(x => ({ code: x.code, name: fullName(unit, x), first: x.first, area: x.area }));
    }

    // ---------- 版面 ----------

    function render() {
        root.innerHTML = `
            <div class="ex-head" id="ex-overview">
                <h3 class="ex-title">🌫️ 迷霧探索</h3>
                <div class="ex-seg" data-group="unit">
                    <button type="button" data-v="county">縣市</button>
                    <button type="button" data-v="town">鄉鎮</button>
                    <button type="button" data-v="village">村里</button>
                </div>
                <div class="ex-seg" data-group="metric">
                    <button type="button" data-v="count">個數</button>
                    <button type="button" data-v="area">面積</button>
                </div>
                <span class="ex-hint">有 1 筆足跡就算解鎖；首次解鎖時間取最早一筆時間正常的紀錄</span>
            </div>
            <div class="ex-grid">
                <div class="ex-card ex-mapcard" id="ex-mapcard">
                    <div class="ex-card-title">迷霧小地圖 <small id="ex-map-note"></small></div>
                    <div class="ex-mapwrap" id="ex-mapwrap" role="button" tabindex="0" title="點擊放大">
                        <svg id="ex-map" class="ex-map" preserveAspectRatio="xMidYMid meet"></svg>
                        <div id="ex-map-loading" class="ex-map-loading">載入地圖中…</div>
                        <div id="ex-village-open" class="ex-village-open" hidden>
                            <div class="ex-village-icon">🗺️</div>
                            <div class="ex-village-text">村里迷霧地圖</div>
                            <div class="ex-village-sub">7,975 個村里，點擊開啟大圖（可縮放、拖曳）</div>
                        </div>
                        <div id="ex-tip" class="ex-tip" hidden></div>
                        <span class="ex-zoom-hint">🔍 點擊放大</span>
                    </div>
                    <div id="ex-legend" class="ex-legend"></div>
                </div>
                <div class="ex-card ex-progress">
                    <div class="ex-card-title">探索率</div>
                    <div id="ex-donut" class="ex-donut"></div>
                    <div id="ex-progress-sub" class="ex-progress-sub"></div>
                </div>
                <div class="ex-card ex-recent">
                    <div class="ex-card-title">最近解鎖</div>
                    <ol id="ex-recent" class="ex-recent-list"></ol>
                </div>
                <div class="ex-card ex-yearly" id="ex-yearly-card">
                    <div class="ex-card-title" id="ex-yearly-title">每年新解鎖</div>
                    <div id="ex-yearly" class="ex-yearly-chart"></div>
                </div>
            </div>
            <details class="ex-section" id="ex-detail-sec">
                <summary><span class="ex-section-title">📋 <span id="ex-detail-title">明細</span></span>
                    <span class="ex-section-hint">點擊展開</span></summary>
                <div id="ex-detail" class="ex-detail"></div>
            </details>
            <details class="ex-section ex-badges-sec" id="ex-badges-sec">
                <summary><span class="ex-section-title">🏅 成就徽章</span>
                    <span id="ex-badge-count" class="ex-badge-count"></span>
                    <span class="ex-section-hint">點擊展開</span>
                    <!-- 摺疊時顯示各大類的解鎖進度環（展開後隱藏） -->
                    <span id="ex-ach-overview" class="ex-ach-overview"></span></summary>
                <div id="ex-badges" class="ex-badges"></div>
            </details>`;

        root.querySelectorAll('.ex-seg').forEach(seg => {
            seg.addEventListener('click', e => {
                const v = e.target.dataset && e.target.dataset.v;
                if (!v) return;
                state[seg.dataset.group] = v;
                update();
            });
        });
        let rt = null;
        window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.data && renderYearly(), 150); });
        bindInlineMap();
    }

    function update() {
        root.querySelectorAll('.ex-seg').forEach(seg => {
            seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === state[seg.dataset.group]));
        });
        renderProgress();
        renderRecent();
        renderYearly();
        renderDetail();
        renderMap();
    }

    // ---------- 探索率（環形圖） ----------

    function renderProgress() {
        const s = state.data.summary[state.unit];
        const unit = UNIT_LABEL[state.unit];
        const byArea = state.metric === 'area';
        const ratio = byArea ? s.area_unlocked / s.area : s.unlocked / s.total;
        const other = byArea ? s.unlocked / s.total : s.area_unlocked / s.area;
        const r = 52, c = 2 * Math.PI * r;
        root.querySelector('#ex-donut').innerHTML = `
            <svg viewBox="0 0 140 140" class="ex-donut-svg">
                <circle cx="70" cy="70" r="${r}" class="ex-donut-bg"/>
                <circle cx="70" cy="70" r="${r}" class="ex-donut-fg"
                    stroke-dasharray="${(c * ratio).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 70 70)"/>
                <text x="70" y="68" class="ex-donut-pct">${fmtPct(ratio)}</text>
                <text x="70" y="90" class="ex-donut-label">${byArea ? '面積' : '個數'}・${unit}</text>
            </svg>`;
        root.querySelector('#ex-progress-sub').innerHTML = byArea
            ? `<b>${fmtInt(s.area_unlocked)}</b> / ${fmtInt(s.area)} km²<br><span>個數：${s.unlocked.toLocaleString()} / ${s.total.toLocaleString()} 個${unit}（${fmtPct(other)}）</span>`
            : `<b>${s.unlocked.toLocaleString()}</b> / ${s.total.toLocaleString()} 個${unit}<br><span>面積：${fmtInt(s.area_unlocked)} / ${fmtInt(s.area)} km²（${fmtPct(other)}）</span>`;
    }

    // ---------- 最近解鎖 ----------

    function renderRecent() {
        const items = unlockedItems(state.unit).filter(x => x.first).sort((a, b) => a.first - b.first);
        const recent = items.map((x, i) => ({ ...x, n: i + 1 })).reverse().slice(0, 10);
        root.querySelector('#ex-recent').innerHTML = recent.length
            ? recent.map(x => `<li><span class="ex-recent-date">${fmtDate(x.first)}</span>
                                  <span class="ex-recent-name" title="${esc(x.name)}">${esc(x.name)}</span>
                                  <span class="ex-recent-n">第 ${x.n.toLocaleString()} 個</span></li>`).join('')
            : '<li class="ex-empty">尚無資料</li>';
    }

    // ---------- 每年新解鎖（SVG 長條＋累積折線） ----------

    function renderYearly() {
        const byArea = state.metric === 'area';
        const box = root.querySelector('#ex-yearly');
        const items = unlockedItems(state.unit).filter(x => x.first);
        const byYear = new Map();
        for (const x of items) {
            const y = new Date(x.first * 1000).getUTCFullYear();
            byYear.set(y, (byYear.get(y) || 0) + (byArea ? x.area : 1));
        }
        const years = [...byYear.keys()].sort((a, b) => a - b);
        const unitText = byArea ? 'km²' : `個${UNIT_LABEL[state.unit]}`;
        root.querySelector('#ex-yearly-title').textContent = `每年新解鎖（${unitText}）`;
        if (!years.length) { box.innerHTML = '<div class="ex-empty">尚無資料</div>'; return; }
        // 2015 年以前的零星紀錄合併成一欄，避免拉出一長串空白年份
        const early = years.filter(y => y < EARLY_YEAR).reduce((s, y) => s + byYear.get(y), 0);
        const labels = [], vals = [];
        if (early) { labels.push(`${EARLY_YEAR} 前`); vals.push(early); }
        for (let y = Math.max(years[0], EARLY_YEAR); y <= years[years.length - 1]; y++) { labels.push(String(y)); vals.push(byYear.get(y) || 0); }
        let acc = 0;
        const cum = vals.map(v => (acc += v));
        const fmtV = v => v.toLocaleString(undefined, { maximumFractionDigits: byArea ? 1 : 0 });

        // 字級倍率（css/app.css 的 --fs，寬螢幕放大）：留白、高度、圖例間距一起放大
        const fs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 1;
        const W = Math.max(280, box.clientWidth || 600), H = Math.round(240 * fs);
        const m = { t: 30 * fs, r: 52 * fs, b: 28 * fs, l: 52 * fs };
        const lg = 12 * fs;   // 圖例字級
        const iw = W - m.l - m.r, ih = H - m.t - m.b;
        const nice = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
        const yMax = nice(Math.max(...vals)), cMax = nice(cum[cum.length - 1]);
        const bw = iw / labels.length;
        const x = i => m.l + bw * i + bw / 2;
        const yL = v => m.t + ih - v / yMax * ih, yR = v => m.t + ih - v / cMax * ih;
        const ticks = [0, 0.25, 0.5, 0.75, 1];
        const step = Math.ceil(labels.length / Math.max(1, Math.floor(iw / 44)));   // x 軸標籤太擠就隔幾個顯示
        const cFmt = v => v >= 10000 ? (v / 1000).toLocaleString() + 'k' : v.toLocaleString();
        box.innerHTML = `<svg class="ex-ychart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="每年新解鎖">
            <g class="ex-ychart-legend" transform="translate(${m.l} ${lg + 2})">
                <rect width="${lg}" height="${lg * 0.8}" y="${-lg * 0.7}" style="fill:#ff8a5c"/><text x="${lg * 1.4}">當年新解鎖</text>
                <line x1="${lg * 9}" x2="${lg * 10.5}" y1="${-lg * 0.3}" y2="${-lg * 0.3}" class="ex-ychart-line"/><text x="${lg * 10.9}">累積</text>
            </g>
            ${ticks.map(t => `<line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih - t * ih}" y2="${m.t + ih - t * ih}" class="ex-ychart-grid"/>
                <text x="${m.l - 6}" y="${m.t + ih - t * ih + 4}" text-anchor="end" class="ex-ychart-tick">${cFmt(+(yMax * t).toFixed(2))}</text>
                <text x="${W - m.r + 6}" y="${m.t + ih - t * ih + 4}" class="ex-ychart-tick">${cFmt(+(cMax * t).toFixed(2))}</text>`).join('')}
            ${vals.map((v, i) => `<g class="ex-ychart-col"><title>${labels[i]}：${fmtV(v)} ${unitText}（累積 ${fmtV(cum[i])}）</title>
                <rect x="${m.l + bw * i}" y="${m.t}" width="${bw}" height="${ih}" class="ex-ychart-hit"/>
                <rect x="${(x(i) - bw * 0.36).toFixed(1)}" y="${yL(v).toFixed(1)}" width="${(bw * 0.72).toFixed(1)}" height="${(m.t + ih - yL(v)).toFixed(1)}" style="fill:#ff8a5c" rx="2"/></g>`).join('')}
            <polyline points="${cum.map((v, i) => `${x(i).toFixed(1)},${yR(v).toFixed(1)}`).join(' ')}" class="ex-ychart-line"/>
            ${cum.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${yR(v).toFixed(1)}" r="2.5" class="ex-ychart-dot"/>`).join('')}
            ${labels.map((l, i) => (i % step === 0 || i === labels.length - 1) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="ex-ychart-tick">${l}</text>` : '').join('')}
        </svg>`;
    }

    // ---------- 明細 ----------

    function bar(done, total, label) {
        const r = total ? done / total : 0;
        return `<div class="ex-bar" title="${esc(label)}"><div class="ex-bar-fill${r >= 1 ? ' full' : ''}" style="width:${(r * 100).toFixed(1)}%"></div></div>
                <span class="ex-bar-text">${label}</span>`;
    }

    function renderDetail() {
        const d = state.data, byArea = state.metric === 'area';
        const el = root.querySelector('#ex-detail');
        const title = root.querySelector('#ex-detail-title');
        const countyProgress = c => byArea ? [c.town_area_unlocked, c.area] : [c.towns_unlocked, c.towns];
        const sortedCounties = [...d.counties].sort((a, b) => {
            const [x1, y1] = countyProgress(a), [x2, y2] = countyProgress(b);
            return x2 / y2 - x1 / y1 || a.code.localeCompare(b.code);
        });

        if (state.unit === 'county') {
            title.textContent = `明細：各縣市（鄉鎮解鎖${byArea ? '面積' : '數'}，依進度排序）`;
            el.innerHTML = `<div class="ex-table">${sortedCounties.map(c => {
                const [x, y] = countyProgress(c);
                const label = byArea ? `${fmtInt(x)} / ${fmtInt(y)} km²` : `${x} / ${y} 鄉鎮`;
                return `<div class="ex-row${c.unlocked ? '' : ' locked'}">
                    <span class="ex-row-name">${esc(c.name)}${c.towns_unlocked === c.towns ? ' <span class="ex-tag">制霸</span>' : ''}</span>
                    <span class="ex-row-date">${c.unlocked ? '首次 ' + fmtDate(c.first) : '未解鎖'}</span>
                    ${bar(x, y, label)}
                </div>`;
            }).join('')}</div>`;
            return;
        }

        if (state.unit === 'town') {
            title.textContent = '明細：各縣市的鄉鎮（滑過看首次解鎖日期）';
            el.innerHTML = sortedCounties.map(c => {
                const towns = d.towns.filter(t => t.county === c.code);
                const chips = towns.map(t => `<span class="ex-chip${t.unlocked ? ' on' : ''}"
                    title="${esc(t.name)}：${t.unlocked ? '首次解鎖 ' + fmtDate(t.first) : '未解鎖'}">${esc(t.name)}</span>`).join('');
                return `<div class="ex-group">
                    <div class="ex-group-head"><b>${esc(c.name)}</b><span>${c.towns_unlocked} / ${c.towns}</span>
                        ${c.towns_unlocked === c.towns ? '<span class="ex-tag">制霸</span>' : ''}</div>
                    <div class="ex-chips">${chips}</div></div>`;
            }).join('');
            return;
        }

        // 村里：依縣市分組（可展開），每個鄉鎮一列村里進度
        title.textContent = `明細：各縣市的村里（依鄉鎮列出村里解鎖${byArea ? '面積' : '數'}）`;
        const vProg = x => byArea ? [x.village_area_unlocked, x.village_area ?? x.area] : [x.villages_unlocked, x.villages];
        el.innerHTML = [...d.counties].sort((a, b) => b.villages_unlocked / b.villages - a.villages_unlocked / a.villages).map(c => {
            const towns = d.towns.filter(t => t.county === c.code)
                .sort((a, b) => b.villages_unlocked / b.villages - a.villages_unlocked / a.villages);
            const [cx, cy] = byArea ? [c.village_area_unlocked, c.area] : [c.villages_unlocked, c.villages];
            return `<details class="ex-fold">
                <summary><span class="ex-row-name">${esc(c.name)}</span>
                    ${bar(cx, cy, byArea ? `${fmtInt(cx)} / ${fmtInt(cy)} km²` : `${cx} / ${cy} 村里`)}</summary>
                <div class="ex-table">${towns.map(t => {
                    const [x, y] = vProg(t);
                    return `<div class="ex-row${t.villages_unlocked ? '' : ' locked'}">
                        <span class="ex-row-name">${esc(t.name)}</span>
                        <span class="ex-row-date">${t.unlocked ? '首次 ' + fmtDate(t.first) : '未解鎖'}</span>
                        ${bar(x, y, byArea ? `${x.toFixed(1)} / ${y.toFixed(1)} km²` : `${x} / ${y} 村里`)}
                    </div>`;
                }).join('')}</div>
            </details>`;
        }).join('');
    }

    // ---------- 迷霧小地圖（內嵌＋點擊放大的彈窗） ----------

    // 依首次解鎖年份上色：越早越淡、越近越深（資料色，深淺主題相同）
    function yearColor(year, y0, y1) {
        const r = y1 > y0 ? Math.max(0, Math.min(1, (year - y0) / (y1 - y0))) : 1;
        const from = [255, 226, 205], to = [232, 74, 23];
        return `rgb(${from.map((v, i) => Math.round(v + (to[i] - v) * r)).join(',')})`;
    }

    function getMap(level) {
        if (!state.maps[level]) state.maps[level] = loadMap(level).catch(e => { delete state.maps[level]; throw e; });
        return state.maps[level];
    }

    /** 把某層級的迷霧地圖畫進 svg；回傳 [y0, y1]（上色的年份範圍） */
    function drawMap(svg, m, level) {
        const idx = state.idx[level];
        const firsts = [...idx.values()].map(x => x.first).filter(Boolean).map(t => new Date(t * 1000).getUTCFullYear());
        const y1 = firsts.length ? Math.max(...firsts) : new Date().getUTCFullYear();
        const y0 = firsts.length ? Math.min(y1, Math.max(EARLY_YEAR, Math.min(...firsts))) : y1;
        // 已解鎖的畫在後面，滑過時的外框才不會被遮住
        const parts = { off: [], on: [] };
        for (const p of m.paths) {
            const item = idx.get(p.code);
            const on = item && (level === 'village' || item.unlocked);
            const fill = on && item.first ? yearColor(new Date(item.first * 1000).getUTCFullYear(), y0, y1) : on ? '#ffcfb5' : null;
            parts[on ? 'on' : 'off'].push(`<path d="${p.d}" data-code="${p.code}" class="${on ? 'on' : 'off'}"${fill ? ` style="fill:${fill}"` : ''}/>`);
        }
        svg.setAttribute('viewBox', m.viewBox);
        svg.classList.toggle('fine', level === 'village');
        svg.innerHTML = `<g class="ex-fog">${parts.off.join('')}</g><g class="ex-clear">${parts.on.join('')}</g>`;
        svg._names = new Map(m.paths.map(p => [p.code, p.name]));
        svg._level = level;
        return [y0, y1];
    }

    const legendHtml = (y0, y1) => `
        <span class="ex-legend-item"><i class="sw fog"></i>未解鎖（迷霧）</span>
        <span class="ex-legend-item"><i class="sw grad"></i>已解鎖：${y0} 年${y0 === EARLY_YEAR ? '前' : ''} → ${y1} 年（首次解鎖年份）</span>`;

    // 內嵌小地圖：縣市、鄉鎮直接顯示；村里太細，只放一個開啟大圖的按鈕
    async function renderMap() {
        const level = state.unit;
        const svg = root.querySelector('#ex-map');
        const loading = root.querySelector('#ex-map-loading');
        const villageOpen = root.querySelector('#ex-village-open');
        root.querySelector('#ex-tip').hidden = true;
        root.querySelector('#ex-map-note').textContent = `（${UNIT_LABEL[level]}；台澎金馬）`;

        if (level === 'village') {
            svg.style.display = 'none';
            loading.hidden = true;
            villageOpen.hidden = false;
            root.querySelector('#ex-legend').innerHTML = '';
            return;
        }
        villageOpen.hidden = true;
        svg.style.display = '';
        loading.hidden = false;
        loading.textContent = '載入地圖中…';
        let m;
        try {
            m = await getMap(level);
        } catch (e) {
            loading.textContent = '❌ 地圖載入失敗';
            return;
        }
        if (level !== state.unit) return; // 載入期間又切換了單位
        loading.hidden = true;
        const [y0, y1] = drawMap(svg, m, level);
        root.querySelector('#ex-legend').innerHTML = legendHtml(y0, y1);
    }

    // 滑過顯示名稱與首次解鎖日期
    function bindHover(svg, tip, wrap) {
        svg.addEventListener('mousemove', e => {
            const code = e.target.dataset && e.target.dataset.code;
            if (!code || svg._dragging) { tip.hidden = true; return; }
            const item = state.idx[svg._level].get(code);
            const on = item && (svg._level === 'village' || item.unlocked);
            const name = svg._names?.get(code) || code;
            tip.innerHTML = `<b>${esc(name)}</b><br>${on ? `首次解鎖 ${fmtDate(item.first)}` : '未解鎖'}`;
            const r = wrap.getBoundingClientRect();
            tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 200) + 'px';
            tip.style.top = Math.min(e.clientY - r.top + 14, r.height - 50) + 'px';
            tip.hidden = false;
        });
        svg.addEventListener('mouseleave', () => { tip.hidden = true; });
    }

    // ---------- 放大彈窗：滾輪縮放、拖曳平移 ----------

    let modal = null;

    function buildModal() {
        modal = document.createElement('div');
        modal.className = 'ex-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="ex-modal-box" role="dialog" aria-modal="true" aria-labelledby="ex-modal-title">
                <div class="ex-modal-head">
                    <span id="ex-modal-title" class="ex-modal-title"></span>
                    <span class="ex-modal-hint">滾輪縮放・拖曳移動・雙擊放大</span>
                    <span class="ex-modal-tools">
                        <button type="button" data-act="in" title="放大">＋</button>
                        <button type="button" data-act="out" title="縮小">－</button>
                        <button type="button" data-act="reset" title="重設">重設</button>
                        <button type="button" data-act="close" class="ex-modal-x" title="關閉（Esc）">✕</button>
                    </span>
                </div>
                <div class="ex-modal-body">
                    <svg class="ex-map ex-modal-map" preserveAspectRatio="xMidYMid meet"></svg>
                    <div class="ex-map-loading">載入地圖中…</div>
                    <div class="ex-tip" hidden></div>
                </div>
                <div class="ex-legend ex-modal-legend"></div>
            </div>`;
        document.body.appendChild(modal);

        const svg = modal.querySelector('svg');
        const body = modal.querySelector('.ex-modal-body');
        bindHover(svg, modal.querySelector('.ex-tip'), body);

        const setVb = v => { svg._vb = v; svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`); };
        // 螢幕座標 → 地圖座標（preserveAspectRatio=meet：取較大的縮放比，並扣掉置中留白）
        const toSvg = (cx, cy) => {
            const r = svg.getBoundingClientRect(), v = svg._vb;
            const s = Math.max(v.w / r.width, v.h / r.height);
            const ox = (r.width - v.w / s) / 2, oy = (r.height - v.h / s) / 2;
            return { x: v.x + (cx - r.left - ox) * s, y: v.y + (cy - r.top - oy) * s, s };
        };
        // 以螢幕上的 (cx, cy) 為中心縮放；未指定時以畫面中心
        const zoom = (factor, cx, cy) => {
            const v = svg._vb, base = svg._base;
            const w = Math.min(base.w, Math.max(base.w / 60, v.w / factor));
            if (w === base.w) { setVb({ ...base }); return; }
            const f = v.w / w;
            const p = cx === undefined ? { x: v.x + v.w / 2, y: v.y + v.h / 2 } : toSvg(cx, cy);
            setVb({ x: p.x - (p.x - v.x) / f, y: p.y - (p.y - v.y) / f, w, h: v.h / f });
        };
        svg.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY); }, { passive: false });
        svg.addEventListener('dblclick', e => zoom(2, e.clientX, e.clientY));

        let drag = null;
        svg.addEventListener('pointerdown', e => {
            drag = { x: e.clientX, y: e.clientY, vb: { ...svg._vb }, moved: false };
            svg.setPointerCapture(e.pointerId);
        });
        svg.addEventListener('pointermove', e => {
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 3) return;
            drag.moved = svg._dragging = true;
            svg.classList.add('dragging');
            const { s } = toSvg(0, 0);
            setVb({ ...drag.vb, x: drag.vb.x - dx * s, y: drag.vb.y - dy * s });
        });
        const endDrag = () => { drag = null; svg._dragging = false; svg.classList.remove('dragging'); };
        svg.addEventListener('pointerup', endDrag);
        svg.addEventListener('pointercancel', endDrag);

        modal.addEventListener('click', e => {
            const act = e.target.dataset && e.target.dataset.act;
            if (e.target === modal || act === 'close') closeModal();
            else if (act === 'in') zoom(1.5);
            else if (act === 'out') zoom(1 / 1.5);
            else if (act === 'reset') setVb({ ...svg._base });
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
    }

    async function openModal() {
        if (!modal) buildModal();
        const level = state.unit;
        const svg = modal.querySelector('svg');
        const loading = modal.querySelector('.ex-map-loading');
        modal.querySelector('.ex-modal-title').textContent = `迷霧地圖・${UNIT_LABEL[level]}`;
        modal.querySelector('.ex-tip').hidden = true;
        modal.hidden = false;
        document.body.classList.add('ex-modal-open');
        if (svg._level === level && svg._data === state.data) return; // 已畫過同一層級與資料，保留縮放位置
        svg.innerHTML = '';
        modal.querySelector('.ex-modal-legend').innerHTML = '';
        loading.hidden = false;
        loading.textContent = level === 'village' ? '載入村里地圖中（約 240 KB）…' : '載入地圖中…';
        let m;
        try {
            m = await getMap(level);
        } catch (e) {
            loading.textContent = '❌ 地圖載入失敗';
            return;
        }
        loading.hidden = true;
        const [y0, y1] = drawMap(svg, m, level);
        svg._data = state.data;
        const [x, y, w, h] = m.viewBox.split(' ').map(Number);
        svg._base = { x, y, w, h };
        svg._vb = { ...svg._base };
        modal.querySelector('.ex-modal-legend').innerHTML = legendHtml(y0, y1);
    }

    function closeModal() {
        modal.hidden = true;
        document.body.classList.remove('ex-modal-open');
    }

    function bindInlineMap() {
        const wrap = root.querySelector('#ex-mapwrap');
        bindHover(root.querySelector('#ex-map'), root.querySelector('#ex-tip'), wrap);
        wrap.addEventListener('click', openModal);
        wrap.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(); } });
    }

    // ---------- 成就徽章 ----------

    // 等級色、分類色是資料色（深淺主題相同）
    const TIER_COLOR = { bronze: '#c27c4e', silver: '#8e9aa8', gold: '#e0a526', platinum: '#3fa7c2', legend: '#8b5cf6' };
    const NO_TIER_COLOR = '#0284c7';   // 不分等級的卡片（鐵道）徽章色，同鐵道分類標題色
    const ICONS = {
        pin: 'M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z',
        flag: 'M5 3h2v18H5zM8 4h11l-2.5 4.5L19 13H8z',
        home: 'M12 3 2 12h3v8h5v-5h4v5h5v-8h3z',
        compass: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6zM16.5 7.5l-6 3-3 6 6-3z',
        crown: 'M3 18h18v2.5H3zM3 7l5 4.5L12 5l4 6.5L21 7l-2 9.5H5z',
        city: 'M3 21V10h5V4h8v7h5v10zm7-14v2h2V7zm0 4v2h2v-2zm0 4v2h2v-2zM5 12v2h2v-2zm0 4v2h2v-2zm12-3v2h2v-2zm0 4v2h2v-2z',
        island: 'M2 19.5c2 0 2-1.3 4-1.3s2 1.3 4 1.3 2-1.3 4-1.3 2 1.3 4 1.3 2-1.3 4-1.3V21c-2 0-2 1.3-4 1.3s-2-1.3-4-1.3-2 1.3-4 1.3-2-1.3-4-1.3-2 1.3-4 1.3zM11 17V9.5C9 9 7 9.6 5.5 11c.5-2.6 3-4.4 5.8-3.8C10.6 5.2 8.7 4 6.5 4c2.5-1.3 5.5-.4 6.6 2 1.4-1.6 4-2 6-.7-2 0-3.6.9-4.4 2.3 2.3-.2 4.4 1.2 5 3.4-1.5-1.2-3.4-1.6-5.2-1.2L13 17z',
        lighthouse: 'M10 1.5h4V4h-4zM9 5h6l.6 4H8.4zM8.2 10.5h7.6L17 21H7zM3 5.5l4 1.5-4 1.5zM21 5.5 17 7l4 1.5z',
        star: 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7.1L12 17.3 5.8 21l1.6-7.1L2 9.2l7.1-.6z',
        car: 'M5 11l2-5.5h10l2 5.5h1.5v6H19v2.5h-3V17H8v2.5H5V17H3.5v-6zm2.6 0h8.8l-1.2-3.5H8.8zM7 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
        calendar: 'M6.5 2h2v2.5h7V2h2v2.5H21V21H3V4.5h3.5zM5 9v10h14V9zm2 2h3v3H7z',
        heart: 'M12 21s-8.5-5.6-8.5-11.4A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.6C20.5 15.4 12 21 12 21z',
        mountain: 'M1.5 20 9 7l3.6 6.2L15 9.5 22.5 20zM9 10.8 6.6 15l1.6-.8 1 .9 1.2-1z',
        train: 'M7 2h10a3 3 0 0 1 3 3v10a3 3 0 0 1-2.2 2.9L20 21h-2.6l-2-3H8.6l-2 3H4l2.2-3.1A3 3 0 0 1 4 15V5a3 3 0 0 1 3-3zM6.5 5.5v5h11v-5zM8 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
        sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3.5h-2zm0 18.5h2V23h-2zM1 11h3.5v2H1zm18.5 0H23v2h-3.5zM4.2 5.6l1.4-1.4 2.5 2.5-1.4 1.4zm11.7 11.7 1.4-1.4 2.5 2.5-1.4 1.4zM4.2 18.4l2.5-2.5 1.4 1.4-2.5 2.5zM15.9 6.7l2.5-2.5 1.4 1.4-2.5 2.5z',
        camera: 'M9 3.5h6L16.6 6H21v14H3V6h4.4zM12 8.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
        ghost: 'M12 2a7 7 0 0 0-7 7v13l2.33-2 2.34 2L12 20l2.33 2 2.34-2L19 22V9a7 7 0 0 0-7-7zM9.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
        leaf: 'M20.5 3.5C11 3 4.5 7.5 4.5 14c0 1.6.4 3 1.1 4.2L3 20.8 4.2 22l2.6-2.6c1.2.7 2.6 1.1 4.2 1.1 6.5 0 11-6.5 9.5-17zM8.5 17.5l7-7-1.2-1.2-7 7z',
    };
    // 外框形狀依類別：里程碑圓形、制霸盾形、地點類（極點、離島、景點）六角形、旅行圓角方形
    const HEX = (f, s) => `<path d="M40 4 71 22v36L40 76 9 58V22z" style="fill:${s}"/><path d="M40 11 65 25.5v29L40 69 15 54.5v-29z" style="fill:${f}"/>`;
    const SHAPES = {
        milestone: (f, s) => `<circle cx="40" cy="40" r="35" style="fill:${s}"/><circle cx="40" cy="40" r="29" style="fill:${f}"/>`,
        conquer: (f, s) => `<path d="M40 4 70 14v24c0 19-13 32-30 38C23 70 10 57 10 38V14z" style="fill:${s}"/><path d="M40 10 64 18v20c0 15-10 26-24 31C26 64 16 53 16 38V18z" style="fill:${f}"/>`,
        pole: HEX, island: HEX, landmark: HEX, bspot: HEX, peak: HEX, rail: HEX, metro: HEX, lrt: HEX, nature: HEX,
        travel: (f, s) => `<rect x="6" y="6" width="68" height="68" rx="18" style="fill:${s}"/><rect x="12" y="12" width="56" height="56" rx="14" style="fill:${f}"/>`,
    };

    function badgeSvg(a) {
        // 未達成用主題色（CSS 變數，SVG 以 style 套用才吃得到 var()）
        const color = a.done ? (TIER_COLOR[a.tier] || NO_TIER_COLOR) : 'var(--c-badge-off)';
        const ring = a.done ? shade(color, -0.18) : 'var(--c-badge-off-ring)';
        const icon = ICONS[a.icon] || ICONS.star;
        return `<svg viewBox="0 0 80 80" class="ex-badge-svg" aria-hidden="true">
            ${(SHAPES[a.group] || HEX)(color, ring)}
            <g transform="translate(24 24) scale(1.333)"><path d="${icon}" fill="#fff" fill-rule="evenodd" opacity="${a.done ? 1 : 0.85}"/></g>
        </svg>`;
    }

    function shade(hex, amt) {
        const n = parseInt(hex.slice(1), 16);
        const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * (1 + amt))));
        return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
    }

    /** 各大類的進度（登山、鐵道以格子計，其餘以成就數計） */
    function groupProgress(list, g) {
        const items = list.filter(a => a.group === g);
        if (!items.length) return null;
        const ps = POINT_STAMPS[g];
        if (ps) {
            const cells = items.flatMap(a => a.cells || []);
            return { done: cells.filter(x => x.done).length, total: cells.length, unit: ps.unit };
        }
        return { done: items.filter(a => a.done).length, total: items.length, unit: null };
    }

    // 成就徽章摺疊時的總覽：每個大類一個進度環
    function renderAchOverview(list) {
        const r = 30, c = 2 * Math.PI * r;
        const ov = root.querySelector('#ex-ach-overview');
        ov.innerHTML = Object.keys(GROUP_LABEL).map(g => {
            const p = groupProgress(list, g);
            if (!p) return '';
            const { done, total, unit } = p;
            const ratio = total ? done / total : 0;
            return `<span class="ex-ach-ring" data-group="${g}" title="${GROUP_LABEL[g]}：${done} / ${total}${unit ? ' ' + unit : ''}（點擊展開到這一類）">
                <svg viewBox="0 0 80 80">
                    <circle cx="40" cy="40" r="${r}" class="ex-donut-bg"/>
                    <circle cx="40" cy="40" r="${r}" class="ex-donut-fg" stroke-dasharray="${(c * ratio).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 40 40)"/>
                    <text x="40" y="45" class="ex-ach-ring-pct">${Math.round(ratio * 100)}%</text>
                </svg>
                <span class="ex-ach-ring-text"><b>${GROUP_LABEL[g]}</b>
                    <span>${done} / ${total}${unit ? ' ' + unit : ''}</span>
                    ${done >= total ? '<small class="full">✓ 全部達成</small>' : `<small>還差 ${total - done} ${unit || '個'}</small>`}</span></span>`;
        }).join('');

        // 點某一類的卡片：展開成就區並捲到那一類（點卡片以外的標題列照常展開到最上面）
        if (!ov._bound) {
            ov._bound = true;
            ov.addEventListener('click', e => {
                const ring = e.target.closest('.ex-ach-ring[data-group]');
                if (!ring) return;
                e.preventDefault();   // 不讓 <summary> 自己切換，改由這裡打開
                jumpToGroup(ring.dataset.group);
            });
        }
    }

    /** 展開成就區並捲到某一類（目錄與總覽共用） */
    function jumpToGroup(g) {
        const sec = root.querySelector('#ex-badges-sec');
        sec.open = true;
        const group = root.querySelector(`#ach-${g}`);
        if (!group) return;
        group.open = true;
        // 等展開後的版面更新再捲動；距離常有上萬像素，平滑捲動途中版面高度一變就會停錯位置，所以直接跳過去，再閃一下標示
        setTimeout(() => {
            group.scrollIntoView({ block: 'start' });
            group.classList.remove('ex-flash');
            void group.offsetWidth;
            group.classList.add('ex-flash');
        }, 0);
    }

    function renderBadges() {
        const list = state.data.achievements;
        const done = list.filter(a => a.done).length;
        root.querySelector('#ex-badge-count').textContent = `已達成 ${done} / ${list.length}`;
        renderAchOverview(list);
        const groups = Object.keys(GROUP_LABEL);
        // 每個類別一段（可收合）：大標題＋達成數；有分區（section）的再分小標題；
        // 縣市制霸集點卡單獨一整列，其餘徽章置中排列；鐵道三類的路線制霸徽章放在集點卡上方
        const box = root.querySelector('#ex-badges');
        box.innerHTML = groups.map(g => {
            const items = list.filter(a => a.group === g);
            if (!items.length) return '';
            const stamps = items.filter(a => a.cells), cards = items.filter(a => !a.cells);
            const sections = [...new Set(cards.map(a => a.section || ''))];
            const card = COMPACT_GROUPS.has(g) ? a => badgeCard(a, true) : a => badgeCard(a);
            const grids = sections.map(s => {
                const sc = cards.filter(a => (a.section || '') === s);
                return `${s ? `<div class="ex-badge-sub">${esc(s)}<span>${sc.filter(a => a.done).length} / ${sc.length}</span></div>` : ''}
                    <div class="ex-badge-grid${COMPACT_GROUPS.has(g) ? ' compact' : ''}">${sc.map(card).join('')}</div>`;
            }).join('');
            return `<details class="ex-badge-group" id="ach-${g}" open>
                <summary class="ex-badge-group-title g-${g}">${GROUP_LABEL[g]}
                    <span>${items.filter(a => a.done).length} / ${items.length}</span></summary>
                ${POINT_STAMPS[g] && g !== 'peak' ? grids + stampGroups(stamps) : stampGroups(stamps) + grids}</details>`;
        }).join('');
        if (!box._bound) {
            box._bound = true;
            const open = e => {
                const el = e.target.closest('.ex-badge[data-id]');
                // 集點卡上點某個格子：地圖以那個點為中心
                const cell = e.target.closest('.ex-stamp-cell[data-lat]');
                if (el) openDetail(el.dataset.id, cell ? [+cell.dataset.lat, +cell.dataset.lng] : null);
            };
            box.addEventListener('click', open);
            box.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
        }
    }

    // 集點卡依分區（section）加小標題（鐵道：臺鐵／阿里山林業鐵路／高鐵／捷運），標題右側是格子達成數
    function stampGroups(stamps) {
        const sections = [...new Set(stamps.map(a => a.section || ''))];
        return sections.map(s => {
            const sc = stamps.filter(a => (a.section || '') === s);
            if (!s) return sc.map(conquerCard).join('');
            const cells = sc.flatMap(a => a.cells);
            const unit = POINT_STAMPS[sc[0].group]?.unit || '格';
            // 有站級的（臺鐵）加圖例：格子顏色依站級反過來，大站銅、小站金
            const legend = cells.some(c => c.tier) ? `<small class="ex-grade-legend">格子顏色：<i class="g-bronze"></i>特等／一等站
                <i class="g-silver"></i>二等站 <i class="g-gold"></i>三等／簡易／招呼站</small>` : '';
            return `<div class="ex-badge-sub">${esc(s)}<span>${cells.filter(c => c.done).length} / ${cells.length} ${unit}</span>${legend}</div>
                ${sc.map(conquerCard).join('')}`;
        }).join('');
    }

    function progressText(a) {
        const p = Number.isInteger(a.progress) ? a.progress.toLocaleString() : a.progress;
        return `${p} / ${a.target.toLocaleString()}`;
    }

    // compact：地點類小卡片（沒有進度條，只顯示已造訪／未造訪）
    function badgeCard(a, compact) {
        const pct = Math.min(100, a.progress / a.target * 100);
        // 有明細的卡片可點開：旅行類、已達成的，以及地點類（未造訪也能看小地圖上的位置）
        const place = PLACE_GROUPS.has(a.group);
        // 鐵道的路線制霸未達成也能點開（看該線哪些站還沒到）
        const clickable = a.detail && (a.group === 'travel' || a.done || place || !!POINT_STAMPS[a.group]);
        const status = compact
            ? (a.done ? `<div class="ex-badge-date">🗓 ${a.date ? fmtDate(a.date) : '時間不明'}</div>` : '<div class="ex-badge-prog"><span>尚未造訪</span></div>')
            : a.done
                ? `<div class="ex-badge-date">🗓 ${a.date ? fmtDate(a.date) + ' 達成' : '已達成（時間不明）'}</div>`
                : `<div class="ex-badge-prog"><div class="ex-bar"><div class="ex-bar-fill" style="width:${pct.toFixed(1)}%"></div></div><span>${progressText(a)}</span></div>`;
        return `<div class="ex-badge${a.done ? ' done' : ''}${compact ? ' compact' : ''}${clickable ? ' clickable' : ''}"
            ${clickable ? `data-id="${esc(a.id)}" role="button" tabindex="0"` : ''}
            title="${esc(a.desc)}${a.note ? '\n' + esc(a.note) : ''}${clickable ? '\n（點擊看明細）' : ''}">
            ${badgeSvg(a)}
            <div class="ex-badge-name">${esc(a.name)}${a.tier ? `<span class="ex-tier t-${a.tier}">${TIER_LABEL[a.tier]}</span>` : ''}</div>
            <div class="ex-badge-desc">${esc(a.desc)}</div>
            ${status}
            ${a.note && !compact ? `<div class="ex-badge-note">${esc(a.note)}</div>` : ''}
            ${clickable ? `<div class="ex-badge-more">${place && !a.done ? '🗺 看地點' : '📋 看明細'}</div>` : ''}
        </div>`;
    }

    // ---------- 成就明細彈窗（旅行：達成的日子／年份；地點：每次造訪） ----------

    let dmodal = null;
    const detailCache = new Map();

    function buildDetailModal() {
        dmodal = document.createElement('div');
        dmodal.className = 'ex-modal ex-dmodal';
        dmodal.hidden = true;
        dmodal.innerHTML = `
            <div class="ex-modal-box ex-dmodal-box" role="dialog" aria-modal="true" aria-labelledby="ex-dmodal-title">
                <div class="ex-modal-head">
                    <span id="ex-dmodal-title" class="ex-modal-title"></span>
                    <span class="ex-modal-hint ex-dmodal-desc"></span>
                    <span class="ex-modal-tools">
                        <span class="ex-seg ex-dmodal-sort">
                            <button type="button" data-sort="date">依日期</button>
                            <button type="button" data-sort="value">依數量</button>
                        </span>
                        <button type="button" data-act="close" class="ex-modal-x" title="關閉（Esc）">✕</button>
                    </span>
                </div>
                <div class="ex-dmodal-note"></div>
                <div class="ex-dmap" hidden></div>
                <div class="ex-dmodal-body"></div>
            </div>`;
        document.body.appendChild(dmodal);
        dmodal.addEventListener('click', e => {
            const t = e.target;
            if (t === dmodal || t.dataset.act === 'close') closeDetail();
            else if (t.dataset.sort && dmodal._data) { dmodal._sort = t.dataset.sort; drawDetail(); }
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dmodal.hidden) closeDetail(); });
    }

    async function openDetail(id, focus = null) {
        if (!dmodal) buildDetailModal();
        const a = state.data.achievements.find(x => x.id === id);
        dmodal.querySelector('.ex-modal-title').textContent = `📋 ${a ? a.name : ''}`;
        dmodal.querySelector('.ex-dmodal-desc').textContent = a ? a.desc : '';
        dmodal.querySelector('.ex-dmodal-note').textContent = '';
        dmodal.querySelector('.ex-dmodal-body').innerHTML = '<div class="ex-empty">計算明細中…</div>';
        dmodal.querySelectorAll('.ex-dmodal-sort button').forEach(b => b.classList.remove('active'));
        dmodal._data = null;
        dmodal._id = id;
        dmodal.querySelector('.ex-dmap').hidden = true;
        dmodal.hidden = false;
        document.body.classList.add('ex-modal-open');
        let d = detailCache.get(id);
        if (!d) {
            try {
                d = await loadDetail(id);
            } catch (e) {
                d = { ok: false, error: '明細計算失敗' };
            }
            if (d.ok) detailCache.set(id, d);
        }
        if (dmodal._id !== id) return; // 計算期間又點了別張
        if (!d.ok) { dmodal.querySelector('.ex-dmodal-body').innerHTML = `<div class="ex-empty">❌ ${esc(d.error || '計算失敗')}</div>`; return; }
        dmodal._data = d;
        dmodal._sort = d.sort || 'date';
        drawDetail();
        drawDetailMap(d.geo, focus);
    }

    function drawDetail() {
        const d = dmodal._data, key = dmodal._sort;
        dmodal.querySelectorAll('.ex-dmodal-sort button').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
        // 依數量排序只對旅行類有意義（單日縣市數、單年村里數、照片數）
        dmodal.querySelector('.ex-dmodal-sort').hidden = !['road_trip', 'multi_town', 'annual', 'regular'].includes(d.id);
        dmodal.querySelector('.ex-dmodal-note').textContent = d.note || `${d.rows.length} 筆`;
        const rows = [...d.rows].sort((x, y) => y[key] - x[key] || y.date - x.date);
        const body = dmodal.querySelector('.ex-dmodal-body');
        body.classList.toggle('name-first', d.id === 'regular' || isPointDetail(d.id)); // 第一欄是較長的名稱（村里、山名、站名）
        body.classList.toggle('two-col', d.columns.length === 2);
        const ps = Object.values(POINT_STAMPS).find(p => d.id.startsWith(p.prefix));
        if (!rows.length) { body.innerHTML = `<div class="ex-empty">${ps ? `還沒有${ps.verb}任何一${ps.unit}` : d.geo ? '還沒有在這裡的足跡' : '沒有資料'}</div>`; return; }
        const head = `<div class="ex-drow ex-dhead">${d.columns.map(c => `<span>${esc(c)}</span>`).join('')}</div>`;
        body.innerHTML = head + rows.map(r => {
            const cells = r.cells.map(c => `<span>${esc(c)}</span>`).join('');
            if (!r.items || !r.items.length) return `<div class="ex-drow${r.hit ? '' : ' miss'}">${cells}</div>`;
            return `<details class="ex-dfold${r.hit ? '' : ' miss'}"><summary class="ex-drow">${cells}</summary>
                <div class="ex-ditems"><small>${esc(r.items_label || '')}</small>
                ${r.items.map(x => `<span class="ex-chip on">${esc(x)}</span>`).join('')}</div></details>`;
        }).join('');
        body.scrollTop = 0;
    }

    // 地點類成就的小地圖：地點範圍（圓圈或界線）＋在此的紀錄位置（最多 500 筆）
    let dmap = null, dmapLayer = null;
    // focus：[緯度, 經度]，有的話以該點為中心、縮放到 FOCUS_ZOOM，並打開該點的提示
    const FOCUS_ZOOM = 10;
    function drawDetailMap(geo, focus = null) {
        const box = dmodal.querySelector('.ex-dmap');
        const L = window.L;
        if (!geo || !L) { box.hidden = true; return; }
        box.hidden = false;
        if (!dmap) {
            dmap = L.map(box, { preferCanvas: true, scrollWheelZoom: true, attributionControl: true });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19, attribution: '&copy; OpenStreetMap', className: 'tiles-osm',   // 深色模式反相
            }).addTo(dmap);
            dmapLayer = L.layerGroup().addTo(dmap);
        }
        dmapLayer.clearLayers();
        const style = { color: '#ff4d1a', weight: 2, fillColor: '#ff4d1a', fillOpacity: 0.12 };
        let bounds = null, focusMarker = null;
        const extend = b => { bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast()); };
        (geo.points || []).forEach(([lat, lng]) => {
            L.circle([lat, lng], { ...style, radius: geo.radius }).addTo(dmapLayer);
            L.circleMarker([lat, lng], { radius: 3, color: '#ff4d1a', weight: 2, fillOpacity: 1 }).addTo(dmapLayer);
            extend(L.latLng(lat, lng).toBounds(geo.radius * 2));
        });
        if (geo.shape) {
            const g = L.geoJSON(geo.shape, { style }).addTo(dmapLayer);
            extend(g.getBounds());
        }
        // 集點卡（百岳、鐵道）：每個點一個標記，已達成紅色、未達成灰色，滑鼠移上顯示名稱
        if (geo.marks && geo.marks.length) {
            const pts = [];
            const ps = Object.values(POINT_STAMPS).find(p => dmodal._id && dmodal._id.startsWith(p.prefix));
            [...geo.marks].sort((x, y) => x[3] - y[3]).forEach(([lat, lng, label, done]) => {
                const isFocus = focus && Math.abs(focus[0] - lat) < 1e-6 && Math.abs(focus[1] - lng) < 1e-6;
                const mk = L.circleMarker([lat, lng], isFocus
                    ? { radius: 9, color: themeColor('--c-text-strong'), weight: 2.5, fillColor: done ? '#ff4d1a' : '#9ca3af', fillOpacity: 1 }
                    : done
                    ? { radius: 6, color: '#fff', weight: 1.5, fillColor: '#ff4d1a', fillOpacity: 1 }
                    : { radius: 4, color: '#6b7280', weight: 1, fillColor: '#9ca3af', fillOpacity: 0.7 })
                    .bindTooltip(`${esc(label)}${done ? `（已${ps ? ps.verb : '達成'}）` : ''}`).addTo(dmapLayer);
                if (isFocus) focusMarker = mk;
                // 對焦以本島與澎湖為準（金門、馬祖在更西邊，會把地圖拉得太遠；點位仍有畫出）
                if (lng >= 119.3) pts.push([lat, lng]);
            });
            if (pts.length) extend(L.latLngBounds(pts));
        }
        (geo.photos || []).forEach(p => {
            L.circleMarker(p, { radius: 4, color: '#fff', weight: 1, fillColor: '#2563eb', fillOpacity: 0.9 }).addTo(dmapLayer);
        });
        // 彈窗剛顯示時容器大小才確定，先更新尺寸再對焦
        dmap.invalidateSize();
        if (focus) {
            dmap.setView(focus, FOCUS_ZOOM);
            if (focusMarker) { focusMarker.bringToFront(); focusMarker.openTooltip(); }
        } else if (bounds) dmap.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
    }

    function closeDetail() {
        dmodal.hidden = true;
        dmodal._id = null;
        // 地圖彈窗沒開著才解除捲動鎖定
        if (!modal || modal.hidden) document.body.classList.remove('ex-modal-open');
    }

    // 捷運、輕軌格子的路線色：一條線單色、兩條線（轉乘站）斜線雙色、三條以上灰色
    function lineStyle(c) {
        if (!c.colors) return '';
        const [c1, c2] = c.colors.length > 2 ? ['#8e9aa8', '#8e9aa8'] : [c.colors[0], c.colors[1] || c.colors[0]];
        return ` style="--lc1:${c1};--lc2:${c2}"`;
    }

    // 集點卡：縣市制霸（依進度排序）；百岳、小百岳、鐵道各線車站（依編號／行車順序，點卡片看明細與地圖）
    function conquerCard(a) {
        const ps = POINT_STAMPS[a.group], peak = !!ps;
        const cells = peak ? a.cells : [...a.cells].sort((x, y) => (y.done - x.done) || (y.progress / y.target - x.progress / x.target));
        const cellHtml = c => peak
            ? `<span class="ex-stamp-cell${c.done ? ' on' : ''}${c.tier ? ' g-' + c.tier : ''}${c.colors ? ' lined' : ''}"${lineStyle(c)} data-lat="${c.lat}" data-lng="${c.lng}" title="${c.ele != null ? `#${c.code} ${esc(c.name)}（${Number(c.ele).toLocaleString()} m）` : esc(c.name) + (c.grade ? `（${c.grade}站）` : '') + (c.lines ? `（${c.lines.join('、')}）` : '')}：${c.done ? (c.date ? fmtDate(c.date) + ' ' + ps.verb : `已${ps.verb}（時間不明）`) : '尚未' + ps.verb}">
                <b>${esc(c.name)}</b><small>${c.done ? '✓' : '#' + c.code}</small></span>`
            : `<span class="ex-stamp-cell${c.done ? ' on' : ''}"
                title="${esc(c.name)}：${c.done ? fmtDate(c.date) + ' 制霸' : `${c.progress} / ${c.target} 鄉鎮`}">
                <b>${esc(c.name)}</b><small>${c.done ? '✓' : `${c.progress}/${c.target}`}</small></span>`;
        return `<div class="ex-badge ex-stamp${a.done ? ' done' : ''}${peak ? ' ex-stamp-peak clickable' : ''}"${peak ? ` data-id="${esc(a.id)}" role="button" tabindex="0" title="點擊看已${ps.verb}的${a.group === 'peak' ? '山' : '車站'}與地圖"` : ''}>
            <div class="ex-stamp-head">${badgeSvg({ ...a, done: a.progress > 0 })}
                <div><div class="ex-badge-name">${esc(a.name)}${a.tier ? `<span class="ex-tier t-${a.tier}">${TIER_LABEL[a.tier]}</span>` : ''}</div>
                <div class="ex-badge-desc">${esc(a.desc)}</div>
                <div class="ex-badge-prog"><span>${peak ? '已' + ps.verb : '已制霸'} ${progressText(a)}</span></div>
                ${peak ? '<div class="ex-badge-more">📋 看明細與地圖</div>' : ''}</div>
            </div>
            <div class="ex-stamp-grid">${cells.map(cellHtml).join('')}</div>
        </div>`;
    }

    // 切換主題：累積線、明細地圖標記用到主題色，重畫
    document.addEventListener('themechange', () => {
        if (!state.data) return;
        renderYearly();
        if (dmodal && !dmodal.hidden && dmodal._data) drawDetailMap(dmodal._data.geo);
    });

    return {
        /** 放入（或更新）計算結果 */
        setData(stats) {
            state.data = stats;
            state.idx = buildIndex(stats);
            detailCache.clear();
            if (!built) { render(); built = true; }
            renderBadges();
            update();
            if (modal && !modal.hidden) openModal();
            if (dmodal && !dmodal.hidden) closeDetail();
        },
        jumpToGroup,
        /** 各大類的進度（給目錄用） */
        groups() {
            if (!state.data) return [];
            return Object.keys(GROUP_LABEL).map(g => ({ g, label: GROUP_LABEL[g], ...groupProgress(state.data.achievements, g) }))
                .filter(x => x.total !== undefined);
        },
    };
}
