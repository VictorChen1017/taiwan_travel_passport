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

import { TIER_LABEL, ICONS, shapeOf, badgeColors, EARLY_YEAR, yearColor, PLAY_NOW_COLOR, PLAY_PAST_COLOR, CONQUER_LEVELS, conquerColor } from './shared.js';
import { TILE } from './tiles.js';
import { TOUCH, canShareFile } from './device.js';
import { videoSupport, makeVideo } from './video.js';
import { loadNickname, saveNickname, NICK_SAMPLE } from './report.js';
import { sceneSvg, sceneEmoji, stampTilt } from './scenes.js';

export const GROUP_LABEL = { milestone: '里程碑', conquer: '制霸', pole: '極點', island: '離島', landmark: '景點', bspot: 'B 級景點', peak: '登山', rail: '臺鐵・高鐵', metro: '捷運', lrt: '輕軌', nature: '國家公園與保護區', festival: '節慶與民俗活動', travel: '旅行' };
// 隱藏類別：一個都還沒達成時不出現（成就目錄、總覽也不列）
export const HIDDEN_GROUPS = new Set(['festival']);
const UNIT_LABEL = { county: '縣市', town: '鄉鎮', village: '村里' };
const PLACE_GROUPS = new Set(['pole', 'island', 'landmark', 'bspot', 'nature']);   // 有小地圖的地點類
const COMPACT_GROUPS = new Set(['island', 'landmark', 'bspot', 'nature']);   // 數量多的類別用小卡片
// 以座標格子計的集點卡（百岳、鐵道車站）：單位與「達成」的說法；明細 id 前綴
const STATION_STAMP = { unit: '站', verb: '到站', prefix: 'rail_' };
export const POINT_STAMPS = { peak: { unit: '座', verb: '登頂', prefix: 'peaks_' }, rail: STATION_STAMP, metro: STATION_STAMP, lrt: STATION_STAMP };
// 迷霧地圖彈窗：地區切換。座標是 data/map_*.json 的 SVG 座標：x＝經度 × MAP_KX、y＝－緯度（tools/export_static.php）
const MAP_KX = 0.9135;
const REGIONS = {
    main: { label: '本島', box: [119.25, 21.85, 122.1, 25.4] },   // [西經, 南緯, 東經, 北緯]；含澎湖、綠島、蘭嶼
    kinmen: { label: '金門', box: [118.1, 24.33, 118.55, 24.58] },
    matsu: { label: '馬祖', box: [119.85, 25.9, 120.55, 26.44] },
    all: { label: '全部', box: null },
};
const DEFAULT_REGION = 'main';
// 放大地圖的河川圖層開關（localStorage；只是顯示偏好，預設關，打開過才是 '1'）
const WATER_KEY = 'fog-map-water';
const waterOn = () => { try { return localStorage.getItem(WATER_KEY) === '1'; } catch (e) { return false; } };
const regionBox = ([w, s, e, n]) => ({ x: w * MAP_KX, y: -n, w: (e - w) * MAP_KX, h: n - s });
// 放大上限（視窗最窄幾個地圖單位）：縣市、鄉鎮 0.15（約 16 公里寬，一個鄉鎮大致佔滿手機畫面）；
// 村里再多四級（按鈕一級 1.5 倍 → ÷ 1.5⁴ ≈ 5.1，約 3 公里寬），方便手指點小村里（2026-11-26 維護者要求，先兩級、再逐次各加一級）。
// 村里界簡化容許值約 180 公尺，放到最大時直線感較明顯，但整層一起簡化、不會有縫
const MIN_VIEW_W = { county: 0.15, town: 0.15, village: 0.15 / 1.5 ** 4 };
const isPointDetail = id => Object.values(POINT_STAMPS).some(p => id.startsWith(p.prefix));

const pad = n => String(n).padStart(2, '0');
// 紀錄的 time 是「當地時鐘時間當成 UTC」，一律用 getUTC*
const fmtDate = t => { if (!t) return '—'; const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const fmtInt = n => Math.round(n).toLocaleString();
const fmtPct = r => (r * 100).toFixed(r < 0.1 ? 2 : 1) + '%';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const themeColor = name => window.photoTheme ? window.photoTheme.color(name) : '';

export function createExplore(root, { loadMap, loadDetail, manual: manualApi = null }) {
    // color：地圖上色 year＝首次解鎖年份、count＝制霸五色（照片張數；只在照片模式的鄉鎮、村里）
    const state = { unit: 'town', metric: 'count', color: 'year', data: null, maps: {}, idx: null };
    // 計算結果要有張數 n（瀏覽器若還在用舊版 compute.js 會沒有，這時不提供五色，避免區域沒填色而畫成黑色）
    const canConquer = level => state.data?.mode === 'photo' && level !== 'county' && state.data.towns.some(t => t.n !== undefined);
    const useConquer = level => state.color === 'count' && canConquer(level);
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
            <div class="ex-start" id="ex-start" hidden>
                <div class="ex-start-text"><b>👋 還沒有任何足跡</b>
                    沒有照片或時間軸也沒關係：點下方的成就徽章或集點卡，按「<b>我有去過，手動加入！</b>」或「<b>＋ 我去過</b>」，就能記下去過的地方。</div>
                <button type="button" class="ex-start-btn" id="ex-start-go">看全部成就 ↓</button>
            </div>
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
                    <div id="ex-legend" class="ex-legend"></div>
                    <div class="ex-mapwrap" id="ex-mapwrap" role="button" tabindex="0" aria-label="點擊放大迷霧地圖">
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
                </div>
                <div class="ex-card ex-progress ex-card-link" id="ex-progress-card" role="button" tabindex="0" aria-label="探索率，點擊看明細">
                    <div class="ex-card-title">探索率 <small>點擊看明細 ›</small></div>
                    <div id="ex-donut" class="ex-donut"></div>
                    <div id="ex-progress-sub" class="ex-progress-sub"></div>
                </div>
                <div class="ex-card ex-recent ex-card-link" id="ex-recent-card" role="button" tabindex="0" aria-label="最近解鎖，點擊看完整解鎖順序">
                    <div class="ex-card-title">最近解鎖 <small id="ex-recent-more">點擊看完整順序 ›</small></div>
                    <ol id="ex-recent" class="ex-recent-list"></ol>
                </div>
                <div class="ex-card ex-yearly ex-card-link" id="ex-yearly-card" role="button" tabindex="0" aria-label="每年新解鎖，點擊看足跡擴張的動畫">
                    <div class="ex-card-title"><span id="ex-yearly-title">每年新解鎖</span> <small>點擊看今年的地圖動畫，點長條看那一年 ›</small></div>
                    <div id="ex-yearly" class="ex-yearly-chart"></div>
                </div>
            </div>
            <details class="ex-section" id="ex-detail-sec">
                <summary><span class="ex-section-title">📋 <span id="ex-detail-title">明細</span></span>
                    <span class="ex-section-hint">點擊展開</span></summary>
                <div id="ex-detail" class="ex-detail"></div>
                <div id="ex-dtip" class="ex-tip" hidden></div>
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
        root.querySelector('#ex-start-go').addEventListener('click', showBadgeOverview);
        // 探索率 → 捲到下方明細並展開（村里明細很長，不放彈窗）
        // 最近解鎖 → 完整解鎖順序彈窗；整張卡片可點（鍵盤 Enter／空白鍵也可）
        const cardLink = (id, fn) => {
            const card = root.querySelector(id);
            card.addEventListener('click', fn);
            card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
        };
        cardLink('#ex-progress-card', () => {
            const sec = root.querySelector('#ex-detail-sec');
            sec.open = true;
            sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        });
        cardLink('#ex-recent-card', openOrder);
        // 每年新解鎖：點長條 → 放大地圖播放動畫（村里單位用村里，其他用鄉鎮）停在那一年；點卡片其他地方 → 停在今年（資料沒到今年就停在最後一年）
        cardLink('#ex-yearly-card', e => {
            const col = e && e.target.closest && e.target.closest('.ex-ychart-col');
            const at = col ? (col.dataset.k === 'early' ? 'early' : +col.dataset.k) : new Date().getFullYear();
            openModal(false, { level: state.unit === 'village' ? 'village' : 'town', playAt: at });   // 縣市沒有動畫，改用鄉鎮
        });
        bindDetailTip();
        let rt = null;
        window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.data && renderYearly(), 150); });
        bindInlineMap();
        bindColorSwitch(root.querySelector('#ex-legend'));
    }

    function update() {
        // 什麼都還沒解鎖（沒有匯入、也沒有手動紀錄）：頂端提示可以手動加入
        const d = state.data;
        root.querySelector('#ex-start').hidden = d.summary.village.unlocked > 0 || d.achievements.some(a => a.done);
        root.querySelectorAll('.ex-seg').forEach(seg => {
            seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === state[seg.dataset.group]));
        });
        renderProgress();
        renderRecent();
        renderYearly();
        renderDetail();
        refreshDetailTip();
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
        const more = root.querySelector('#ex-recent-more');
        more.hidden = !items.length;
        more.textContent = `點擊看完整順序（${items.length.toLocaleString()} 個）›`;
        if (omodal && !omodal.hidden) drawOrder();
    }

    // ---------- 完整解鎖順序彈窗（最近解鎖卡片點進去；跟著縣市／鄉鎮／村里切換） ----------

    let omodal = null;

    function openOrder() {
        if (!state.data) return;
        if (!omodal) {
            omodal = document.createElement('div');
            omodal.className = 'ex-modal ex-dmodal ex-omodal';
            omodal.hidden = true;
            omodal.innerHTML = `
                <div class="ex-modal-box ex-dmodal-box" role="dialog" aria-modal="true" aria-labelledby="ex-omodal-title">
                    <div class="ex-modal-head">
                        <span id="ex-omodal-title" class="ex-modal-title"></span>
                        <span class="ex-modal-tools">
                            <button type="button" data-act="close" class="ex-modal-x" title="關閉（Esc）">✕</button>
                        </span>
                    </div>
                    <div class="ex-omodal-bar">
                        <span class="ex-seg ex-dmodal-sort" role="group" aria-label="層級">
                            <button type="button" data-unit="county">縣市</button>
                            <button type="button" data-unit="town">鄉鎮</button>
                            <button type="button" data-unit="village">村里</button>
                        </span>
                        <span class="ex-seg ex-dmodal-sort" role="group" aria-label="排序">
                            <button type="button" data-order="new">最新在上</button>
                            <button type="button" data-order="old">最早在上</button>
                        </span>
                    </div>
                    <div class="ex-dmodal-note"></div>
                    <div class="ex-dmodal-body ex-order"></div>
                </div>`;
            document.body.appendChild(omodal);
            omodal._order = 'new';
            omodal.addEventListener('click', e => {
                const t = e.target;
                if (t === omodal || t.dataset.act === 'close') closeOrder();
                else if (t.dataset.unit && t.dataset.unit !== state.unit) {
                    state.unit = t.dataset.unit;   // 和頁面上方的切換同步（update 會經 renderRecent 重畫這個彈窗）
                    update();
                    omodal.querySelector('.ex-order').scrollTop = 0;
                }
                else if (t.dataset.order && t.dataset.order !== omodal._order) {
                    omodal._order = t.dataset.order;
                    drawOrder();
                    omodal.querySelector('.ex-order').scrollTop = 0;
                }
            });
            document.addEventListener('keydown', e => { if (e.key === 'Escape' && !omodal.hidden) closeOrder(); });
        }
        omodal._order = 'new';
        drawOrder();
        omodal.hidden = false;
        document.body.classList.add('ex-modal-open');
        omodal.querySelector('.ex-order').scrollTop = 0;
        omodal.querySelector('.ex-modal-x').focus({ preventScroll: true });
    }

    function closeOrder() {
        omodal.hidden = true;
        document.body.classList.remove('ex-modal-open');
        root.querySelector('#ex-recent-card').focus({ preventScroll: true });
    }

    function drawOrder() {
        const unit = UNIT_LABEL[state.unit];
        const items = unlockedItems(state.unit).filter(x => x.first).sort((a, b) => a.first - b.first)
            .map((x, i) => ({ ...x, n: i + 1 }));
        if (omodal._order === 'new') items.reverse();
        omodal.querySelector('.ex-modal-title').textContent = `🔓 ${unit}解鎖順序`;
        omodal.querySelectorAll('[data-order]').forEach(b => b.classList.toggle('active', b.dataset.order === omodal._order));
        omodal.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('active', b.dataset.unit === state.unit));
        omodal.querySelector('.ex-dmodal-note').textContent = items.length
            ? `共 ${items.length.toLocaleString()} 個${unit}，依首次解鎖時間排列` : '';
        // 依年份分段（標題列固定在上方），每列：日期、名稱、第 N 個
        const yearOf = x => new Date(x.first * 1000).getUTCFullYear();
        const perYear = new Map();
        for (const x of items) perYear.set(yearOf(x), (perYear.get(yearOf(x)) || 0) + 1);
        let html = '', year = null;
        for (const x of items) {
            const y = yearOf(x);
            if (y !== year) {
                html += `<li class="ex-order-year">${y} 年<span>${perYear.get(y).toLocaleString()} 個</span></li>`;
                year = y;
            }
            html += `<li><span class="ex-recent-date">${fmtDate(x.first)}</span>
                <span class="ex-recent-name" title="${esc(x.name)}">${esc(x.name)}</span>
                <span class="ex-recent-n">第 ${x.n.toLocaleString()} 個</span></li>`;
        }
        omodal.querySelector('.ex-order').innerHTML = items.length
            ? `<ol class="ex-recent-list">${html}</ol>` : '<div class="ex-empty">尚無資料</div>';
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
        const labels = [], vals = [], keys = [];   // keys：點長條時要停的年份（early＝2015 前合併欄）
        if (early) { labels.push(`${EARLY_YEAR} 前`); vals.push(early); keys.push('early'); }
        for (let y = Math.max(years[0], EARLY_YEAR); y <= years[years.length - 1]; y++) { labels.push(String(y)); vals.push(byYear.get(y) || 0); keys.push(y); }
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
            ${vals.map((v, i) => `<g class="ex-ychart-col" data-k="${keys[i]}"><title>${labels[i]}：${fmtV(v)} ${unitText}（累積 ${fmtV(cum[i])}）・點擊看那一年的地圖動畫</title>
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
            title.textContent = '縣市集點卡';
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
            // 點一下開泡泡（首次解鎖日期＋手動補點，同迷霧地圖放大彈窗；bindDetailTip）
            title.textContent = '鄉鎮集點卡';
            el.innerHTML = sortedCounties.map(c => {
                const towns = d.towns.filter(t => t.county === c.code);
                const chips = towns.map(t => `<span class="ex-chip${t.unlocked ? ' on' : ''}" data-code="${esc(t.code)}"
                    role="button" tabindex="0">${esc(t.name)}</span>`).join('');
                return `<div class="ex-group">
                    <div class="ex-group-head"><b>${esc(c.name)}</b><span>${c.towns_unlocked} / ${c.towns}</span>
                        ${c.towns_unlocked === c.towns ? '<span class="ex-tag">制霸</span>' : ''}</div>
                    <div class="ex-chips">${chips}</div></div>`;
            }).join('');
            return;
        }

        // 村里：依縣市分組（可展開），每個鄉鎮一列村里進度
        title.textContent = '村里集點卡';
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

    function getMap(level) {
        if (!state.maps[level]) state.maps[level] = loadMap(level).catch(e => { delete state.maps[level]; throw e; });
        return state.maps[level];
    }

    /**
     * 把某層級的迷霧地圖畫進 svg；回傳 [y0, y1]（上色的年份範圍）
     * 區域一律畫在 canvas（paintCanvas）：村里約 8,000 個 SVG 節點在 iOS 重畫、拖曳都很慢甚至卡住，縣市、鄉鎮也統一用同一套畫法
     * svg 本身是空的，只負責接收觸控、滑鼠，並提供視窗（viewBox）給 canvas 與外框疊層
     */
    function drawMap(svg, m, level) {
        const idx = state.idx[level];
        const firsts = [...idx.values()].map(x => x.first).filter(Boolean).map(t => new Date(t * 1000).getUTCFullYear());
        const y1 = firsts.length ? Math.max(...firsts) : new Date().getUTCFullYear();
        const y0 = firsts.length ? Math.min(y1, Math.max(EARLY_YEAR, Math.min(...firsts))) : y1;
        const fills = new Map();   // 已解鎖的區域 → 顏色；沒有的是迷霧
        for (const p of m.paths) {
            const item = idx.get(p.code);
            if (!item || !(level === 'village' || item.unlocked)) continue;
            fills.set(p.code, useConquer(level) ? conquerColor(item.n || 0) || '#ffcfb5'
                : item.first ? yearColor(new Date(item.first * 1000).getUTCFullYear(), y0, y1) : '#ffcfb5');
        }
        svg._cv = { ...canvasData(m), fills, fine: level === 'village' };
        svg.innerHTML = '';
        setHl(svg, null);
        setViewBox(svg, m.viewBox);
        svg._names = new Map(m.paths.map(p => [p.code, p.name]));
        svg._paths = new Map(m.paths.map(p => [p.code, p]));
        svg._level = level;
        svg._color = useConquer(level) ? 'count' : 'year';
        return [y0, y1];
    }

    // 圖例；照片模式的鄉鎮、村里前面加上色切換（年份／制霸五色）
    const legendHtml = (y0, y1, level) => {
        const sw = canConquer(level) ? `<span class="ex-seg ex-color-seg" role="group" aria-label="地圖上色">
            <button type="button" data-color="year" class="${useConquer(level) ? '' : 'active'}">首次解鎖年份</button>
            <button type="button" data-color="count" class="${useConquer(level) ? 'active' : ''}">制霸五色</button></span>` : '';
        const fog = '<span class="ex-legend-item"><i class="sw fog"></i>未解鎖（迷霧）</span>';
        if (useConquer(level)) return sw + fog + CONQUER_LEVELS.map(l =>
            `<span class="ex-legend-item"><i class="sw lv" style="background:${l.color}"></i>${l.label}</span>`).join('');
        return sw + fog + `<span class="ex-legend-item"><i class="sw grad"></i>已解鎖：${y0} 年${y0 === EARLY_YEAR ? '前' : ''} → ${y1} 年（首次解鎖年份）</span>`;
    };

    // 點圖例的上色切換：小地圖、放大彈窗一起換（彈窗保留縮放位置）
    function bindColorSwitch(el) {
        el.addEventListener('click', e => {
            const b = e.target.closest('[data-color]');
            if (!b || b.dataset.color === state.color) return;
            state.color = b.dataset.color;
            renderMap();
            if (modal && !modal.hidden) recolorModal();
        });
    }

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
            if (svg._canvas) svg._canvas.hidden = true;
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
        root.querySelector('#ex-legend').innerHTML = legendHtml(y0, y1, level);
    }

    // ---------- 選取外框疊層、視窗 ----------
    // 滑過／選取的外框畫在疊在地圖上的另一張小 SVG（ex-map-hl）：
    // 外框不會被後畫的鄰居蓋住一半（顏色不均），也不用重畫整張大地圖（iOS 村里地圖局部重畫會漏畫成破圖）
    function hlOf(svg) {
        if (!svg._hl) {
            svg._hl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg._hl.setAttribute('class', 'ex-map-hl');
            svg._hl.setAttribute('aria-hidden', 'true');
            svg._hl.setAttribute('preserveAspectRatio', svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
            const vb = svg.getAttribute('viewBox');
            if (vb) svg._hl.setAttribute('viewBox', vb);
            (svg._canvas || svg).after(svg._hl);
        }
        return svg._hl;
    }
    function setHl(svg, el) {
        const code = el && el.dataset ? el.dataset.code : null;
        if ((svg._hlCode || null) === code) return;
        svg._hlCode = code;
        hlOf(svg).innerHTML = code ? `<path d="${el.getAttribute('d')}"/>` : '';
    }
    /** 地圖與外框疊層一起換 viewBox；村里 canvas 跟著重畫（paint=false 時不畫，等之後設定視窗再畫） */
    function setViewBox(svg, vb, paint = true) {
        svg.setAttribute('viewBox', vb);
        hlOf(svg).setAttribute('viewBox', vb);
        if (paint && svg._cv) paintCanvas(svg);
    }

    // ---------- 村里層的 canvas 繪製與點選 ----------

    // ST_AsSVG（相對座標）的路徑「M x y l dx dy … z」→ 外框範圍 [x0, y0, x1, y1]（剔除畫面外的區域、點選先篩）
    function pathBox(d) {
        const t = d.match(/[MmLlZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0, sx = 0, sy = 0, cmd = 'M';
        for (let i = 0; i < t.length;) {
            const k = t[i];
            if (/[A-Za-z]/.test(k)) { cmd = k; i++; if (k === 'z' || k === 'Z') { cx = sx; cy = sy; } continue; }
            const a = +t[i], b = +t[i + 1];
            i += 2;
            if (cmd === 'M') { cx = sx = a; cy = sy = b; cmd = 'L'; }
            else if (cmd === 'm') { cx = sx = cx + a; cy = sy = cy + b; cmd = 'l'; }
            else if (cmd === 'L') { cx = a; cy = b; }
            else { cx += a; cy += b; }
            if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        }
        return [x0, y0, x1, y1];
    }
    /** 每張地圖只準備一次：Path2D 與外框範圍 */
    function canvasData(m) {
        if (!m._cv) m._cv = {
            items: m.paths.map(p => ({ code: p.code, d: p.d, p2d: new Path2D(p.d), box: pathBox(p.d) })),
            coast: m.coast ? new Path2D(m.coast) : null,
            counties: m.counties ? new Path2D(m.counties) : null,   // 鄉鎮、村里層才有：同層簡化後依縣市聯集（和區域界線對齊）
        };
        m._cv.byCode = m._cv.byCode || new Map(m._cv.items.map(x => [x.code, x]));
        return m._cv;
    }
    function canvasOf(svg) {
        if (!svg._canvas) {
            hlOf(svg);
            svg._canvas = document.createElement('canvas');
            svg._canvas.className = 'ex-map-cv';
            svg._canvas.setAttribute('aria-hidden', 'true');
            svg.after(svg._canvas);   // 順序：svg（接收事件）→ canvas → 外框疊層
            // 視窗大小改變（手機轉向、彈窗大小）：重畫
            if (window.ResizeObserver) new ResizeObserver(() => {
                if (svg._cv && !svg._canvas.hidden && !svg._dragging && svg.isConnected) paintCanvas(svg);
            }).observe(svg.parentNode);
        }
        return svg._canvas;
    }
    /** 目前視窗（svg 的 viewBox，meet 置中）與螢幕的對應 */
    function viewOf(svg) {
        const r = svg.parentNode.getBoundingClientRect();
        const [vx, vy, vw, vh] = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
        const s = Math.max(vw / r.width, vh / r.height);
        return { r, vx, vy, s, ox: (r.width - vw / s) / 2, oy: (r.height - vh / s) / 2 };
    }
    function paintCanvas(svg) {
        const c = canvasOf(svg);
        c.hidden = false;
        const { r, vx, vy, s, ox, oy } = viewOf(svg);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        const ctx = c.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        paintMapTo(ctx, svg, { mx0: vx - ox * s, my0: vy - oy * s, s, dpr, w: r.width, h: r.height });
    }
    /**
     * 把地圖畫到 ctx：v.mx0、v.my0 畫面左上角的地圖座標；v.s 每個「畫面點」的地圖單位；v.dpr 每個畫面點幾個像素；
     * v.w、v.h 畫面大小（畫面點）；v.tx、v.ty 畫在 ctx 的哪裡（像素，匯出影片用）。線寬以畫面點計
     */
    function paintMapTo(ctx, svg, { mx0, my0, s, dpr, w, h, tx = 0, ty = 0 }) {
        const cv = svg._cv;
        const k = dpr / s;
        ctx.setTransform(k, 0, 0, k, tx - mx0 * k, ty - my0 * k);
        // 畫面範圍（地圖座標）外的區域不畫
        const mx1 = mx0 + w * s, my1 = my0 + h * s;
        const vis = cv.items.filter(x => x.box[2] >= mx0 && x.box[0] <= mx1 && x.box[3] >= my0 && x.box[1] <= my1);
        const css = getComputedStyle(svg), v = n => css.getPropertyValue(n).trim();
        // 顏色來自 CSS：未解鎖 --map-off（不透明度 0.75；小地圖、彈窗不同）、界線 --c-surface、海岸線 --c-map-coast
        ctx.fillStyle = v('--map-off');
        ctx.globalAlpha = 0.75;
        // cv.dim（村里播放動畫：選的縣市以外）：只畫很淡的底，不上色
        const dim = cv.dim;
        for (const x of vis) if (!cv.fills.has(x.code) && !(dim && dim.has(x.code))) ctx.fill(x.p2d);
        if (dim) { ctx.globalAlpha = 0.22; for (const x of vis) if (dim.has(x.code)) ctx.fill(x.p2d); }
        ctx.globalAlpha = 1;
        for (const x of vis) { const f = cv.fills.get(x.code); if (f && !(dim && dim.has(x.code))) { ctx.fillStyle = f; ctx.fill(x.p2d); } }
        ctx.lineJoin = 'round';
        if (!cv.noLines) {   // cv.noLines（村里播放動畫）：不畫區域界線，只留下方的縣市界
            ctx.strokeStyle = v('--c-surface');
            ctx.lineWidth = (cv.fine ? 0.25 : 0.6) * s;   // 線寬固定為螢幕上的像素數（不隨縮放變粗）
            for (const x of vis) ctx.stroke(x.p2d);
        }
        // 水系（只有放大彈窗有 svg._water）：河川、水庫湖泊填色，再描一圈同色細線，窄的河段縮小時才不會斷掉
        const water = svg._water && waterOn() && svg._water.filter(x => x.box[2] >= mx0 && x.box[0] <= mx1 && x.box[3] >= my0 && x.box[1] <= my1);
        if (water && water.length) {
            ctx.fillStyle = ctx.strokeStyle = v('--c-map-water');
            ctx.lineWidth = 0.8 * s;
            for (const x of water) { ctx.fill(x.p2d); ctx.stroke(x.p2d); }
        }
        // 縣市粗邊界：只在放大彈窗的鄉鎮、村里層；粗細介於區域界線與海岸線之間（海岸線最後畫，蓋掉縣市界沿海的部分）
        if (cv.counties && svg.classList.contains('ex-modal-map')) {
            ctx.strokeStyle = v('--c-map-coast');
            ctx.lineWidth = (cv.fine ? 0.7 : 1) * s;
            ctx.stroke(cv.counties);
        }
        if (cv.coast) { ctx.strokeStyle = v('--c-map-coast'); ctx.lineWidth = (cv.fine ? 1.1 : 1.4) * s; ctx.stroke(cv.coast); }
    }
    // canvas 模式沒有 path 元素：用 { dataset, getAttribute } 代替，_showTip、setHl 照常使用
    const fakeEl = x => x && { dataset: { code: x.code }, getAttribute: () => x.d };
    let hitCtx = null;
    /** 螢幕上 (cx, cy) 的區域（path 元素或代替品）；沒有為 null */
    function hitAt(svg, cx, cy) {
        if (!svg._cv) return null;
        const { r, vx, vy, s, ox, oy } = viewOf(svg);
        const mx = vx + (cx - r.left - ox) * s, my = vy + (cy - r.top - oy) * s;
        hitCtx = hitCtx || document.createElement('canvas').getContext('2d');
        const x = svg._cv.items.find(x => mx >= x.box[0] && mx <= x.box[2] && my >= x.box[1] && my <= x.box[3] && hitCtx.isPointInPath(x.p2d, mx, my));
        return fakeEl(x) || null;
    }
    /** 某代碼的區域（path 元素或代替品） */
    const findEl = (svg, code) => svg._cv ? fakeEl(svg._cv.byCode.get(code)) : null;

    // 滑過顯示名稱與首次解鎖日期
    // 觸控時不用滑鼠事件（手指按下會補送 mousemove，雙指縮放時會誤選）；觸控的選取由放大彈窗的「單指點一下」處理
    // interactive（放大彈窗）：點一下（滑鼠或觸控）把泡泡固定住，泡泡裡可以手動補點、刪除補的點（SPEC §15.5）
    function bindHover(svg, tip, wrap, { interactive = false } = {}) {
        let touchAt = 0;
        svg._pin = null;   // 固定住的泡泡：{ code, x, y }
        svg.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') touchAt = Date.now(); });
        // 顯示某個區域的名稱與首次解鎖日期；el 為 null 時收起；同時標出選取的區域；pin：固定住（可操作補點）
        svg._showTip = (el, cx, cy, pin = false) => {
            const code = el && el.dataset && el.dataset.code;
            if (!code) { setHl(svg, null); tip.hidden = true; svg._pin = null; tip.classList.remove('pinned'); return; }
            const item = state.idx[svg._level].get(code);
            const on = item && (svg._level === 'village' || item.unlocked);
            const name = svg._names?.get(code) || code;
            // 播放動畫中（svg._nameOnly）：只顯示名稱，不能補點（2026-11-27 維護者要求）
            pin = pin && interactive && !svg._nameOnly;
            svg._pin = pin ? { code, x: cx, y: cy } : null;
            tip.classList.toggle('pinned', pin);
            tip.innerHTML = svg._nameOnly ? `<b>${esc(name)}</b>`
                : `<b>${esc(name)}</b><br>${on ? `首次解鎖 ${fmtDate(item.first)}${item.n ? `<br>照片 ${fmtInt(item.n)} 張` : ''}` : '未解鎖'}`
                + (pin ? tipManualHtml(svg, code) : '');
            tip.hidden = false;
            placeTip(tip, wrap, cx, cy);
            setHl(svg, el);
        };
        svg.addEventListener('mousemove', e => {
            if (Date.now() - touchAt < 1500 || svg._pin) return;
            if (svg._dragging) { tip.hidden = true; return; }
            svg._showTip(hitAt(svg, e.clientX, e.clientY), e.clientX, e.clientY);
        });
        svg.addEventListener('mouseleave', () => { if (Date.now() - touchAt >= 1500 && !svg._pin) svg._showTip(null); });
        if (interactive) bindTipManual(svg, tip, wrap);
    }

    // 泡泡放在指標右下方；超出邊界時改放左邊或上方
    function placeTip(tip, wrap, cx, cy) {
        const r = wrap.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
        let x = cx - r.left + 14, y = cy - r.top + 14;
        if (x + w > r.width - 4) x = Math.max(cx - r.left - 14 - w, r.width - 4 - w);
        if (y + h > r.height - 4) y = cy - r.top - 14 - h;
        tip.style.left = Math.max(4, x) + 'px';
        tip.style.top = Math.max(4, y) + 'px';
    }

    // ---------- 迷霧地圖補點（手動紀錄 kind 5：記在村里代表點，只解鎖這個村里） ----------

    const VILL_TARGET = 'village:';   // 同 js/manual.js
    /** 點的區域 → 手動加入的資料；鄉鎮用「鄉鎮代表點所在的村里」 */
    function mapAddInfo(svg, code) {
        const p = svg._paths?.get(code);
        if (!p || !p.c) return null;
        if (svg._level === 'village') return { target: VILL_TARGET + code, label: p.name, lat: p.c[0], lng: p.c[1], area: false };
        if (svg._level === 'town' && p.v) return { target: VILL_TARGET + p.v, label: `${p.name} ${p.vn || ''}`.trim(), lat: p.c[0], lng: p.c[1], area: false, town: true };
        return null;
    }

    function tipManualHtml(svg, code) {
        if (!manualApi || !manualApi.list) return '';
        const info = mapAddInfo(svg, code);
        if (!info) return '';
        const mine = manualApi.list(VILL_TARGET + code);
        const vname = it => (it.label || '').split(' ').pop();
        const list = mine.length ? `<div class="ex-tip-list"><small>手動補的點</small>${mine.map(it =>
            `<div class="ex-tip-item"><span>✋ ${Number.isFinite(it.time) ? fmtDate(it.time) : '沒有日期'}${svg._level === 'town' ? ' ' + esc(vname(it)) : ''}</span>
                <button type="button" class="ex-mbtn" data-tdel="${it.ref}" title="刪除這筆補點">🗑</button></div>`).join('')}</div>` : '';
        return `${list}<div class="ex-tip-act"><button type="button" class="ex-mbtn primary" data-tadd>✋ 我去過，手動加入</button></div>`;
    }

    function bindTipManual(svg, tip, wrap) {
        tip.addEventListener('click', async e => {
            const t = e.target.closest('button');
            if (!t || !svg._pin) return;
            const code = svg._pin.code, info = mapAddInfo(svg, code);
            if (t.dataset.tadd !== undefined && info) {
                t.closest('.ex-tip-act').innerHTML = `<div class="ex-tform">
                    <label>造訪日期 <input type="date" max="${todayStr()}"></label>
                    <div class="ex-mform-msg" hidden></div>
                    <div class="ex-mform-btns"><button type="button" class="ex-mbtn primary" data-tok>加入</button>
                        <button type="button" class="ex-mbtn" data-tcancel>取消</button></div></div>`;
                placeTip(tip, wrap, svg._pin.x, svg._pin.y);
                tip.querySelector('input').focus();
            } else if (t.dataset.tcancel !== undefined) {
                svg._showTip(findEl(svg, code), svg._pin.x, svg._pin.y, true);
            } else if (t.dataset.tok !== undefined && info) {
                const date = tip.querySelector('.ex-tform input').value;
                const msg = tip.querySelector('.ex-mform-msg');
                if (date && date > todayStr()) { msg.hidden = false; msg.textContent = '日期不能在未來'; return; }
                tip.querySelectorAll('button').forEach(b => { b.disabled = true; });
                t.textContent = '加入中…';
                const err = await manualApi.add(info, date);
                if (err) {
                    t.textContent = '加入';
                    tip.querySelectorAll('button').forEach(b => { b.disabled = false; });
                    msg.hidden = false; msg.textContent = err;
                }
                // 成功時重新計算 → setData 會重畫地圖並重新固定這個泡泡
            } else if (t.dataset.tdel !== undefined) {
                const it = manualApi.item(+t.dataset.tdel);
                if (!it) return;
                if (!confirm(`刪除這筆迷霧地圖補點？\n「${it.label}」（${Number.isFinite(it.time) ? fmtDate(it.time) : '沒有日期'}）`)) return;
                await manualApi.remove(+t.dataset.tdel);
            }
        });
    }

    // ---------- 明細的鄉鎮小方塊：點一下開泡泡，可手動補點（和放大彈窗的鄉鎮地圖同一套：tipManualHtml、bindTipManual） ----------
    // dsvg 是給補點程式用的替身（不是真的 svg）：_paths 取自鄉鎮地圖（代表點、代表村里），第一次點時才載入

    const dsvg = { _level: 'town', _paths: null, _cv: null, _pin: null };

    function bindDetailTip() {
        const sec = root.querySelector('#ex-detail-sec');
        const tip = root.querySelector('#ex-dtip');
        const chipOf = code => root.querySelector(`#ex-detail .ex-chip[data-code="${CSS.escape(code)}"]`);
        dsvg._showTip = (el, cx, cy, pin = true) => {
            root.querySelectorAll('#ex-detail .ex-chip[aria-expanded]').forEach(c => c.removeAttribute('aria-expanded'));
            const code = el && el.dataset && el.dataset.code;
            const chip = code && state.unit === 'town' && chipOf(code);
            if (!chip || !pin) { tip.hidden = true; dsvg._pin = null; return; }
            const item = state.idx.town.get(code);
            const on = item && item.unlocked;
            const name = item ? fullName('town', item) : chip.textContent;
            // 位置每次從小方塊現在的位置算（加入表單時會重新定位，期間可能捲動過）；placeTip 會往右下偏 14px
            dsvg._pin = { code, get x() { return chip.getBoundingClientRect().left - 14; }, get y() { return chip.getBoundingClientRect().bottom - 10; } };
            tip.classList.add('pinned');
            tip.innerHTML = `<b>${esc(name)}</b><br>${on ? `首次解鎖 ${fmtDate(item.first)}${item.n ? `<br>照片 ${fmtInt(item.n)} 張` : ''}` : '未解鎖'}`
                + tipManualHtml(dsvg, code);
            tip.hidden = false;
            placeTip(tip, sec, dsvg._pin.x, dsvg._pin.y);
            chip.setAttribute('aria-expanded', 'true');
        };
        const open = async chip => {
            const code = chip.dataset.code;
            if (dsvg._pin && dsvg._pin.code === code) { dsvg._showTip(null); return; }
            if (!dsvg._paths) {
                try {
                    const m = await getMap('town');
                    dsvg._paths = new Map(m.paths.map(p => [p.code, p]));
                    dsvg._cv = { byCode: new Map(m.paths.map(p => [p.code, { code: p.code }])) };
                } catch (e) { /* 地圖載入失敗：泡泡照樣顯示日期，只是沒有補點按鈕 */ }
            }
            dsvg._showTip({ dataset: { code } });
        };
        root.querySelector('#ex-detail').addEventListener('click', e => {
            const chip = e.target.closest('.ex-chip[data-code]');
            if (chip) open(chip);
        });
        root.querySelector('#ex-detail').addEventListener('keydown', e => {
            const chip = e.target.closest('.ex-chip[data-code]');
            if (chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(chip); }
        });
        // 點泡泡和小方塊以外的地方、按 Esc：收起
        document.addEventListener('click', e => {
            // 用 composedPath：泡泡裡的按鈕按下後可能已被換掉（不在 tip 裡了）
            const path = e.composedPath();
            if (dsvg._pin && !path.includes(tip) && !path.some(n => n.matches && n.matches('#ex-detail .ex-chip[data-code]'))) dsvg._showTip(null);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && dsvg._pin) dsvg._showTip(null); });
        bindTipManual(dsvg, tip, sec);
    }

    // 資料更新（例如剛補點）或切換層級後：重新固定原本的泡泡（不在鄉鎮明細就收起）
    function refreshDetailTip() {
        if (dsvg._pin && dsvg._showTip) dsvg._showTip({ dataset: { code: dsvg._pin.code } });
    }

    // ---------- 放大彈窗：滾輪縮放、拖曳平移 ----------

    let modal = null;
    // 放大彈窗上方的提示：精簡成一句（2026-11-27 手機回饋）；播放動畫中不能補點，只留縮放平移
    const HINT_NORMAL = '可縮放平移・點區域可補點', HINT_PLAY = '可縮放平移';

    function buildModal() {
        modal = document.createElement('div');
        modal.className = 'ex-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="ex-modal-box" role="dialog" aria-modal="true" aria-labelledby="ex-modal-title">
                <div class="ex-modal-head">
                    <span id="ex-modal-title" class="ex-modal-title"></span>
                    <span class="ex-modal-hint">${HINT_NORMAL}</span>
                    <span class="ex-modal-regions" role="group" aria-label="地區">${Object.entries(REGIONS).map(([k, r]) =>
                        `<button type="button" data-region="${k}">${r.label}</button>`).join('')}</span>
                    <span class="ex-modal-tools">
                        <button type="button" data-act="close" class="ex-modal-x" title="關閉（Esc）">✕</button>
                    </span>
                </div>
                <div class="ex-modal-body">
                    <svg class="ex-map ex-modal-map" preserveAspectRatio="xMidYMid meet"></svg>
                    <!-- 地圖上的按鈕：縮放、河川、全圖在右上角由上往下；播放動畫在右下角 -->
                    <span class="ex-modal-tools ex-map-ctrls">
                        <button type="button" data-act="in" title="放大" aria-label="放大">＋</button>
                        <button type="button" data-act="out" title="縮小" aria-label="縮小">－</button>
                        <button type="button" data-act="water" class="ex-modal-water" aria-pressed="${waterOn()}" title="顯示河川、水庫與湖泊" aria-label="顯示河川、水庫與湖泊">💧</button>
                        <button type="button" data-act="reset" title="縮放回本島全圖（不會刪除任何資料）">全圖</button>
                    </span>
                    <span class="ex-modal-tools ex-map-playbtn">
                        <button type="button" data-act="video" class="ex-modal-video" title="把播放動畫存成影片（MP4）" hidden>🎬 匯出影片</button>
                        <button type="button" data-act="play" class="ex-modal-play" aria-pressed="false" title="依首次解鎖時間逐年（或逐月）播放迷霧散開的動畫" hidden>▶ 播放動畫</button>
                    </span>
                    <div class="ex-map-loading">載入地圖中…</div>
                    <div class="ex-tip" hidden></div>
                    <div class="ex-play-stamp" hidden aria-live="polite"><b></b><span></span></div>
                    <div class="ex-video" hidden role="dialog" aria-label="匯出影片"></div>
                </div>
                <div class="ex-play" hidden>
                    <button type="button" data-act="play-toggle" class="ex-play-btn" aria-label="播放">▶</button>
                    <input type="range" class="ex-play-range" min="0" max="0" step="1" value="0" aria-label="時間">
                    <select class="ex-play-county" aria-label="縣市（依解鎖村里數多到少排）" hidden></select>
                    <span class="ex-seg ex-play-seg" role="group" aria-label="時間刻度">
                        <button type="button" data-pmode="year">每年</button><button type="button" data-pmode="month">每月</button></span>
                    <span class="ex-seg ex-play-seg" role="group" aria-label="播放速度">
                        <button type="button" data-pspeed="1">1×</button><button type="button" data-pspeed="2">2×</button><button type="button" data-pspeed="3">3×</button></span>
                    <button type="button" data-act="play-exit" class="ex-play-exit">結束播放</button>
                </div>
                <div class="ex-legend ex-modal-legend"></div>
            </div>`;
        document.body.appendChild(modal);
        bindColorSwitch(modal.querySelector('.ex-modal-legend'));

        const svg = modal.querySelector('svg');
        const body = modal.querySelector('.ex-modal-body');
        bindHover(svg, modal.querySelector('.ex-tip'), body, { interactive: true });

        const tip = modal.querySelector('.ex-tip');
        // 拖曳、縮放的邊界：全圖（台澎金馬外框）放大 1.5 倍；視窗比邊界小時不能拖出去，比邊界大時置中
        const clampVb = v => {
            const b = svg._base;
            if (!b) return v;
            const B = { x: b.x - b.w * 0.25, y: b.y - b.h * 0.25, w: b.w * 1.5, h: b.h * 1.5 };
            const fit1 = (pos, len, lo, span) => len >= span ? lo + (span - len) / 2 : Math.min(lo + span - len, Math.max(lo, pos));
            return { ...v, x: fit1(v.x, v.w, B.x, B.w), y: fit1(v.y, v.h, B.y, B.h) };
        };
        // 視窗：svg._vb 是目前的視窗；shown 是實際畫在 viewBox 上的視窗
        // 拖曳、雙指縮放時只用 CSS transform 移動、縮放已畫好的地圖（不重畫），放開才改 viewBox 重畫一次（iOS 才順）
        let shown = null, raf = 0;
        const setXf = t => { svg.style.transform = t; hlOf(svg).style.transform = t; if (svg._canvas) svg._canvas.style.transform = t; };
        const draw = v => {
            cancelAnimationFrame(raf); raf = 0;
            shown = v;
            setViewBox(svg, `${v.x} ${v.y} ${v.w} ${v.h}`);
            setXf('');
        };
        const setVb = v => { v = clampVb(v); svg._vb = v; draw(v); };
        const liveVb = v => {
            svg._vb = clampVb(v);
            if (!shown) { draw(svg._vb); return; }
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                // shown 畫出來的點 X0 → 新視窗下的位置 X1 = k·X0 + t
                const a = fit(shown), b = fit(svg._vb), k = a.s / b.s;
                const tx = b.ox - a.ox * k + (shown.x - svg._vb.x) / b.s, ty = b.oy - a.oy * k + (shown.y - svg._vb.y) / b.s;
                setXf(`translate(${tx}px, ${ty}px) scale(${k})`);
            });
        };
        const commitVb = () => { if (svg._vb && (raf || svg.style.transform)) draw(svg._vb); };
        svg._draw = draw;
        // 螢幕座標 → 地圖座標（preserveAspectRatio=meet：取較大的縮放比，並扣掉置中留白）
        // 用外框（地圖填滿它）量大小：手勢中地圖本身有 transform，量到的會不準
        const fit = v => {
            const r = body.getBoundingClientRect();
            const s = Math.max(v.w / r.width, v.h / r.height);
            return { r, s, ox: (r.width - v.w / s) / 2, oy: (r.height - v.h / s) / 2 };
        };
        const toSvg = (cx, cy, v = svg._vb) => {
            const { r, s, ox, oy } = fit(v);
            return { x: v.x + (cx - r.left - ox) * s, y: v.y + (cy - r.top - oy) * s, s };
        };
        // 寬度 w 的視窗，讓地圖點 p 落在螢幕 (cx, cy)；寬度限制在 [MIN_VIEW_W, 全圖]
        const placeAt = (p, cx, cy, w, from) => {
            const base = svg._base;
            w = Math.min(base.w, Math.max(MIN_VIEW_W[svg._level] || MIN_VIEW_W.town, w));
            if (w === base.w) return { ...base };
            const v = { x: 0, y: 0, w, h: w * from.h / from.w };
            const { r, s, ox, oy } = fit(v);
            v.x = p.x - (cx - r.left - ox) * s;
            v.y = p.y - (cy - r.top - oy) * s;
            return v;
        };
        // 以螢幕上的 (cx, cy) 為中心縮放；未指定時以畫面中心
        const zoom = (factor, cx, cy) => {
            svg._showTip(null);
            const v = svg._vb;
            if (cx === undefined) { const r = body.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
            setVb(placeAt(toSvg(cx, cy), cx, cy, v.w / factor, v));
        };
        const goRegion = k => {
            svg._showTip(null);
            const b = svg._base, g = REGIONS[k].box;
            setVb(g ? regionBox(g) : { ...b });
            modal.querySelectorAll('[data-region]').forEach(x => x.classList.toggle('active', x.dataset.region === k));
        };
        svg._goRegion = goRegion;
        svg._setVb = setVb;   // 村里播放動畫縮放到縣市
        svg.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY); }, { passive: false });
        // 觸控的連點自己判斷（下方 pointerup）；有些瀏覽器觸控也會送 dblclick，略過以免放大兩次
        let lastType = 'mouse';
        svg.addEventListener('dblclick', e => { if (lastType !== 'touch') zoom(2, e.clientX, e.clientY); });

        // 拖曳（一指或滑鼠）與雙指縮放：記住每個按下的指標
        const pts = new Map();
        let drag = null, pinch = null, lastTap = null, tapTimer = 0;
        const unselect = () => { clearTimeout(tapTimer); svg._showTip(null); };
        const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
        svg.addEventListener('pointerdown', e => {
            lastType = e.pointerType;
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            svg.setPointerCapture(e.pointerId);
            if (pts.size === 1) {
                drag = { x: e.clientX, y: e.clientY, vb: { ...svg._vb }, moved: false };
            } else if (pts.size === 2) {
                const m = mid();
                pinch = { d: m.d, vb: { ...svg._vb }, p: toSvg(m.x, m.y) };
                drag = null;
                lastTap = null;
                unselect();
            }
        });
        svg.addEventListener('pointermove', e => {
            if (!pts.has(e.pointerId)) return;
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch && pts.size >= 2) {
                // 兩指中點下的地圖點跟著手指走，同時依兩指距離縮放
                const m = mid();
                liveVb(placeAt(pinch.p, m.x, m.y, pinch.vb.w * pinch.d / m.d, pinch.vb));
                svg._dragging = true;
                svg.classList.add('dragging');
                return;
            }
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 8 : 3)) return;
            drag.moved = svg._dragging = true;
            unselect();
            svg.classList.add('dragging');
            const { s } = toSvg(0, 0, drag.vb);
            liveVb({ ...drag.vb, x: drag.vb.x - dx * s, y: drag.vb.y - dy * s });
        });
        const endPointer = e => {
            pts.delete(e.pointerId);
            const tap = e.type === 'pointerup' && e.pointerType === 'touch' && drag && !drag.moved && !pinch;
            if (tap) {
                // 連點放大：0.3 秒內、25px 內的第二下；單點則等 0.3 秒確定不是連點，才選取並顯示名稱
                const now = Date.now();
                clearTimeout(tapTimer);
                if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 25) {
                    zoom(2, e.clientX, e.clientY);
                    lastTap = null;
                } else {
                    lastTap = { t: now, x: e.clientX, y: e.clientY };
                    const x = e.clientX, y = e.clientY, el = hitAt(svg, x, y);
                    tapTimer = setTimeout(() => svg._showTip(el, x, y, true), 300);
                }
            } else if (e.type === 'pointerup' && e.pointerType === 'mouse' && e.button === 0 && drag && !drag.moved && !pinch) {
                // 滑鼠點一下：固定泡泡（可補點）；點同一區或空白處收起
                const hit = hitAt(svg, e.clientX, e.clientY), code = hit ? hit.dataset.code : null;
                if (code && svg._pin && svg._pin.code === code) svg._showTip(null);
                else svg._showTip(code ? hit : null, e.clientX, e.clientY, true);
            }
            if (pts.size < 2) pinch = null;
            if (pts.size === 1) {
                // 雙指放開一指：剩下那指接著拖曳，不會跳動
                const [p] = pts.values();
                drag = { x: p.x, y: p.y, vb: { ...svg._vb }, moved: true };
                return;
            }
            if (!pts.size) { drag = null; svg._dragging = false; svg.classList.remove('dragging'); commitVb(); }
        };
        svg.addEventListener('pointerup', endPointer);
        svg.addEventListener('pointercancel', endPointer);

        modal.addEventListener('click', e => {
            const ds = e.target.dataset || {}, act = ds.act;
            if (e.target === modal || act === 'close') closeModal();
            else if (act === 'in') zoom(1.5);
            else if (act === 'out') zoom(1 / 1.5);
            else if (act === 'reset') goRegion(DEFAULT_REGION);
            else if (act === 'water') {
                const on = !waterOn();
                try { localStorage.setItem(WATER_KEY, on ? '1' : '0'); } catch (err) { /* 存不了只影響這次 */ }
                e.target.setAttribute('aria-pressed', on);
                const svg = modal.querySelector('svg');
                if (on) loadWater(svg);
                if (svg._cv) paintCanvas(svg);
            }
            else if (ds.region) goRegion(ds.region);
            else if (act === 'play') { if (play) exitPlay(); else startPlay(null, true); }
            else if (act === 'video') openVideo();
            else if (act === 'play-toggle') togglePlay();
            else if (act === 'play-exit') exitPlay();
            else if (ds.pmode && play && ds.pmode !== play.mode) setPlayMode(ds.pmode);
            else if (ds.pspeed && play) { play.speed = +ds.pspeed; syncPlayBar(); if (play.timer) schedule(); }
        });
        modal.querySelector('.ex-play-range').addEventListener('input', e => { pausePlay(); goFrame(+e.target.value); });
        modal.querySelector('.ex-play-county').addEventListener('change', e => { if (play) setPlayCounty(e.target.value); });
        document.addEventListener('keydown', e => {
            if (modal.hidden) return;
            if (e.key === 'Escape') closeModal();
            // 播放中：左右鍵前後一格（拉桿有焦點時由它自己處理）
            else if (play && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target.closest && e.target.closest('input, textarea, select'))) {
                e.preventDefault();
                pausePlay();
                goFrame(play.i + (e.key === 'ArrowLeft' ? -1 : 1));
            }
        });
    }

    // keep：彈窗開著時資料更新（例如剛補點）：保留縮放位置，重新固定原本的泡泡
    // opts.level：指定層級（預設跟頁面上方的單位）；opts.playAt：開啟後停在逐年播放的這一年（'early'＝2015 前）
    async function openModal(keep = false, opts = {}) {
        if (!modal) buildModal();
        keep = keep === true;   // 直接當事件處理函式時第一個參數是事件
        const svg = modal.querySelector('svg');
        const level = opts.level || (keep && svg._level) || state.unit;
        const prev = keep && svg._level === level && svg._vb ? { vb: svg._vb, pin: svg._pin } : null;
        const loading = modal.querySelector('.ex-map-loading');
        modal.querySelector('.ex-modal-title').textContent = `迷霧地圖・${UNIT_LABEL[level]}`;
        modal.querySelector('.ex-modal-play').hidden = !PLAY_LEVELS.has(level);   // 播放動畫：鄉鎮、村里（縣市太粗）
        modal.querySelector('.ex-tip').hidden = true;
        modal.hidden = false;
        document.body.classList.add('ex-modal-open');
        if (svg._level === level && svg._data === state.data) {   // 已畫過同一層級與資料，保留縮放位置
            if (!play && svg._color !== (useConquer(level) ? 'count' : 'year')) await recolorModal();
            afterOpen(opts);
            return;
        }
        if (!prev) svg.innerHTML = '';
        modal.querySelector('.ex-modal-legend').innerHTML = '';
        loading.hidden = !!prev;
        loading.textContent = level === 'village' ? '載入村里地圖中（約 400 KB）…' : '載入地圖中…';
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
        if (prev) { svg._vb = prev.vb; svg._draw(prev.vb); }
        else svg._goRegion(DEFAULT_REGION);
        modal.querySelector('.ex-modal-legend').innerHTML = legendHtml(y0, y1, level);
        loadWater(svg);
        const el = prev && prev.pin && findEl(svg, prev.pin.code);
        if (el) svg._showTip(el, prev.pin.x, prev.pin.y, true);
        afterOpen(opts);
    }
    // 開好地圖之後：播放中（例如剛補點、資料重算）照目前的格子重畫；有指定年份就進入播放並停在那一年
    function afterOpen(opts) {
        if (play) { if (modal.querySelector('svg')._level === play.level) rebuildPlay(); else exitPlay(); }
        else if (opts.playAt !== undefined && opts.playAt !== null) startPlay(opts.playAt, false);
    }

    // ---------- 放大地圖：逐年／逐月播放動畫（鄉鎮、村里） ----------
    // 依首次解鎖時間一格一格顯示，只用兩色（資訊才不會太雜）：之前已解鎖 PLAY_PAST_COLOR（淺橘）、這一格新解鎖 PLAY_NOW_COLOR（橘，直接出現）、之後的維持迷霧；沒有日期的不顯示
    // 一年一格停 1 秒、一月一格停 0.5 秒（2×、3× 依倍數縮短）；2015 年以前合併成一格。每次打開都是每月、1×（2026-11-27 維護者要求，不記上次的選擇）
    // 村里：預設只看解鎖村里最多的縣市（地圖縮放到該縣市、其他縣市淡灰不上色），可切換縣市或全島；播放時不畫村里界線，只留縣市界，解鎖的村里比較明顯
    const PLAY_LEVELS = new Set(['town', 'village']);
    let play = null;   // { level, county（村里：縣市代碼或 'all'）, mode, speed, frames, i, timer, dim }
    const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const utc = (y, m = 0) => Date.UTC(y, m, 1) / 1000;
    // 村里動畫的縣市範圍：村里代碼前 5 碼是縣市代碼；臺北、新北、基隆連在一起，合成「北北基」一組；新竹、嘉義縣市各合成一組（2026-11-27 維護者要求）
    const COUNTY_GROUPS = {
        nnk: { name: '北北基', codes: ['63000', '65000', '10017'] },
        hsinchu: { name: '新竹縣市', codes: ['10004', '10018'] },
        chiayi: { name: '嘉義縣市', codes: ['10010', '10020'] },
    };
    const GROUP_OF = new Map(Object.entries(COUNTY_GROUPS).flatMap(([k, g]) => g.codes.map(c => [c, k])));
    const countyOf = code => { const c = code.slice(0, 5); return GROUP_OF.get(c) || c; };
    const scopeName = k => COUNTY_GROUPS[k]?.name || state.idx.county.get(k)?.name || k;
    /** 這次播放範圍內有日期的已解鎖區域 */
    function playItems() {
        if (play.level === 'town') return [...state.idx.town.values()].filter(t => t.unlocked && t.first);
        return [...state.idx.village.values()].filter(v => v.first && (play.county === 'all' || countyOf(v.code) === play.county));
    }
    /** 有解鎖村里的縣市，依解鎖村里數多到少：[[代碼, 個數]] */
    function villageCounties() {
        const n = new Map();
        for (const v of state.idx.village.values()) if (v.first) n.set(countyOf(v.code), (n.get(countyOf(v.code)) || 0) + 1);
        return [...n].sort((a, b) => b[1] - a[1]);
    }
    /** 播放格子：[{ key, label, start, end, n }]，start ≤ first < end 算這一格新解鎖 */
    function playFrames(mode) {
        const ts = playItems().map(t => t.first);
        if (!ts.length) return [];
        const d0 = new Date(Math.min(...ts) * 1000), d1 = new Date(Math.max(...ts) * 1000);
        const frames = [];
        const early = d0.getUTCFullYear() < EARLY_YEAR;
        if (early) frames.push({ key: 'early', label: `${EARLY_YEAR} 年前`, start: -Infinity, end: utc(EARLY_YEAR) });
        if (mode === 'year') {
            for (let y = Math.max(EARLY_YEAR, d0.getUTCFullYear()); y <= d1.getUTCFullYear(); y++)
                frames.push({ key: y, label: `${y} 年`, start: utc(y), end: utc(y + 1) });
        } else {
            // 每月：從 2015 年以後第一筆的月份開始
            const s = new Date(Math.min(...ts.filter(t => t >= utc(EARLY_YEAR))) * 1000);
            if (!isNaN(s)) for (let y = s.getUTCFullYear(), m = s.getUTCMonth(); utc(y, m) <= d1.getTime() / 1000; m === 11 ? (y++, m = 0) : m++)
                frames.push({ key: y, label: `${y} 年 ${m + 1} 月`, start: utc(y, m), end: utc(y, m + 1) });
        }
        // 第一格：還沒解鎖任何區域（第一筆資料的前一年；每月且沒有 2015 前那格時是前一個月），動畫從全是迷霧開始
        if (frames.length) {
            const f0 = frames[0], y = d0.getUTCFullYear();
            let label = `${y - 1} 年`;
            if (mode === 'month' && f0.key !== 'early') { const p = new Date((f0.start - 1) * 1000); label = `${p.getUTCFullYear()} 年 ${p.getUTCMonth() + 1} 月`; }
            frames.unshift({ key: 'start', label, start: -Infinity, end: -Infinity });
        }
        for (const f of frames) f.n = ts.filter(t => t >= f.start && t < f.end).length;
        return frames;
    }
    // at：格子索引，或年份／'early'（找那一年的第一格；超出範圍取最近的一格）
    function frameIndex(frames, at) {
        if (typeof at === 'number' && at < 1000) return Math.max(0, Math.min(frames.length - 1, at));
        let i = frames.findIndex(f => f.key === at);
        if (i < 0) i = at === 'early' ? 0 : frames.findIndex(f => typeof f.key === 'number' && f.key >= at);
        return i < 0 ? frames.length - 1 : i;
    }
    /** 重新切格子（換刻度、換縣市、資料更新），停在差不多的時間：回傳格子索引；沒有資料回傳 -1 */
    function reframe() {
        const cur = play.frames[play.i];
        play.frames = playFrames(play.mode);
        if (!play.frames.length) return -1;
        if (!cur) return play.frames.length - 1;
        if (cur.key === 'start') return 0;
        if (cur.key === 'early' || play.mode === 'year') return frameIndex(play.frames, cur.key);
        const i = play.frames.findIndex(f => f.key !== 'start' && f.end > cur.start);   // 每年 → 那一年的第一個月
        return i < 0 ? play.frames.length - 1 : i;
    }
    function startPlay(at, auto) {
        const svg = modal.querySelector('svg');
        if (!PLAY_LEVELS.has(svg._level)) return;
        // 從長條圖進來的 at 是年份：停在那一年的第一個月；at 為 null（按「播放動畫」）：從預設起點開始（defaultStart）
        play = { level: svg._level, county: 'all', mode: 'month', speed: 1, frames: [], i: 0, timer: 0, dim: null };
        if (play.level === 'village') {
            const list = villageCounties();
            play.county = list.length ? list[0][0] : 'all';
            fillCountySelect(list);
        }
        modal.querySelector('.ex-play-county').hidden = play.level !== 'village';
        play.frames = playFrames(play.mode);
        if (!play.frames.length) { play = null; return; }
        modal.querySelector('.ex-play').hidden = false;
        modal.querySelector('.ex-play-stamp').hidden = false;
        modal.querySelector('.ex-modal-play').setAttribute('aria-pressed', 'true');
        modal.querySelector('.ex-modal-video').hidden = false;
        modal.querySelector('.ex-modal-legend').innerHTML = playLegend();
        setPlayingUi(svg, true);
        focusCounty();
        goFrame(at === null ? defaultStart() : frameIndex(play.frames, at));
        if (auto && !reduceMotion()) schedule();   // 減少動態效果：不自動播放，可以手動按 ▶ 或拖拉桿
        syncPlayBar();
    }
    function exitPlay() {
        if (!play) return;
        clearTimeout(play.timer);
        play = null;
        closeVideo();
        modal.querySelector('.ex-play').hidden = true;
        modal.querySelector('.ex-play-stamp').hidden = true;
        modal.querySelector('.ex-modal-play').setAttribute('aria-pressed', 'false');
        modal.querySelector('.ex-modal-video').hidden = true;
        setPlayingUi(modal.querySelector('svg'), false);
        recolorModal();   // 回到原本的上色、界線與圖例
    }
    // 播放中：隱藏地區切換（CSS .ex-playing）、提示只留縮放平移、點區域只顯示名稱（不能補點）
    function setPlayingUi(svg, on) {
        modal.classList.toggle('ex-playing', on);
        modal.querySelector('.ex-modal-hint').textContent = on ? HINT_PLAY : HINT_NORMAL;
        svg._nameOnly = on;
        svg._showTip(null);
    }
    /**
     * 預設起點（2026-11-27 維護者要求）：找新解鎖最多的那一格（每年：那一年；每月：那個月），從前一年開始播
     * —— 每年從高峰年的前一年、每月從高峰月往前 12 個月；早於第一格就從頭（全是迷霧）開始
     */
    function defaultStart() {
        const fr = play.frames;
        let best = -1;
        fr.forEach((f, i) => { if (typeof f.key === 'number' && (best < 0 || f.n > fr[best].n)) best = i; });
        if (best < 0) return 0;
        const d = new Date(fr[best].start * 1000);
        const from = play.mode === 'year' ? utc(d.getUTCFullYear() - 1) : utc(d.getUTCFullYear() - 1, d.getUTCMonth());
        const i = fr.findIndex(f => f.start === from);
        return i < 0 ? 0 : i;
    }
    // 資料更新後重新切格子，停在同一個時間
    function rebuildPlay() {
        if (play.level === 'village') {
            const list = villageCounties();
            if (play.county !== 'all' && !list.some(([c]) => c === play.county)) play.county = list.length ? list[0][0] : 'all';
            fillCountySelect(list);
            focusCounty(false);
        }
        const i = reframe();
        if (i < 0) { exitPlay(); return; }
        modal.querySelector('.ex-modal-legend').innerHTML = playLegend();
        goFrame(i);
    }
    function setPlayMode(mode) {
        play.mode = mode;
        const i = reframe();
        modal.querySelector('.ex-modal-legend').innerHTML = playLegend();   // 「這一年／這個月新解鎖」
        goFrame(i < 0 ? 0 : i);
        if (play.timer) schedule();
        syncPlayBar();
    }
    function setPlayCounty(county) {
        play.county = county;
        focusCounty();
        const i = reframe();
        if (i < 0) return;
        goFrame(i);
        if (play.timer) schedule();
    }
    function fillCountySelect(list) {
        const sel = modal.querySelector('.ex-play-county');
        sel.innerHTML = list.map(([c]) => `<option value="${c}">${esc(scopeName(c))}</option>`).join('')
            + '<option value="all">全島</option>';
        sel.value = play.county;
    }
    // 村里：縮放到選的縣市，其他縣市淡灰；全島回到本島全圖。move＝false 只更新淡灰範圍（資料更新時不動畫面）
    function focusCounty(move = true) {
        const svg = modal.querySelector('svg');
        if (play.level !== 'village' || !svg._cv) { play.dim = null; return; }
        if (play.county === 'all') {
            play.dim = null;
            if (move) svg._goRegion(DEFAULT_REGION);
            return;
        }
        play.dim = new Set();
        // 縮放範圍只算本島框內的村里：基隆的北方三島（彭佳嶼等）在本島框外，不讓畫面被拉走；
        // 整個縣市都在框外（金門、連江）才用全部
        const main = regionBox(REGIONS.main.box);
        const inMain = b => (b[0] + b[2]) / 2 >= main.x && (b[0] + b[2]) / 2 <= main.x + main.w && (b[1] + b[3]) / 2 >= main.y && (b[1] + b[3]) / 2 <= main.y + main.h;
        const own = svg._cv.items.filter(x => countyOf(x.code) === play.county);
        for (const x of svg._cv.items) if (countyOf(x.code) !== play.county) play.dim.add(x.code);
        const boxes = own.some(x => inMain(x.box)) ? own.filter(x => inMain(x.box)) : own;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const x of boxes) { x0 = Math.min(x0, x.box[0]); y0 = Math.min(y0, x.box[1]); x1 = Math.max(x1, x.box[2]); y1 = Math.max(y1, x.box[3]); }
        if (move && x0 < x1) {
            const px = (x1 - x0) * 0.06, py = (y1 - y0) * 0.06;
            svg._showTip(null);
            svg._setVb({ x: x0 - px, y: y0 - py, w: x1 - x0 + px * 2, h: y1 - y0 + py * 2 });
            modal.querySelectorAll('[data-region]').forEach(b => b.classList.remove('active'));
        }
    }
    function schedule() {
        clearTimeout(play.timer);
        if (play.i >= play.frames.length - 1) goFrame(defaultStart());   // 在最後一格按播放：從預設起點重播
        const wait = (play.mode === 'year' ? 1000 : 500) / play.speed;
        play.timer = setTimeout(function tick() {
            if (!play) return;
            goFrame(play.i + 1);
            if (play.i < play.frames.length - 1) play.timer = setTimeout(tick, wait);
            else { play.timer = 0; syncPlayBar(); }   // 播完停在最後一格（完整的地圖）
        }, wait);
        syncPlayBar();
    }
    function pausePlay() { if (play && play.timer) { clearTimeout(play.timer); play.timer = 0; syncPlayBar(); } }
    function togglePlay() { if (!play) return; if (play.timer) pausePlay(); else schedule(); }
    function syncPlayBar() {
        if (!play) return;
        const bar = modal.querySelector('.ex-play');
        const btn = bar.querySelector('.ex-play-btn');
        btn.textContent = play.timer ? '⏸' : '▶';
        btn.setAttribute('aria-label', play.timer ? '暫停' : '播放');
        const r = bar.querySelector('.ex-play-range');
        r.max = play.frames.length - 1;
        r.value = play.i;
        bar.querySelectorAll('[data-pmode]').forEach(b => b.classList.toggle('active', b.dataset.pmode === play.mode));
        bar.querySelectorAll('[data-pspeed]').forEach(b => b.classList.toggle('active', +b.dataset.pspeed === play.speed));
    }
    const playLegend = () => `<span class="ex-legend-item"><i class="sw fog"></i>未解鎖（迷霧）</span>
        <span class="ex-legend-item"><i class="sw lv" style="background:${PLAY_PAST_COLOR}"></i>之前已解鎖</span>
        <span class="ex-legend-item"><i class="sw lv" style="background:${PLAY_NOW_COLOR}"></i>這${play.mode === 'year' ? '一年' : '個月'}新解鎖</span>
        <span class="ex-legend-item ex-play-note">沒有日期的紀錄不顯示</span>`;
    // 換格直接換色（2026-11-27 維護者回饋：淡入看起來會閃一下，改為直接出現橘色）
    function goFrame(i) {
        const svg = modal.querySelector('svg');
        if (!play || !svg._cv || svg._level !== play.level) return;
        play.i = Math.max(0, Math.min(play.frames.length - 1, i));
        svg._cv.fills = fillsAt(play.i);
        svg._cv.dim = play.dim;                        // 村里：其他縣市淡灰
        svg._cv.noLines = play.level === 'village';    // 村里：不畫村里界線，只留縣市界
        paintCanvas(svg);
        const stamp = modal.querySelector('.ex-play-stamp'), t = frameText(play.i);
        stamp.querySelector('b').textContent = t.date;
        stamp.querySelector('span').textContent = t.line;
        syncPlayBar();
    }
    // ---------- 匯出影片（播放動畫存成 MP4；2026-11-27 維護者要求，GIF 分享受限所以不用） ----------
    // 做法見 js/video.js：能用 WebCodecs 就一格一格交給編碼器（不用等實際時間、卡頓不會進影片），否則退回 MediaRecorder 即時錄
    // 畫在不在畫面上的 canvas（按鈕、拉桿不會被錄進去）：上方暱稱（和成就卡片共用）、年月、＋幾個、累積；下方地圖
    // 地圖範圍＝目前畫面上看得到的區域（村里選了縣市時只算那個縣市）放到影片裡；從拉桿目前的位置播到最後，速度跟播放列
    // 比例（直式 9:16／方形 1:1）記在 localStorage fog-video；暱稱存在成就卡片的選項（fog-report）
    const VIDEO_KEY = 'fog-video';
    const VIDEO_SIZES = { portrait: [1080, 1920], square: [1080, 1080] };
    const VFONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
    const loadVideoPref = () => { try { return JSON.parse(localStorage.getItem(VIDEO_KEY)) || {}; } catch (e) { return {}; } };
    const saveVideoPref = o => { try { localStorage.setItem(VIDEO_KEY, JSON.stringify(o)); } catch (e) { /* 存不了只影響下次 */ } };
    let video = null;   // { ratio, fmt（videoSupport 的結果）, abort（製作中）, blob, name }

    const frameMs = () => (play.mode === 'year' ? 1000 : 500) / play.speed;
    function videoRange() {
        const from = play.i >= play.frames.length - 1 ? defaultStart() : play.i;
        const n = play.frames.length - from;
        return { from, n, ms: n * frameMs() + 3000 };   // 第一格多停 1 秒、最後一格多停 2 秒
    }

    async function openVideo() {
        if (!play) return;
        pausePlay();
        const box = modal.querySelector('.ex-video');
        const pref = loadVideoPref();
        const v = video = { ratio: VIDEO_SIZES[pref.ratio] ? pref.ratio : 'portrait', fmt: null, abort: null, blob: null, name: '' };
        if (!box._bound) {
            box._bound = true;
            box.addEventListener('click', e => {
                const b = e.target.closest('button');
                if (!b || !video) return;
                if (b.dataset.vratio) { video.ratio = b.dataset.vratio; saveVideoPref({ ...loadVideoPref(), ratio: video.ratio }); syncVideo(); }
                else if (b.dataset.vact === 'start') runVideo();
                else if (b.dataset.vact === 'share') shareVideo();
                else if (b.dataset.vact === 'close') closeVideo();
            });
            box.addEventListener('input', e => { if (e.target.classList.contains('ex-video-nick')) saveNickname(e.target.value.trim()); });
            // 地圖的拖曳、點選、滾輪縮放不要穿透面板
            for (const ev of ['pointerdown', 'pointerup', 'wheel', 'dblclick']) box.addEventListener(ev, e => e.stopPropagation());
        }
        const fmt = v.fmt = await videoSupport(...VIDEO_SIZES.portrait);
        if (video !== v || !play) return;   // 等待時已關掉
        if (!fmt) {
            box.innerHTML = `<b class="ex-video-title">🎬 匯出影片</b><p class="ex-video-note">這個瀏覽器不支援製作影片，請改用新版的 Chrome、Edge 或 iPhone 的 Safari。</p>
                <div class="ex-video-btns"><button type="button" data-vact="close">關閉</button></div>`;
            box.hidden = false;
            return;
        }
        const { from, ms } = videoRange();
        box.innerHTML = `<b class="ex-video-title">🎬 匯出影片</b>
            <label class="ex-video-row"><span>標題</span><input type="text" class="ex-video-nick" maxlength="24" placeholder="例如：${esc(NICK_SAMPLE)}"></label>
            <div class="ex-video-row"><span>比例</span><span class="ex-seg" role="group" aria-label="影片比例">
                <button type="button" data-vratio="portrait">直式 9:16</button><button type="button" data-vratio="square">方形 1:1</button></span></div>
            <p class="ex-video-note">從 ${esc(play.frames[from].label)} 播到最後（${play.speed}×），影片約 ${Math.round(ms / 1000)} 秒，${fmt.ext.toUpperCase()} 格式。
                地圖範圍是目前畫面上看得到的地方。${fmt.engine === 'recorder' ? '這個瀏覽器要即時錄製，會花和影片一樣長的時間，請不要切換到別的 App。' : ''}</p>
            <div class="ex-video-progress" hidden><i></i></div>
            <div class="ex-video-btns">
                <button type="button" data-vact="start" class="primary">${fmt.engine === 'recorder' ? '開始錄製' : '產生影片'}</button>
                <button type="button" data-vact="close">取消</button>
            </div>`;
        box.querySelector('.ex-video-nick').value = loadNickname();
        syncVideo();
        box.hidden = false;
    }
    function syncVideo() {
        modal.querySelectorAll('.ex-video [data-vratio]').forEach(b => b.classList.toggle('active', b.dataset.vratio === video.ratio));
    }
    function closeVideo() {
        if (!video) return;
        if (video.abort) video.abort.abort();
        video = null;
        modal.querySelector('.ex-video').hidden = true;
    }

    async function runVideo() {
        const box = modal.querySelector('.ex-video');
        const svg = modal.querySelector('svg');
        const nick = box.querySelector('.ex-video-nick').value.trim();
        const [W, H] = VIDEO_SIZES[video.ratio];
        const { from, n } = videoRange();
        const area = videoMapArea(svg);
        const bar = box.querySelector('.ex-video-progress'), fill = bar.querySelector('i');
        box.querySelectorAll('.ex-video-row, .ex-video-note').forEach(x => { x.hidden = true; });
        bar.hidden = false;
        const v = video;
        // 用實際要輸出的尺寸再確認一次（有些電腦的硬體編碼器只接受部分尺寸；不行才退回即時錄製）
        if (v.fmt.engine === 'webcodecs') {
            const f = await videoSupport(W, H);
            if (video !== v) return;
            if (f) v.fmt = f;
        }
        const doing = v.fmt.engine === 'recorder' ? '錄製中' : '產生中';
        box.querySelector('.ex-video-btns').innerHTML = `<span class="ex-video-status">${doing} 0%</span><button type="button" data-vact="close">取消</button>`;
        const status = box.querySelector('.ex-video-status');
        v.abort = new AbortController();
        const ms = frameMs();
        const t0 = performance.now();
        try {
            const out = await makeVideo(v.fmt, {
                width: W, height: H, count: n, signal: v.abort.signal,
                holdMs: i => ms + (i === 0 ? 1000 : 0) + (i === n - 1 ? 2000 : 0),
                draw: (ctx, i) => drawVideoFrame(ctx, svg, from + i, { W, H, nick, area }),
                onProgress: (r, k) => {
                    fill.style.width = `${Math.round(r * 100)}%`;
                    status.textContent = `${doing}：第 ${k} / ${n} 格（${Math.round(r * 100)}%），已花 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
                },
            });
            if (video !== v) return;
            v.abort = null;
            v.blob = out.blob;
            v.name = `台灣旅遊護照足跡動畫-${todayStr()}.${out.ext}`;
            // 錄完要使用者再按一次才分享（手機的分享選單要剛點過按鈕才能開）
            box.querySelector('.ex-video-btns').innerHTML = `<span class="ex-video-status">完成（${(out.blob.size / 1048576).toFixed(1)} MB，花 ${((performance.now() - t0) / 1000).toFixed(1)} 秒）</span>
                <button type="button" data-vact="share" class="primary">${canShareFile() ? '📤 分享／儲存' : '⬇ 下載影片'}</button>
                <button type="button" data-vact="close">關閉</button>`;
        } catch (e) {
            if (video !== v || (e && e.name === 'AbortError')) return;
            v.abort = null;
            box.querySelector('.ex-video-btns').innerHTML = `<span class="ex-video-status">❌ 影片製作失敗：${esc(e && e.message || String(e))}</span>
                <button type="button" data-vact="close">關閉</button>`;
        }
    }
    async function shareVideo() {
        const { blob, name } = video;
        const file = new File([blob], name, { type: blob.type });
        if (canShareFile(file)) {
            try { await navigator.share({ files: [file], title: name }); return; }
            catch (e) { if (e.name === 'AbortError') return; }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    /**
     * 影片裡地圖的範圍（地圖座標 [x0, y0, x1, y1]）：畫面上看得到、而且不是淡灰（其他縣市）的區域外框，四周留一點空。
     * 畫面上有本島時只框本島框（含澎湖、綠島、蘭嶼）內的部分：金門、馬祖、北方三島在框外，
     * 一起框進來地圖會小很多（2026-11-27 維護者回饋：電腦畫面寬、整個框進直式影片太小）。只看金門或馬祖時照畫面範圍
     */
    function videoMapArea(svg) {
        const { r, vx, vy, s, ox, oy } = viewOf(svg);
        let v0 = vx - ox * s, w0 = vy - oy * s, v1 = v0 + r.width * s, w1 = w0 + r.height * s;
        const items = svg._cv.items.filter(x => !(play.dim && play.dim.has(x.code)));
        const hit = (b, a0, b0, a1, b1) => !(b[2] < a0 || b[0] > a1 || b[3] < b0 || b[1] > b1);
        const mb = regionBox(REGIONS.main.box);
        const m0 = Math.max(v0, mb.x), n0 = Math.max(w0, mb.y), m1 = Math.min(v1, mb.x + mb.w), n1 = Math.min(w1, mb.y + mb.h);
        if (m1 > m0 && n1 > n0 && items.some(x => hit(x.box, m0, n0, m1, n1))) [v0, w0, v1, w1] = [m0, n0, m1, n1];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const x of items) {
            const b = x.box;
            if (!hit(b, v0, w0, v1, w1)) continue;
            x0 = Math.min(x0, Math.max(b[0], v0)); y0 = Math.min(y0, Math.max(b[1], w0));
            x1 = Math.max(x1, Math.min(b[2], v1)); y1 = Math.max(y1, Math.min(b[3], w1));
        }
        if (!(x1 > x0 && y1 > y0)) [x0, y0, x1, y1] = [v0, w0, v1, w1];
        const m = Math.max(x1 - x0, y1 - y0) * 0.03;
        return [x0 - m, y0 - m, x1 + m, y1 + m];
    }

    /** 影片的一格：底色（海）、上方文字、下方地圖（顏色跟著目前的淺色／深色主題） */
    function drawVideoFrame(ctx, svg, i, { W, H, nick, area }) {
        // 畫面上的地圖不動（2026-11-27 維護者回饋：電腦上地圖跟著一格一格走，看起來像在錄影），只把這一格的上色借給影片用
        const css = getComputedStyle(svg), v = n => css.getPropertyValue(n).trim();
        const t = frameText(i);
        const u = W / 400;   // 影片 1 個「畫面點」幾個像素（線寬、字級以 400 點寬的手機畫面為準）
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = v('--c-sidebar-bg');
        ctx.fillRect(0, 0, W, H);
        // 上方文字：標題（暱稱，沒填就不印）、年月、範圍・＋幾個・累積
        const pad = 22 * u;
        let y = pad;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        const text = (str, size, weight, color) => {
            ctx.font = `${weight} ${size * u}px ${VFONT}`;
            ctx.fillStyle = color;
            ctx.fillText(str, pad, y, W - pad * 2);
            y += size * u * 1.35;
        };
        if (nick) { text(nick, 24, 'bold', v('--c-text')); y += 4 * u; }
        text(t.date, 18, 'bold', v('--c-text'));
        text(t.line, 13, 'normal', v('--c-text-muted'));
        const top = y + 8 * u, foot = 26 * u;
        // 頁尾：網站名稱
        ctx.font = `normal ${10 * u}px ${VFONT}`;
        ctx.fillStyle = v('--c-text-muted');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('台灣旅遊護照', W - pad, H - 10 * u);
        // 地圖：area 放進 (pad/2, top)–(W - pad/2, H - foot)，置中
        const aw = W - pad, ah = H - foot - top;
        const [x0, y0, x1, y1] = area;
        const sm = Math.max((x1 - x0) / aw, (y1 - y0) / ah);   // 每個像素幾個地圖單位
        const mx0 = (x0 + x1) / 2 - (W / 2) * sm, my0 = (y0 + y1) / 2 - (ah / 2) * sm;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top, W, ah);
        ctx.clip();
        const keep = svg._cv.fills;
        svg._cv.fills = fillsAt(i);
        try { paintMapTo(ctx, svg, { mx0, my0, s: sm * u, dpr: u, w: W / u, h: ah / u, tx: 0, ty: top }); }
        finally { svg._cv.fills = keep; }
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    /** 第 i 格的上色：之前已解鎖淺橘、這一格新解鎖橘 */
    function fillsAt(i) {
        const f = play.frames[i], fills = new Map();
        for (const t of playItems()) if (t.first < f.end) fills.set(t.code, t.first >= f.start ? PLAY_NOW_COLOR : PLAY_PAST_COLOR);
        return fills;
    }
    /** 播放範圍的總面積（km²）：鄉鎮或全島＝全部縣市；村里選了縣市＝那個縣市（或合併的一組） */
    function scopeArea() {
        let a = 0;
        for (const c of state.idx.county.values()) if (play.level === 'town' || play.county === 'all' || countyOf(c.code) === play.county) a += c.area || 0;
        return a;
    }
    /**
     * 第 i 格的文字：date「2026 年 11 月」；line「北北基・＋4 個村里・累積 1,356 個」（面積模式：累積 12.3% 面積）；
     * add「＋4 個村里」、cum「累積…」、where「北北基」給匯出影片分開排版
     */
    function frameText(i) {
        const f = play.frames[i];
        let n = 0, area = 0;
        for (const t of playItems()) if (t.first < f.end) { n++; area += t.area || 0; }
        const all = scopeArea();
        const cum = state.metric === 'area' && all > 0 ? `累積 ${fmtPct(area / all)} 面積` : `累積 ${n.toLocaleString()} 個`;
        const where = play.level === 'village' ? (play.county === 'all' ? '全島' : scopeName(play.county)) : '';
        const add = `＋${f.n.toLocaleString()} 個${UNIT_LABEL[play.level]}`;
        return { date: f.label, add, cum, where, line: [where, add, cum].filter(Boolean).join('・') };
    }

    /**
     * 水系圖層（data/map_water.json，tools/export_water.py 產生）：主要河川主流、大型水庫與湖泊，只畫在放大彈窗（小地圖太小會變雜）。
     * 第一次開彈窗時才下載；失敗就不畫，不影響地圖。工具列「💧」開關（預設關，記在 localStorage）；關著時不下載
     */
    function loadWater(svg) {
        if (!waterOn() || svg._water || svg._waterLoading) return;
        svg._waterLoading = getMap('water').then(w => {
            svg._water = [...w.rivers, ...w.lakes].filter(x => x.d).map(x => ({ p2d: new Path2D(x.d), box: pathBox(x.d) }));
            if (svg._cv && !modal.hidden && !svg._dragging) paintCanvas(svg);
        }).catch(() => { svg._waterLoading = null; });
    }

    // 放大彈窗換上色方式：重畫區域，保留目前的縮放位置
    async function recolorModal() {
        const svg = modal.querySelector('svg'), level = svg._level, vb = svg._vb;
        if (!level) return;
        const m = await getMap(level);
        if (play) return;   // 等地圖時又按了播放動畫：不要蓋掉播放的上色
        const [y0, y1] = drawMap(svg, m, level);
        if (vb) svg._draw(vb);
        modal.querySelector('.ex-modal-legend').innerHTML = legendHtml(y0, y1, level);
    }

    function closeModal() {
        exitPlay();   // 下次打開回到一般地圖
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

    function badgeSvg(a) {
        // 未達成用主題色（CSS 變數，SVG 以 style 套用才吃得到 var()）
        const [color, ring] = badgeColors(a) || ['var(--c-badge-off)', 'var(--c-badge-off-ring)'];
        const [outer, inner] = shapeOf(a.group);
        const icon = ICONS[a.icon] || ICONS.star;
        return `<svg viewBox="0 0 80 80" class="ex-badge-svg" aria-hidden="true">
            <path d="${outer}" style="fill:${ring}"/><path d="${inner}" style="fill:${color}"/>
            <g transform="translate(24 24) scale(1.333)"><path d="${icon}" fill="#fff" fill-rule="evenodd" opacity="${a.done ? 1 : 0.85}"/></g>
        </svg>`;
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

    /** 展開成就區並捲到某一類（目錄與總覽共用）：只展開這一類，其餘收起，方便換到別類 */
    function jumpToGroup(g) {
        const sec = root.querySelector('#ex-badges-sec');
        sec.open = true;
        const group = root.querySelector(`#ach-${g}`);
        if (!group) return;
        root.querySelectorAll('.ex-badge-group').forEach(d => { d.open = d === group; });
        // 等展開後的版面更新再捲動；距離常有上萬像素，平滑捲動途中版面高度一變就會停錯位置，所以直接跳過去，再閃一下標示
        setTimeout(() => {
            group.scrollIntoView({ block: 'start' });
            group.classList.remove('ex-flash');
            void group.offsetWidth;
            group.classList.add('ex-flash');
        }, 0);
    }

    /** 回到成就徽章的總覽（各類進度環）：收起成就區與各類，捲到成就區 */
    function showBadgeOverview() {
        const sec = root.querySelector('#ex-badges-sec');
        sec.open = false;
        root.querySelectorAll('.ex-badge-group').forEach(d => { d.open = false; });
        setTimeout(() => sec.scrollIntoView({ block: 'start' }), 0);
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
        // 各類預設收起；重新計算（切換模式、手動加入）時保留使用者展開的類別
        const wasOpen = new Set([...box.querySelectorAll('.ex-badge-group[open]')].map(d => d.id));
        box.innerHTML = groups.map(g => {
            const items = list.filter(a => a.group === g);
            if (!items.length) return '';
            if (g === 'festival') {
                return `<details class="ex-badge-group" id="ach-${g}"${wasOpen.has(`ach-${g}`) ? ' open' : ''}>
                    <summary class="ex-badge-group-title g-${g}">${GROUP_LABEL[g]}
                        <span>${items.filter(a => a.done).length} / ${items.length}</span></summary>
                    ${items.map(festivalCard).join('')}</details>`;
            }
            const stamps = items.filter(a => a.cells), cards = items.filter(a => !a.cells);
            const sections = [...new Set(cards.map(a => a.section || ''))];
            const card = COMPACT_GROUPS.has(g) ? a => badgeCard(a, true) : a => badgeCard(a);
            const grids = sections.map(s => {
                const sc = cards.filter(a => (a.section || '') === s);
                const grid = `<div class="ex-badge-grid${COMPACT_GROUPS.has(g) ? ' compact' : ''}">${sc.map(card).join('')}</div>`;
                // 鐵道的「路線制霸」預設收起（常看的是下方的車站集點卡），點標題展開
                if (s === '路線制霸') {
                    return `<details class="ex-route-fold"><summary class="ex-badge-sub">${esc(s)}<span>${sc.filter(a => a.done).length} / ${sc.length}</span>
                        <span class="ex-route-hint">展開</span></summary>${grid}</details>`;
                }
                return `${s ? `<div class="ex-badge-sub">${esc(s)}<span>${sc.filter(a => a.done).length} / ${sc.length}</span></div>` : ''}${grid}`;
            }).join('');
            return `<details class="ex-badge-group" id="ach-${g}"${wasOpen.has(`ach-${g}`) ? ' open' : ''}>
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
                if (el) openDetail(el.dataset.id, cell ? [+cell.dataset.lat, +cell.dataset.lng] : null, cell ? +cell.dataset.code : null);
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
            else if (t.dataset.madd && dmodal._addInfo) openAddForm(t.closest('.ex-madd'), dmodal._addInfo);
            else if (t.dataset.mpick !== undefined) openPicker(t.closest('.ex-madd'));
            else if (t.dataset.mrow !== undefined) {
                const r = dmodal._rows[+t.dataset.mrow];
                // 從搜尋選單或最上方帶入的按鈕選的：表單接在加入鈕那一列（選單本身會被 openAddForm 收掉）
                const anchor = t.closest('.ex-mpick, .ex-mpick-box') ? dmodal.querySelector('.ex-mpick-box') : t.closest('.ex-drow');
                if (r && r.add) openAddForm(anchor, r.add);
            }
            else if (t.dataset.mdel !== undefined) deleteManual(+t.dataset.mdel);
            else if (t.dataset.mok !== undefined) submitAddForm(t.closest('.ex-mform'));
            else if (t.dataset.mcancel !== undefined) t.closest('.ex-mform').remove();
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dmodal.hidden) closeDetail(); });
    }

    // pick：集點卡上點的格子編號（車站、山），「手動加入」直接帶入這一站，不用再搜尋
    async function openDetail(id, focus = null, pick = null) {
        if (!dmodal) buildDetailModal();
        dmodal._pick = pick;
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
        body.classList.toggle('name-first', d.id === 'regular' || isPointDetail(d.id) || !!d.nameFirst); // 第一欄是較長的名稱（村里、山名、站名）
        body.classList.toggle('two-col', d.columns.length === 2);
        const ps = Object.values(POINT_STAMPS).find(p => d.id.startsWith(p.prefix));
        // 手動紀錄：地點類在最下方「我有去過，手動加入！」；集點卡在未到的列旁「＋ 我去過」；手動紀錄的列可刪除
        const canManual = !!manualApi;
        const addBox = canManual && d.add && !(d.add.years && !d.add.years.length) ? `<div class="ex-madd">
            <button type="button" class="ex-mbtn primary" data-madd="main">✋ ${d.add.years ? '手動加入其他年份' : rows.some(r => r.hit) ? '再加一筆手動紀錄' : '我有去過，手動加入！'}</button></div>` : '';
        dmodal._addInfo = d.add || null;
        const withAct = canManual && rows.some(r => r.add || r.manual !== undefined);
        body.classList.toggle('with-act', withAct);
        if (!rows.length) { body.innerHTML = `<div class="ex-empty">${ps ? `還沒有${ps.verb}任何一${ps.unit}` : d.geo ? '還沒有在這裡的足跡' : '沒有資料'}</div>${addBox}`; return; }
        const act = (r, i) => !withAct ? '' : r.manual !== undefined
            ? `<span class="ex-dact"><button type="button" class="ex-mbtn" data-mdel="${r.manual}" title="刪除這筆手動紀錄">🗑 刪除</button></span>`
            : r.add ? `<span class="ex-dact"><button type="button" class="ex-mbtn" data-mrow="${i}">＋ 我去過</button></span>` : '<span class="ex-dact"></span>';
        dmodal._rows = rows;
        // 集點卡（車站、山）：明細最上方放「手動加入」，可搜尋未到的項目（未到的列排在最下面，不好找）
        // 從集點卡或地圖點了某個未到的站：直接帶入那一站，按下去只要選日期
        const what = ps && ps.unit === '座' ? '山' : '車站';
        const picked = dmodal._pick != null ? rows.findIndex(r => r.add && r.add.target === `${d.id}#${dmodal._pick}`) : -1;
        const pickBox = !(canManual && ps && rows.some(r => r.add)) ? ''
            : picked >= 0 ? `<div class="ex-madd ex-mpick-box">
                <button type="button" class="ex-mbtn primary" data-mrow="${picked}">✋ 手動加入「${esc(rows[picked].add.label)}」</button>
                <button type="button" class="ex-mbtn" data-mpick>選其他${what === '山' ? '山' : '站'}</button></div>`
            : `<div class="ex-madd ex-mpick-box">
                <button type="button" class="ex-mbtn primary" data-mpick>✋ 手動加入${what}</button></div>`;
        const head = `<div class="ex-drow ex-dhead">${d.columns.map(c => `<span>${esc(c)}</span>`).join('')}${withAct ? '<span class="ex-dact"></span>' : ''}</div>`;
        body.innerHTML = pickBox + head + rows.map((r, i) => {
            const cells = r.cells.map(c => `<span>${esc(c)}</span>`).join('') + act(r, i);
            if (!r.items || !r.items.length) return `<div class="ex-drow${r.hit ? '' : ' miss'}${r.manual !== undefined ? ' manual' : ''}">${cells}</div>`;
            return `<details class="ex-dfold${r.hit ? '' : ' miss'}"><summary class="ex-drow">${cells}</summary>
                <div class="ex-ditems"><small>${esc(r.items_label || '')}</small>
                ${r.items.map(x => `<span class="ex-chip on">${esc(x)}</span>`).join('')}</div></details>`;
        }).join('') + addBox;
        body.scrollTop = 0;
    }

    // ---------- 手動紀錄（加入表單、刪除） ----------

    const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

    /** 在 anchor 後面打開加入表單（同時只開一個） */
    function openAddForm(anchor, info) {
        dmodal.querySelectorAll('.ex-mform').forEach(f => f.remove());
        const f = document.createElement('div');
        f.className = 'ex-mform';
        if (info.years) {
            // 節慶活動：選年份（以那一屆的開城日記錄）
            f.innerHTML = `<div class="ex-mform-title">✋ 手動加入「${esc(info.label)}」</div>
                <label>哪一年 <select>${info.years.slice().reverse().map(y => `<option value="${y.date}">${y.year} 年（${y.range}）</option>`).join('')}</select></label>
                <div class="ex-mform-hint">記在那一屆的開城日；只算這個成就，不會解鎖村里。</div>
                <div class="ex-mform-msg" hidden></div>
                <div class="ex-mform-btns"><button type="button" class="ex-mbtn primary" data-mok>加入</button>
                    <button type="button" class="ex-mbtn" data-mcancel>取消</button></div>`;
            f._info = info;
            anchor.after(f);
            f.querySelector('select').focus();
            f.scrollIntoView({ block: 'nearest' });
            return;
        }
        f.innerHTML = `<div class="ex-mform-title">✋ 手動加入「${esc(info.label)}」</div>
            <label>造訪日期 <input type="date" max="${todayStr()}"></label>
            <div class="ex-mform-hint">日期可以不填：不填仍算去過，但不參與和日期有關的成就（例如每年新解鎖）。${info.area ? '<br>以範圍判定的地點只解鎖這個成就，不會解鎖村里。' : '<br>也會解鎖這個地點所在的村里。'}</div>
            <div class="ex-mform-msg" hidden></div>
            <div class="ex-mform-btns"><button type="button" class="ex-mbtn primary" data-mok>加入</button>
                <button type="button" class="ex-mbtn" data-mcancel>取消</button></div>`;
        f._info = info;
        anchor.after(f);
        f.querySelector('input').focus();
        f.scrollIntoView({ block: 'nearest' });
    }

    /** 集點卡的搜尋選單：輸入名稱篩選未到的項目，點一個就在下方打開加入表單 */
    const PICK_MAX = 30;
    function openPicker(anchor) {
        dmodal.querySelectorAll('.ex-mform').forEach(f => f.remove());
        const cands = dmodal._rows.map((r, i) => ({ r, i })).filter(x => x.r.add);
        const isPeak = (dmodal._data.id || '').startsWith(POINT_STAMPS.peak.prefix);
        const f = document.createElement('div');
        f.className = 'ex-mform ex-mpick';
        f.innerHTML = `<div class="ex-mform-title">✋ 手動加入${isPeak ? '山' : '車站'}：先選${isPeak ? '哪一座' : '哪一站'}</div>
            <input type="search" placeholder="輸入${isPeak ? '山名' : '站名'}搜尋（共 ${cands.length} ${isPeak ? '座' : '站'}未${isPeak ? '登頂' : '到'}）" autocomplete="off">
            <div class="ex-mpick-list"></div>
            <div class="ex-mform-btns"><button type="button" class="ex-mbtn" data-mcancel>取消</button></div>`;
        const list = f.querySelector('.ex-mpick-list');
        const draw = () => {
            const norm = s => s.replace(/臺/g, '台');   // 站名用「臺」，使用者多半打「台」
            const q = norm(f.querySelector('input').value.trim());
            const hit = q ? cands.filter(x => norm(x.r.cells[0]).includes(q)) : cands;
            list.innerHTML = hit.slice(0, PICK_MAX).map(x => `<button type="button" class="ex-mbtn" data-mrow="${x.i}">${esc(x.r.cells[0])}</button>`).join('')
                + (hit.length > PICK_MAX ? `<small>還有 ${hit.length - PICK_MAX} 筆，請輸入更多字縮小範圍</small>` : '')
                + (!hit.length ? '<small>找不到符合的名稱</small>' : '');
        };
        f.querySelector('input').addEventListener('input', draw);
        draw();
        anchor.after(f);
        f.querySelector('input').focus();
    }

    async function submitAddForm(f) {
        const date = f.querySelector('input, select').value;
        const msg = f.querySelector('.ex-mform-msg');
        if (date && date > todayStr()) { msg.hidden = false; msg.textContent = '日期不能在未來'; return; }
        f.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const err = await manualApi.add(f._info, date);
        if (err) {
            f.querySelectorAll('button').forEach(b => { b.disabled = false; });
            msg.hidden = false; msg.textContent = err;
        }
        // 成功時重新計算 → setData 會重開這個明細
    }

    async function deleteManual(ref) {
        const it = manualApi.item(ref);
        if (!it) return;
        const day = Number.isFinite(it.time) ? fmtDate(it.time) : '沒有日期';
        if (!confirm(`刪除這筆手動紀錄？\n「${it.label}」（${day}）`)) return;
        await manualApi.remove(ref);
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
            L.tileLayer(TILE.url, TILE.options).addTo(dmap);   // 圖磚設定在 js/tiles.js
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
            [...geo.marks].sort((x, y) => x[3] - y[3]).forEach(([lat, lng, label, done, code]) => {
                const isFocus = focus && Math.abs(focus[0] - lat) < 1e-6 && Math.abs(focus[1] - lng) < 1e-6;
                const mk = L.circleMarker([lat, lng], isFocus
                    ? { radius: 9, color: themeColor('--c-text-strong'), weight: 2.5, fillColor: done ? '#ff4d1a' : '#9ca3af', fillOpacity: 1 }
                    : done
                    ? { radius: 6, color: '#fff', weight: 1.5, fillColor: '#ff4d1a', fillOpacity: 1 }
                    : { radius: 4, color: '#6b7280', weight: 1, fillColor: '#9ca3af', fillOpacity: 0.7 })
                    .bindTooltip(`${esc(label)}${done ? `（已${ps ? ps.verb : '達成'}）` : ''}`).addTo(dmapLayer);
                if (isFocus) focusMarker = mk;
                // 點地圖上未到的點：最上方的「手動加入」改成帶入這一站
                if (!done && code != null && manualApi) mk.on('click', () => { dmodal._pick = code; drawDetail(); });
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
            ? `<span class="ex-stamp-cell${c.done ? ' on' : ''}${c.tier ? ' g-' + c.tier : ''}${c.colors ? ' lined' : ''}"${lineStyle(c)} data-lat="${c.lat}" data-lng="${c.lng}" data-code="${c.code}" title="${c.ele != null ? `#${c.code} ${esc(c.name)}（${Number(c.ele).toLocaleString()} m）` : esc(c.name) + (c.grade ? `（${c.grade}站）` : '') + (c.lines ? `（${c.lines.join('、')}）` : '')}：${c.done ? (c.date ? fmtDate(c.date) + ' ' + ps.verb : `已${ps.verb}（時間不明）`) : '尚未' + ps.verb}">
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

    // 節慶與民俗活動集章卡：像素場景（依 a.scene）＋蓋到的戳章（新到舊；年份型或地點型，戳章上中下的字由計算給）
    function festivalCard(a) {
        const other = a.kind === 'places' ? '其他地點' : '其他年份';
        const stamps = a.cells.map(c => `<span class="ex-fest-stamp" style="--tilt:${stampTilt(c.label)}deg"
            title="${esc(c.name || c.label + ' 年')}：${c.date ? fmtDate(c.date) : '時間不明'}${c.bottom === '✋ 手動' ? '（手動加入）' : ''}">
            ${c.top ? `<small>${esc(c.top)}</small>` : ''}<b>${esc(c.label)}</b>${c.bottom ? `<small>${esc(c.bottom)}</small>` : ''}</span>`).join('');
        return `<div class="ex-badge ex-fest done clickable" data-id="${esc(a.id)}" role="button" tabindex="0" title="${esc(a.desc)}
（點擊看明細、手動加入${other}）">
            <div class="ex-fest-scene">${sceneSvg(a.scene, 'ex-fest-svg')}
                <div class="ex-fest-title"><b>${sceneEmoji(a.scene)} ${esc(a.name)}</b><span>${esc(a.summary)}</span></div>
                <div class="ex-fest-stamps">${stamps}</div></div>
            <div class="ex-badge-desc">${esc(a.desc)}</div>
            <div class="ex-badge-more">📋 看明細・手動加入${other}</div>
        </div>`;
    }

    // 切換主題：累積線、明細地圖標記用到主題色，重畫
    document.addEventListener('themechange', () => {
        if (!state.data) return;
        renderYearly();
        if (dmodal && !dmodal.hidden && dmodal._data) drawDetailMap(dmodal._data.geo);
        // 迷霧地圖的 canvas 用到主題色：小地圖、放大彈窗都重畫
        const isvg = root.querySelector('#ex-map'), msvg = modal && modal.querySelector('svg');
        if (isvg && isvg._cv && isvg._canvas && !isvg._canvas.hidden) paintCanvas(isvg);
        if (msvg && msvg._cv && !modal.hidden) paintCanvas(msvg);
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
            if (modal && !modal.hidden) openModal(true);
            // 明細開著（例如剛手動加入或刪除）：用新結果重開同一個明細
            if (dmodal && !dmodal.hidden && dmodal._id) {
                const keepScroll = dmodal.querySelector('.ex-dmodal-body').scrollTop;
                openDetail(dmodal._id).then(() => { dmodal.querySelector('.ex-dmodal-body').scrollTop = keepScroll; });
            }
        },
        jumpToGroup,
        showBadgeOverview,
        /** 目前的計算結果（成就報表用） */
        data() { return state.data; },
        /** 各大類的進度（給目錄用） */
        groups() {
            if (!state.data) return [];
            return Object.keys(GROUP_LABEL).map(g => ({ g, label: GROUP_LABEL[g], ...groupProgress(state.data.achievements, g) }))
                .filter(x => x.total !== undefined);
        },
    };
}
