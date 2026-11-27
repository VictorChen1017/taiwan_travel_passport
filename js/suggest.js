// 旅行建議（docs/SPEC.md §15.7「旅行建議」）：從去過的鄉鎮往外，隨機抽一個相鄰、還沒去過的鄉鎮，
// 列出去那裡可以解鎖的目標（百岳、小百岳、車站、景點、節慶）與解鎖後的連帶進度，做成一張「探索任務卡」
//
// 資料：data/suggest.json（鄉鎮相鄰表、各鄉鎮的目標；tools/export_static.php 匯出）＋ map_town.json、achievements.json、rail.json
// 記憶：localStorage fog-suggest（目前這張卡的鄉鎮、是否納入去過的鄉鎮）、fog-suggest-wish（想去清單）
// 抽中的鄉鎮會一直沿用（下次打開還是同一張），按「換一個」才重抽

import { Painter, themeColors, deliverFile, loadNickname } from './report.js';
import { canShareFile } from './device.js';
import { SUGGEST_PICK_COLOR, SUGGEST_VISITED_COLOR, GROUP_COLOR } from './shared.js';

const PREF_KEY = 'fog-suggest';
const WISH_KEY = 'fog-suggest-wish';
const VIA = { b: '陸路', l: '陸路', s: '搭船', a: '搭飛機' };
// 目標分組（順序＝卡片上的順序）
const KINDS = [
    ['peak', '⛰ 登山', 'peak'],
    ['st', '🚉 車站', 'rail'],
    ['place', '📸 景點', 'landmark'],  // 📍 留給 Google 地圖連結
    ['fest', '🎪 節慶與民俗活動', 'festival'],
    ['area', '🏞 國家公園・保護區範圍內', 'nature'],
];
// 可以單獨解鎖的目標（「也抽去過但目標還沒完成的鄉鎮」看這幾類；範圍跨很多鄉鎮的國家公園、每年一個章的節慶不算）
const MAIN_KINDS = new Set(['peak', 'st', 'place']);

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const mapsUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${(+lat).toFixed(6)},${(+lng).toFixed(6)}`;

function readJson(key, def) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? def; } catch (e) { return def; }
}
function writeJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 存不了只影響這次 */ }
}

// =====================================================================
// 計算（純函式，dev/selftest.js 也用）
// =====================================================================

/**
 * 候選鄉鎮
 * @param visited  去過的鄉鎮代碼 Set
 * @param neighbors  suggest.json 的 neighbors
 * @param opts.unfinished  去過但主要目標還沒完成的鄉鎮代碼 Set（有給就一起納入）
 * @param opts.countyOf  鄉鎮代碼 → 縣市代碼（邊境全被排除時退回同縣市沒去過、有鄰居的鄉鎮）
 * @param opts.allTowns  全部鄉鎮代碼
 * @returns { list: 代碼陣列（排序過）, fallback: 是否用了同縣市的退路 }
 */
export function candidatesOf(visited, neighbors, { unfinished = null, countyOf = null, allTowns = null } = {}) {
    const out = new Set();
    for (const v of visited) for (const n of Object.keys(neighbors[v] || {})) if (!visited.has(n)) out.add(n);
    if (unfinished) for (const t of unfinished) out.add(t);
    let fallback = false;
    if (!out.size && visited.size && countyOf && allTowns) {
        const cs = new Set([...visited].map(countyOf));
        // 沒有任何鄰居的（烏坵：一般人去不了）不抽
        for (const t of allTowns) if (!visited.has(t) && cs.has(countyOf(t)) && Object.keys(neighbors[t] || {}).length) out.add(t);
        fallback = out.size > 0;
    }
    return { list: [...out].sort(), fallback };
}

/** 整理計算結果與靜態資料，方便查目標狀態 */
function indexOf(stats, data) {
    const town = new Map(stats.towns.map(t => [t.code, t]));
    const county = new Map(stats.counties.map(c => [c.code, c]));
    const ach = new Map(stats.achievements.map(a => [a.id, a]));
    // 車站索引 → 它所在的集點卡格子（一站可能在好幾張卡）
    const stCells = new Map();
    for (const a of stats.achievements) {
        if (!a.cells) continue;
        for (const c of a.cells) {
            if (c.st === undefined) continue;
            if (!stCells.has(c.st)) stCells.set(c.st, []);
            stCells.get(c.st).push({ a, c });
        }
    }
    const placeDef = new Map(data.achievements.places.map(p => [p.id, p]));
    const festDef = new Map(data.achievements.festivals.map(f => [f.id, f]));
    const rep = new Map(data.mapTown.paths.map(p => [p.code, p.c || null]));
    return { town, county, ach, stCells, placeDef, festDef, rep };
}

/**
 * 一個鄉鎮裡的目標
 * @returns [{ kind, key, name, sub, done, lat, lng, add（手動加入的資料，不能加時為 null）, cards: [成就 id] }]
 */
function targetsOf(code, ix, data) {
    const out = [], seen = new Set();
    for (const g of data.suggest.targets[code] || []) {
        const key = g.join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const [kind, id, sub] = g;
        if (kind === 'peak') {
            const a = ix.ach.get(id), c = a?.cells?.find(x => x.code === sub);
            if (!c) continue;
            out.push({ kind, key, name: c.name, sub: `${a.name}・${Math.round(c.ele).toLocaleString()} m`, done: c.done, lat: c.lat, lng: c.lng,
                       add: { target: `${id}#${sub}`, label: c.name, lat: c.lat, lng: c.lng, area: false }, cards: [id] });
        } else if (kind === 'st') {
            const refs = ix.stCells.get(id), s = data.rail.stations[id];
            if (!refs || !s) continue;   // 不在任何集點卡（略過的站）
            const p0 = s.pts[0];
            out.push({ kind, key, name: s.name, sub: [...new Set(refs.map(r => r.a.name))].join('、'), done: refs.some(r => r.c.done),
                       lat: s.lat, lng: s.lng,
                       add: { target: `${refs[0].a.id}#${refs[0].c.code}`, label: s.name, lat: p0[0], lng: p0[1], area: false },
                       cards: [...new Set(refs.map(r => r.a.id))] });
        } else if (kind === 'place' || kind === 'area') {
            const a = ix.ach.get(id), p = ix.placeDef.get(id);
            if (!a || !p) continue;
            const at = p.points ? p.points[0] : p.rep;
            out.push({ kind, key, name: a.name, sub: a.section || '', done: a.done, lat: at?.[0], lng: at?.[1],
                       add: at ? { target: id, label: a.name, lat: at[0], lng: at[1], area: !p.points } : null, cards: [] });
        } else if (kind === 'fest') {
            const f = ix.festDef.get(id), a = ix.ach.get(id);
            if (!f) continue;
            if (sub) {
                const pl = f.places.find(x => x.code === sub);
                if (!pl) continue;
                out.push({ kind, key, name: pl.name, sub: f.name, done: !!a?.cells?.some(c => c.code === sub), lat: pl.lat, lng: pl.lng, add: null, cards: [] });
            } else {
                const pt = f.points[0];
                out.push({ kind, key, name: f.name, sub: a ? `活動期間有足跡，每年一個章（已去過 ${a.cells.length} 年）` : '活動期間有足跡，每年一個章',
                           done: false, lat: pt[0], lng: pt[1], add: null, cards: [] });
            }
        }
    }
    return out;
}

/** 解鎖這個鄉鎮（並完成目標）後的連帶進度：[{ text, hit（剛好達成） }] */
function progressOf(code, ix, targets) {
    const lines = [];
    const t = ix.town.get(code), c = t && ix.county.get(t.county);
    if (t && !t.unlocked) {
        lines.push({ text: `村里 ＋${t.villages.toLocaleString()} 個` });
        if (c) {
            if (!c.unlocked) lines.push({ text: `新縣市：${c.name}`, hit: true });
            const u = c.towns_unlocked + 1;
            lines.push({ text: `${c.name}鄉鎮 ${c.towns_unlocked}/${c.towns} → ${u}/${c.towns}${u === c.towns ? '・縣市制霸！' : ''}`, hit: u === c.towns });
        }
        // 鄉鎮里程碑：下一個還沒達成的
        const next = [...ix.ach.values()].filter(a => a.group === 'milestone' && a.section === '鄉鎮' && !a.done).sort((x, y) => x.target - y.target)[0];
        if (next) {
            const left = next.target - next.progress;
            lines.push({ text: left === 1 ? `里程碑「${next.name}」：解鎖這裡就達成！` : `里程碑「${next.name}」還差 ${left} 個`, hit: left === 1 });
        }
    }
    // 集點卡：這裡沒到過的格子
    const per = new Map();
    for (const x of targets) if (!x.done) for (const id of x.cards) per.set(id, (per.get(id) || 0) + 1);
    for (const [id, k] of per) {
        const a = ix.ach.get(id);
        if (!a) continue;
        const to = Math.min(a.target, a.progress + k);
        lines.push({ text: `${a.name} ${a.progress}/${a.target} → ${to}/${a.target}${to === a.target ? '・完成！' : ''}`, hit: to === a.target });
    }
    const places = targets.filter(x => !x.done && (x.kind === 'place' || x.kind === 'area')).length;
    if (places) lines.push({ text: `景點、國家公園成就 ＋${places} 個` });
    return lines;
}

// =====================================================================
// 任務卡圖片（Canvas；只含地名，不含日期與座標）
// =====================================================================

const W = 1080, PAD = 48, CW = W - PAD * 2;

function paintCard(g, env) {
    const C = g.c;
    const { town, county, map, bbox, visitedSet, targets, progress, via, nickname } = env;
    let y = PAD;
    g.text('🛂 台灣旅遊護照', PAD, y, { size: 26, weight: 'bold', color: C.accent });
    g.text('旅行建議', W - PAD, y + 6, { size: 18, color: C.muted, align: 'right' });
    y += 46;
    if (nickname) { g.text(nickname, PAD, y, { size: 30, weight: 'bold', color: C.text, maxW: CW }); y += 46; }
    g.text('🎲 下一站', PAD, y, { size: 24, color: C.muted });
    y += 38;
    g.text(`${county} ${town}`, PAD, y, { size: 56, weight: 'bold', color: C.strong, maxW: CW });
    y += 78;
    if (via) { y += g.para(via, PAD, y, CW, { size: 19, color: C.muted, lh: 1.45 }); y += 10; }

    // 小地圖
    if (map && bbox) {
        const maxH = 560;
        const s = Math.min(CW / bbox.w, maxH / bbox.h);
        const mw = bbox.w * s, mh = bbox.h * s, mx = PAD + (CW - mw) / 2;
        g.rect(PAD, y, CW, mh + 24, { fill: C.surface2, r: 16 });
        if (!g.dry) {
            const ctx = g.ctx;
            ctx.save();
            ctx.beginPath(); ctx.roundRect(PAD, y, CW, mh + 24, 16); ctx.clip();
            ctx.translate(mx, y + 12);
            ctx.scale(s, s);
            ctx.translate(-bbox.x, -bbox.y);
            ctx.lineWidth = 1.2 / s;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = C.fogLine;
            for (const p of map.paths) {
                const pp = new Path2D(p.d);
                ctx.fillStyle = p.code === env.code ? SUGGEST_PICK_COLOR : visitedSet.has(p.code) ? SUGGEST_VISITED_COLOR : C.fog;
                ctx.fill(pp);
                ctx.stroke(pp);
            }
            ctx.restore();
        }
        y += mh + 24 + 14;
        let lx = PAD;
        for (const [color, label] of [[SUGGEST_PICK_COLOR, '下一站'], [SUGGEST_VISITED_COLOR, '去過'], [C.fog, '還沒去']]) {
            g.rect(lx, y + 3, 18, 18, { fill: color, stroke: C.border, r: 3 });
            lx += 26 + g.text(label, lx + 26, y, { size: 17, color: C.muted }) + 24;
        }
        y += 40;
    }

    const section = (title, color) => {
        g.rect(PAD, y + 4, 5, 26, { fill: color || C.accent, r: 2 });
        g.text(title, PAD + 16, y, { size: 26, weight: 'bold', color: C.strong });
        y += 44;
    };
    if (progress.length) {
        section('解鎖之後', C.accent);
        for (const l of progress) {
            y += g.para(`${l.hit ? '★' : '・'} ${l.text}`, PAD + 6, y, CW - 6, { size: 21, color: l.hit ? C.accent : C.text, weight: l.hit ? 'bold' : 'normal', lh: 1.4 });
            y += 4;
        }
        y += 18;
    }
    const todo = targets.filter(x => !x.done);
    if (todo.length) {
        section(`可以解鎖的目標（${todo.length}）`, C.accent);
        const MAX = 24;
        let shown = 0;
        for (const [kind, label, group] of KINDS) {
            const list = todo.filter(x => x.kind === kind);
            if (!list.length || shown >= MAX) continue;
            g.text(label, PAD + 6, y, { size: 20, weight: 'bold', color: GROUP_COLOR[group] || C.muted });
            y += 32;
            for (const x of list) {
                if (shown >= MAX) break;
                const w = g.text(x.name, PAD + 26, y, { size: 21, color: C.text, maxW: CW * 0.55 });
                if (x.sub) g.text(x.sub, PAD + 26 + w + 14, y + 2, { size: 17, color: C.muted, maxW: CW - w - 50 });
                y += 32;
                shown++;
            }
            y += 6;
        }
        if (todo.length > shown) { g.text(`…還有 ${todo.length - shown} 個`, PAD + 26, y, { size: 18, color: C.muted }); y += 32; }
        y += 12;
    } else {
        section('可以解鎖的目標', C.accent);
        g.text('這裡沒有登山、車站、景點目標，解鎖鄉鎮與村里就是收穫！', PAD + 6, y, { size: 20, color: C.muted, maxW: CW });
        y += 44;
    }

    y += 4;
    g.rect(PAD, y, CW, 1, { fill: C.border });
    y += 18;
    g.text('從去過的地方往外抽一個相鄰的鄉鎮', PAD, y, { size: 16, color: C.muted });
    g.text('台灣旅遊護照', W - PAD, y, { size: 16, weight: 'bold', color: C.faint, align: 'right' });
    return Math.ceil(y + 24 + PAD - 8);
}

function renderCard(env) {
    const colors = themeColors();
    const g = new Painter(document.createElement('canvas').getContext('2d'), colors);
    const h = paintCard(g, env);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, h);
    g.ctx = ctx; g.dry = false;
    paintCard(g, env);
    return canvas;
}

// =====================================================================
// 面板
// =====================================================================

/**
 * @param getStats  () => 目前的計算結果
 * @param loadData  name => Promise<JSON>（data/ 底下的檔案）
 * @param addManual (info, date) => Promise<錯誤訊息或 null>（同成就明細的「＋ 我去過」，會重新計算）
 */
export function createSuggest({ getStats, loadData, addManual }) {
    let modal = null, data = null, loading = null;
    const pref = { town: null, unfinished: false, ...readJson(PREF_KEY, {}) };
    let wish = readJson(WISH_KEY, []);
    if (!Array.isArray(wish)) wish = [];
    let view = null;   // 目前畫面用到的資料（分享圖片用）
    let adding = null; // 正在輸入日期的目標 key

    const savePref = () => writeJson(PREF_KEY, { town: pref.town, unfinished: pref.unfinished });
    const saveWish = () => writeJson(WISH_KEY, wish);

    function ensureData() {
        if (!loading) {
            loading = Promise.all(['suggest.json', 'map_town.json', 'achievements.json', 'rail.json'].map(loadData))
                .then(([suggest, mapTown, achievements, rail]) => { data = { suggest, mapTown, achievements, rail }; })
                .catch(e => { loading = null; throw e; });
        }
        return loading;
    }

    function build() {
        modal = document.createElement('div');
        modal.className = 'rp-modal sg-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="rp-box sg-box" role="dialog" aria-modal="true" aria-labelledby="sg-title">
                <div class="rp-head">
                    <span id="sg-title" class="rp-title">🎲 旅行建議</span>
                    <span class="rp-hint">從你去過的鄉鎮往外，隨機抽一個相鄰、還沒去過的鄉鎮</span>
                    <button type="button" class="rp-x" data-act="close" title="關閉（Esc）">✕</button>
                </div>
                <div class="sg-main" id="sg-main"><div class="sg-empty">載入中…</div></div>
                <div class="rp-foot">
                    <label class="rp-check sg-opt"><input type="checkbox" id="sg-unfinished"> 也抽去過、但目標還沒完成的鄉鎮</label>
                    <button type="button" class="rp-btn" id="sg-wish">📌 加入想去清單</button>
                    <button type="button" class="rp-btn" id="sg-share">${canShareFile() ? '📤 分享／儲存' : '⬇ 下載圖片'}</button>
                    <button type="button" class="rp-btn primary" id="sg-next">🔄 換一個</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        const $ = id => modal.querySelector('#' + id);
        modal.addEventListener('click', onClick);
        modal.addEventListener('submit', onSubmit);
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal && !modal.hidden) close(); });
        $('sg-unfinished').addEventListener('change', e => { pref.unfinished = e.target.checked; savePref(); render(); });
        $('sg-next').addEventListener('click', () => { pick(); render(); });
        $('sg-wish').addEventListener('click', toggleWish);
        $('sg-share').addEventListener('click', share);
    }

    /** 目前的候選（每次依最新的計算結果重算） */
    function pool(stats, ix) {
        const visited = new Set(stats.towns.filter(t => t.unlocked).map(t => t.code));
        let unfinished = null;
        if (pref.unfinished) {
            unfinished = new Set();
            for (const t of visited) if (targetsOf(t, ix, data).some(x => !x.done && MAIN_KINDS.has(x.kind))) unfinished.add(t);
        }
        const r = candidatesOf(visited, data.suggest.neighbors, {
            unfinished, countyOf: c => ix.town.get(c)?.county, allTowns: stats.towns.map(t => t.code) });
        return { ...r, visited };
    }

    function pick() {
        const stats = getStats(), ix = indexOf(stats, data);
        const { list } = pool(stats, ix);
        const others = list.filter(c => c !== pref.town);
        const from = others.length ? others : list;
        pref.town = from.length ? from[Math.floor(Math.random() * from.length)] : null;
        adding = null;
        savePref();
    }

    function render() {
        const stats = getStats();
        const main = modal.querySelector('#sg-main');
        modal.querySelector('#sg-unfinished').checked = pref.unfinished;
        const ix = indexOf(stats, data);
        const P = pool(stats, ix);
        if (!P.visited.size) {
            view = null;
            main.innerHTML = `<div class="sg-empty">還沒有去過的鄉鎮。先匯入照片、時間軸，或在成就明細、迷霧地圖手動加入去過的地方，就能從那裡往外抽。</div>`;
            syncFoot(false);
            return;
        }
        if (!pref.town || !ix.town.has(pref.town)) pick();
        if (!pref.town) {
            view = null;
            main.innerHTML = `<div class="sg-empty">🎉 能抽的鄉鎮都去過了！${pref.unfinished ? '' : '可以勾選下方「也抽去過、但目標還沒完成的鄉鎮」。'}</div>`;
            syncFoot(false);
            return;
        }
        const code = pref.town, t = ix.town.get(code), c = ix.county.get(t.county);
        const targets = targetsOf(code, ix, data);
        const progress = progressOf(code, ix, targets);
        const nb = data.suggest.neighbors[code] || {};
        const nbVisited = Object.keys(nb).filter(n => P.visited.has(n));
        const nameOf = n => { const x = ix.town.get(n); return x ? `${ix.county.get(x.county)?.name || ''}${x.name}` : n; };
        // 怎麼去：依方式分組（陸路、搭船、搭飛機），去過的打勾；再加上只提示的航線
        const ways = { 陸路: [], 搭船: [], 搭飛機: [] };
        for (const [n, m] of Object.entries(nb)) ways[VIA[m]].push(`${nameOf(n)}${P.visited.has(n) ? ' ✓' : ''}`);
        for (const [m, from] of data.suggest.hints[code] || []) ways[VIA[m]].push(from);
        const via = nbVisited.length ? `相鄰：你去過的 ${nbVisited.map(nameOf).join('、')}` : '';
        const rp = ix.rep.get(code);
        const todo = targets.filter(x => !x.done), done = targets.filter(x => x.done);
        const inWish = wish.some(w => w.t === code);

        // 去過的鄉鎮：開著「也抽去過的」且還有主要目標＝正常的任務卡；否則是抽中後才解鎖的，提示換一個
        const solved = t.unlocked && !(pref.unfinished && todo.some(x => MAIN_KINDS.has(x.kind)));
        main.innerHTML = `
            ${solved ? `<div class="sg-banner">✅ 這個鄉鎮已經解鎖了！可以按「🔄 換一個」抽下一站。</div>` : ''}
            <div class="sg-card">
                <div class="sg-title">
                    <span class="sg-kicker">🎲 下一站${t.unlocked && !solved ? '（去過，還有目標）' : ''}</span>
                    <h3>${esc(c?.name || '')} <b>${esc(t.name)}</b>
                        ${rp ? `<a class="sg-maplink" href="${mapsUrl(rp[0], rp[1])}" target="_blank" rel="noopener noreferrer" title="在 Google 地圖開啟（另開分頁）">📍 Google 地圖</a>` : ''}</h3>
                    ${via ? `<p class="sg-via">${esc(via)}</p>` : P.fallback ? `<p class="sg-via">相鄰的鄉鎮都去過了，改從同縣市抽</p>` : ''}
                </div>
                <div class="sg-grid">
                    <div class="sg-map" id="sg-map"></div>
                    <div class="sg-side">
                        ${progress.length ? `<h4>解鎖之後</h4><ul class="sg-prog">${progress.map(l => `<li class="${l.hit ? 'hit' : ''}">${esc(l.text)}</li>`).join('')}</ul>` : ''}
                        <h4>怎麼去</h4>
                        <dl class="sg-ways">${Object.entries(ways).filter(([, v]) => v.length).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v.join('、'))}</dd>`).join('')
                            || '<dd>沒有相鄰的鄉鎮</dd>'}</dl>
                    </div>
                </div>
                <h4 class="sg-h">可以解鎖的目標 <small>${todo.length} 個</small></h4>
                ${todo.length ? groupsHtml(todo) : `<p class="sg-none">這裡沒有登山、車站、景點目標，解鎖鄉鎮與村里就是收穫！</p>`}
                ${done.length ? `<details class="sg-done"><summary>已達成 ${done.length} 個</summary>${groupsHtml(done)}</details>` : ''}
            </div>
            ${wishHtml(ix)}`;
        drawMap(code, P.visited);
        view = { code, town: t.name, county: c?.name || '', targets, progress, via, visitedSet: P.visited };
        syncFoot(true, inWish);
    }

    function groupsHtml(list) {
        return KINDS.map(([kind, label, group]) => {
            const xs = list.filter(x => x.kind === kind);
            if (!xs.length) return '';
            return `<div class="sg-group"><div class="sg-glabel" style="--g:${GROUP_COLOR[group] || ''}">${label}</div><ul class="sg-list">${xs.map(itemHtml).join('')}</ul></div>`;
        }).join('');
    }

    function itemHtml(x) {
        const link = Number.isFinite(x.lat) ? `<a class="sg-maplink" href="${mapsUrl(x.lat, x.lng)}" target="_blank" rel="noopener noreferrer" title="在 Google 地圖開啟（另開分頁）">📍 Google 地圖</a>` : '';
        let act = '';
        if (!x.done && x.add) {
            act = adding === x.key
                ? `<form class="sg-add" data-key="${esc(x.key)}"><input type="date" name="date" max="${today()}" aria-label="日期（可不填）">
                       <button type="submit" class="rp-btn primary">加入</button><button type="button" class="rp-btn" data-act="cancel">取消</button></form>`
                : `<button type="button" class="sg-addbtn" data-add="${esc(x.key)}">＋ 我去過</button>`;
        }
        return `<li class="${x.done ? 'done' : ''}"><span class="sg-name">${x.done ? '✓ ' : ''}${esc(x.name)}</span>
            ${x.sub ? `<span class="sg-sub">${esc(x.sub)}</span>` : ''}<span class="sg-acts">${link}${act}</span></li>`;
    }

    function wishHtml(ix) {
        const list = wish.filter(w => ix.town.has(w.t));
        if (!list.length) return '';
        return `<div class="sg-wishlist"><h4>📌 想去清單 <small>${list.length} 個</small></h4><ul>${list.map(w => {
            const t = ix.town.get(w.t), c = ix.county.get(t.county);
            const n = targetsOf(w.t, ix, data).filter(x => !x.done).length;
            return `<li class="${w.t === pref.town ? 'cur' : ''}"><button type="button" class="sg-wgo" data-go="${w.t}">${t.unlocked ? '✅ ' : ''}${esc(c?.name || '')} ${esc(t.name)}
                <small>${n ? `目標 ${n} 個` : ''}</small></button><button type="button" class="sg-wdel" data-del="${w.t}" title="從清單移除" aria-label="從清單移除">✕</button></li>`;
        }).join('')}</ul></div>`;
    }

    function syncFoot(has, inWish = false) {
        const $ = id => modal.querySelector('#' + id);
        $('sg-wish').disabled = !has;
        $('sg-share').disabled = !has;
        $('sg-wish').textContent = inWish ? '📌 已在想去清單' : '📌 加入想去清單';
        $('sg-wish').classList.toggle('on', inWish);
    }

    /** 小地圖：全台鄉鎮 SVG，畫面框在抽中的鄉鎮與它的陸路鄰居 */
    function drawMap(code, visited) {
        const box = modal.querySelector('#sg-map');
        const m = data.mapTown;
        mapBox = null;
        box.innerHTML = `<svg viewBox="${m.viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="小地圖">${m.paths.map(p =>
            `<path d="${p.d}" data-c="${p.code}" style="fill:${p.code === code ? SUGGEST_PICK_COLOR : visited.has(p.code) ? SUGGEST_VISITED_COLOR : 'var(--c-fog)'}"/>`).join('')}</svg>`;
        const svg = box.firstElementChild;
        const focus = [code, ...Object.entries(data.suggest.neighbors[code] || {}).filter(([, v]) => v === 'b' || v === 'l').map(([k]) => k)];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const c of focus) {
            const el = svg.querySelector(`path[data-c="${c}"]`);
            if (!el) continue;
            const b = el.getBBox();
            if (!b.width && !b.height) continue;
            x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
        }
        if (!Number.isFinite(x0)) return;
        // 留白，並至少 0.3 度寬，避免小鄉鎮放太大
        const w = Math.max(x1 - x0, 0.3), h = Math.max(y1 - y0, 0.3);
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const bbox = { x: cx - w * 0.6, y: cy - h * 0.6, w: w * 1.2, h: h * 1.2 };
        svg.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`);
        mapBox = bbox;
    }
    let mapBox = null;

    function onClick(e) {
        const el = e.target;
        if (el === modal || el.dataset.act === 'close') { close(); return; }
        if (el.dataset.add) { adding = el.dataset.add; render(); modal.querySelector('.sg-add input')?.focus(); return; }
        if (el.dataset.act === 'cancel') { adding = null; render(); return; }
        const go = el.closest('[data-go]');
        if (go) { pref.town = go.dataset.go; adding = null; savePref(); render(); modal.querySelector('#sg-main').scrollTop = 0; return; }
        const del = el.closest('[data-del]');
        if (del) { wish = wish.filter(w => w.t !== del.dataset.del); saveWish(); render(); }
    }

    async function onSubmit(e) {
        e.preventDefault();
        const form = e.target.closest('.sg-add');
        if (!form || !view) return;
        const x = view.targets.find(t => t.key === form.dataset.key);
        if (!x?.add) return;
        const date = form.elements.date.value;
        if (date && date > today()) { alert('日期不能是未來'); return; }
        form.querySelectorAll('button').forEach(b => { b.disabled = true; });
        form.querySelector('[type="submit"]').textContent = '加入中…';
        const err = await addManual(x.add, date);
        if (err) { alert(err); form.querySelectorAll('button').forEach(b => { b.disabled = false; }); form.querySelector('[type="submit"]').textContent = '加入'; return; }
        adding = null;
        render();
    }

    function toggleWish() {
        if (!pref.town) return;
        if (wish.some(w => w.t === pref.town)) wish = wish.filter(w => w.t !== pref.town);
        else wish.push({ t: pref.town, at: Date.now() });
        saveWish();
        render();
    }

    const image = () => renderCard({ ...view, map: data.mapTown, bbox: mapBox, nickname: loadNickname().trim() });

    async function share() {
        if (!view) return;
        const btn = modal.querySelector('#sg-share');
        btn.disabled = true;
        try {
            const canvas = image();
            const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
            await deliverFile(blob, `台灣旅遊護照下一站-${view.county}${view.town}.png`);
        } catch (e) {
            console.error(e);
            alert('產生圖片失敗：' + e.message);
        } finally {
            btn.disabled = false;
        }
    }

    async function open() {
        if (!modal) build();
        modal.hidden = false;
        document.body.classList.add('ex-modal-open');
        try {
            await ensureData();
        } catch (e) {
            modal.querySelector('#sg-main').innerHTML = `<div class="sg-empty">載入失敗：${esc(e.message)}</div>`;
            return;
        }
        render();
    }

    function close() {
        modal.hidden = true;
        adding = null;
        document.body.classList.remove('ex-modal-open');
    }

    /** 資料更新後（重新計算）：面板開著就重畫 */
    function refresh() { if (modal && !modal.hidden && data) render(); }

    return { open, close, refresh, image, get view() { return view; } };   // image、view：開發測試用
}
