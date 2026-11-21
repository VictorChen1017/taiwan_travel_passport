// 成就報表：把成就頁的結果畫成一張 PNG 長圖（寬 1080 px，高度依內容），給人看、分享用（docs/SPEC.md §15.4）
//
// - 全部在瀏覽器內用 Canvas 2D 繪製，不經伺服器；報表只放彙總結果（地名、日期），不含座標與照片
// - 顏色依當下的淺色／深色主題（介面色取 css/theme.css 的 --c-*，資料色取 js/shared.js）
// - 預設組合用選單切換，之後可以自己勾選區塊；每個區塊可選「顯示未達成」；可填暱稱
// - 隱私控制：隱藏日期、隱藏「老地方」、迷霧地圖最細到鄉鎮；照片模式的鄉鎮・村里地圖可選「制霸五色」
//
// 用法：
//   const rp = createReport({ getStats: () => stats, loadMap: level => Promise<{viewBox, paths}>, getMeta: () => ({ from, to, mode, manual }) });
//   rp.open();
//
// 繪製分兩次：先「量」（dry，只算高度），再依總高度建立畫布真正畫出來

import { GROUP_LABEL, POINT_STAMPS } from './explore.js';
import { GROUP_COLOR, ICONS, shapeOf, badgeColors, yearColor, EARLY_YEAR, YEAR_COLOR_FROM, YEAR_COLOR_TO, UNKNOWN_YEAR_COLOR, YEARLY_BAR_COLOR, CONQUER_LEVELS, conquerColor } from './shared.js';

const W = 1080, PAD = 44, CW = W - PAD * 2;   // 圖寬、外邊距、內容寬
const CARD_PAD = 26;
const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
const MAX_HEIGHT = 30000;   // 瀏覽器畫布高度上限（Chrome 約 32,767）

// ---------- 區塊與預設組合 ----------

// missing：可勾「顯示未達成」；missingOn：預設就顯示未達成
export const BLOCKS = [
    { id: 'summary', label: '探索率摘要' },
    { id: 'map', label: '迷霧地圖' },
    { id: 'yearly', label: '每年新解鎖' },
    { id: 'conquer', label: '縣市制霸卡', missing: true, missingOn: true },
    { id: 'villages', label: '村里探索進度（各縣市）', missing: true, missingOn: true },
    { id: 'milestone', label: '里程碑', missing: true },
    { id: 'peak', label: '登山（百岳、小百岳）', missing: true },
    { id: 'rail', label: '臺鐵・高鐵', missing: true, missingOn: true },
    { id: 'metro', label: '捷運', missing: true, missingOn: true },
    { id: 'lrt', label: '輕軌', missing: true, missingOn: true },
    { id: 'pole', label: '極點', missing: true },
    { id: 'island', label: '離島', missing: true },
    { id: 'landmark', label: '景點', missing: true },
    { id: 'bspot', label: 'B 級景點', missing: true },
    { id: 'nature', label: '國家公園與保護區', missing: true },
    { id: 'travel', label: '旅行', missing: true },
];
export const PRESETS = [
    { id: 'overview', label: '足跡總覽', blocks: ['summary', 'map', 'yearly', 'conquer'] },
    { id: 'conquer', label: '制霸卡', blocks: ['conquer', 'villages', 'milestone'] },
    { id: 'peak', label: '登山', blocks: ['summary', 'peak'] },
    { id: 'rail', label: '鐵道', blocks: ['rail', 'metro', 'lrt'] },
    { id: 'traveler', label: '旅人', blocks: ['pole', 'island', 'landmark', 'bspot', 'nature', 'travel'] },
    { id: 'full', label: '完整', blocks: BLOCKS.map(b => b.id) },
];
const UNIT_LABEL = { county: '縣市', town: '鄉鎮', village: '村里' };
const MODE_LABEL = { photo: '照片模式', visit: '造訪模式' };

const pad2 = n => String(n).padStart(2, '0');
// 紀錄的 time 是「當地時鐘時間當成 UTC」，一律用 getUTC*
const fmtDate = t => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const yearOf = t => new Date(t * 1000).getUTCFullYear();
const fmtPct = r => (r * 100).toFixed(r < 0.1 ? 2 : 1) + '%';
const n0 = n => Math.round(n).toLocaleString();
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// =====================================================================
// 繪圖工具：dry 為 true 時只量尺寸不畫
// =====================================================================

class Painter {
    constructor(ctx, colors) {
        this.ctx = ctx;
        this.c = colors;
        this.dry = true;
    }
    /** 暫時切到 dry 執行 fn（量高度用），回傳 fn 的結果 */
    measure(fn) {
        const d = this.dry;
        this.dry = true;
        try { return fn(); } finally { this.dry = d; }
    }
    font(size, weight = 'normal') { this.ctx.font = `${weight} ${size}px ${FONT}`; }
    width(str, size, weight) { this.font(size, weight); return this.ctx.measureText(str).width; }
    /** 超過寬度時截斷加「…」 */
    fit(str, maxW, size, weight) {
        str = String(str);
        if (this.width(str, size, weight) <= maxW) return str;
        let lo = 0, hi = str.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.ctx.measureText(str.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
        }
        return str.slice(0, lo) + '…';
    }
    /** 文字（y 為上緣）；回傳文字寬 */
    text(str, x, y, { size = 16, weight = 'normal', color = this.c.text, align = 'left', maxW = null } = {}) {
        if (maxW) str = this.fit(str, maxW, size, weight);
        this.font(size, weight);
        const w = this.ctx.measureText(str).width;
        if (!this.dry) {
            const ctx = this.ctx;
            ctx.fillStyle = color;
            ctx.textAlign = align;
            ctx.textBaseline = 'top';
            ctx.fillText(str, x, y);
        }
        return w;
    }
    /** 自動換行；回傳高度 */
    para(str, x, y, maxW, { size = 16, weight = 'normal', color = this.c.text, lh = 1.5 } = {}) {
        this.font(size, weight);
        const lines = [];
        let line = '';
        for (const ch of String(str)) {
            if (this.ctx.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; } else line += ch;
        }
        if (line) lines.push(line);
        lines.forEach((l, i) => this.text(l, x, y + i * size * lh, { size, weight, color }));
        return lines.length * size * lh;
    }
    rect(x, y, w, h, { fill = null, stroke = null, r = 0, lw = 1, dash = null } = {}) {
        if (this.dry) return;
        const ctx = this.ctx;
        ctx.beginPath();
        if (r) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) {
            ctx.strokeStyle = stroke; ctx.lineWidth = lw;
            if (dash) ctx.setLineDash(dash);
            ctx.stroke();
            if (dash) ctx.setLineDash([]);
        }
    }
    /** 徽章（80×80 的圖形縮放到 size） */
    badge(a, x, y, size) {
        if (this.dry) return;
        const ctx = this.ctx;
        const [color, ring] = badgeColors(a) || [this.c.badgeOff, this.c.badgeOffRing];
        const [outer, inner] = shapeOf(a.group);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(size / 80, size / 80);
        ctx.fillStyle = ring; ctx.fill(path(outer));
        ctx.fillStyle = color; ctx.fill(path(inner));
        ctx.translate(24, 24); ctx.scale(1.333, 1.333);
        ctx.globalAlpha = a.done ? 1 : 0.85;
        ctx.fillStyle = '#fff'; ctx.fill(path(ICONS[a.icon] || ICONS.star), 'evenodd');
        ctx.restore();
    }
}

const pathCache = new Map();
const path = d => { let p = pathCache.get(d); if (!p) pathCache.set(d, p = new Path2D(d)); return p; };

/** 依欄寬排格子：回傳 { cols, cw }（格子寬會撐滿整列） */
function gridCols(width, minW, gap) {
    const cols = Math.max(1, Math.floor((width + gap) / (minW + gap)));
    return { cols, cw: (width - gap * (cols - 1)) / cols };
}

// =====================================================================
// 報表內容
// =====================================================================

/**
 * 畫整張報表（g.dry 時只量）；回傳總高度
 * @param o 選項 { blocks: Set, missing: Set, hideDates, hideRegular, townMax, nickname, mapLevel, mapColor }
 * @param env { stats, meta, maps: { level: {viewBox, paths} } }
 */
function paint(g, o, env) {
    const { stats } = env;
    o = { ...o, mapLevel: mapLevelOf(o), mapColor: mapColorOf(o, stats) };
    const C = g.c;
    const date = t => o.hideDates ? null : t ? fmtDate(t) : '時間不明';
    let y = PAD;

    // ---------- 標題 ----------
    g.text('🛂 台灣旅遊護照', PAD, y, { size: 26, weight: 'bold', color: C.accent });
    g.text(MODE_LABEL[stats.mode] || '', W - PAD, y + 6, { size: 17, color: C.muted, align: 'right' });
    y += 44;
    const nick = (o.nickname || '').trim();
    if (nick) { g.text(nick, PAD, y, { size: 46, weight: 'bold', color: C.strong, maxW: CW }); y += 64; }
    const m = env.meta || {};
    const info = [];
    if (m.from) info.push(`紀錄期間 ${o.hideDates ? `${yearOf(m.from)} ～ ${yearOf(m.to || m.from)} 年` : `${fmtDate(m.from)} ～ ${fmtDate(m.to || m.from)}`}`);
    if (m.manual) info.push(`含手動紀錄 ${n0(m.manual)} 筆`);
    if (!o.hideDates) info.push(`${todayStr()} 製作`);
    if (info.length) { g.text(info.join('・'), PAD, y, { size: 18, color: C.muted }); y += 32; }
    y += 14;

    // ---------- 區塊 ----------
    const ach = o.hideRegular ? stats.achievements.filter(a => a.id !== 'regular') : stats.achievements;
    const blocks = BLOCKS.filter(b => o.blocks.has(b.id));
    for (const b of blocks) {
        const showMissing = !!b.missing && o.missing.has(b.id);
        const fn = BLOCK_PAINT[b.id];
        if (!fn) continue;
        y = fn(g, y, { o, env, ach, showMissing, date }) + 22;
    }

    // ---------- 頁尾 ----------
    y += 4;
    g.rect(PAD, y, CW, 1, { fill: C.border });
    y += 18;
    g.text('🔒 本機運算：你的照片與位置完全掌握在你手中', PAD, y, { size: 16, color: C.muted });
    g.text('台灣旅遊護照', W - PAD, y, { size: 16, weight: 'bold', color: C.faint, align: 'right' });
    y += 24 + PAD - 8;
    return Math.ceil(y);
}

/** 卡片外框＋標題列；body(g, x, y, w) 回傳內容結束的 y */
function card(g, y, { title, color, right = '' }, body) {
    const C = g.c;
    const x = PAD + CARD_PAD, w = CW - CARD_PAD * 2;
    const head = y + CARD_PAD;
    const bodyY = head + 44;
    const end = g.measure(() => body(x, bodyY, w));
    const h = end - y + CARD_PAD;
    g.rect(PAD, y, CW, h, { fill: C.surface, stroke: C.border, r: 16 });
    g.rect(PAD + CARD_PAD, head + 2, 5, 26, { fill: color || C.accent, r: 2 });
    g.text(title, x + 16, head, { size: 24, weight: 'bold', color: C.strong });
    if (right) g.text(right, x + w, head + 4, { size: 18, color: C.muted, align: 'right' });
    if (!g.dry) body(x, bodyY, w);
    return y + h;
}

const empty = (g, x, y, msg) => { g.text(msg, x, y, { size: 17, color: g.c.faint }); return y + 30; };

// ---------- 探索率摘要 ----------

function paintSummary(g, y, { env, ach }) {
    const s = env.stats.summary, C = g.c;
    const done = ach.filter(a => a.done).length;
    return card(g, y, { title: '探索率', right: `成就 ${done} / ${ach.length}` }, (x, y0, w) => {
        const colW = w / 3;
        ['county', 'town', 'village'].forEach((u, i) => {
            const v = s[u], cx = x + colW * i;
            const r = v.total ? v.unlocked / v.total : 0;
            g.text(UNIT_LABEL[u], cx, y0, { size: 18, color: C.muted });
            g.text(fmtPct(r), cx, y0 + 28, { size: 44, weight: 'bold', color: C.accent });
            g.text(`${v.unlocked.toLocaleString()} / ${v.total.toLocaleString()} 個`, cx, y0 + 84, { size: 18, color: C.text });
            g.text(`面積 ${fmtPct(v.area ? v.area_unlocked / v.area : 0)}（${n0(v.area_unlocked)} km²）`, cx, y0 + 112, { size: 15, color: C.muted });
            // 進度條
            g.rect(cx, y0 + 140, colW - 28, 8, { fill: C.surface3, r: 4 });
            if (r > 0) g.rect(cx, y0 + 140, Math.max(8, (colW - 28) * r), 8, { fill: C.accent, r: 4 });
        });
        return y0 + 150;
    });
}

// ---------- 迷霧地圖 ----------

/** 實際使用的地圖層級：勾「最細到鄉鎮」時村里改用鄉鎮 */
export const mapLevelOf = o => o.townMax && o.mapLevel === 'village' ? 'town' : o.mapLevel;
/** 實際使用的上色：制霸五色只在照片模式的鄉鎮、村里 */
const canConquer = (level, stats) => stats?.mode === 'photo' && level !== 'county' && !!stats.towns?.some(t => t.n !== undefined);
export const mapColorOf = (o, stats) => o.mapColor === 'count' && canConquer(mapLevelOf(o), stats) ? 'count' : 'year';

function unlockedIndex(stats, level) {
    const list = level === 'county' ? stats.counties : level === 'town' ? stats.towns : stats.villages;
    return new Map(list.filter(x => level === 'village' || x.unlocked).map(x => [x.code, x]));
}

function paintMap(g, y, { o, env }) {
    const level = o.mapLevel, m = env.maps[level], C = g.c;
    const idx = unlockedIndex(env.stats, level);
    const conquer = o.mapColor === 'count';
    return card(g, y, { title: `迷霧地圖（${UNIT_LABEL[level]}${conquer ? '・制霸五色' : ''}）`, right: `已解鎖 ${idx.size.toLocaleString()} 個` }, (x, y0, w) => {
        if (!m) return empty(g, x, y0, '地圖載入中…');
        const [vx, vy, vw, vh] = m.viewBox.split(/[\s,]+/).map(Number);
        const scale = Math.min(w / vw, 1150 / vh);
        const mw = vw * scale, mh = vh * scale, mx = x + (w - mw) / 2;
        const firsts = [...idx.values()].map(v => v.first).filter(Boolean).map(yearOf);
        const y1 = firsts.length ? Math.max(...firsts) : new Date().getFullYear();
        const y0y = firsts.length ? Math.min(y1, Math.max(EARLY_YEAR, Math.min(...firsts))) : y1;
        if (!g.dry) {
            const ctx = g.ctx;
            ctx.save();
            ctx.translate(mx, y0);
            ctx.scale(scale, scale);
            ctx.translate(-vx, -vy);
            ctx.lineWidth = (level === 'village' ? 0.4 : 0.8) / scale;
            ctx.strokeStyle = C.fogLine;
            ctx.lineJoin = 'round';
            // 先畫迷霧，再畫已解鎖的
            for (const pass of [false, true]) {
                for (const p of m.paths) {
                    const it = idx.get(p.code);
                    if (!!it !== pass) continue;
                    const pp = path(p.d);
                    ctx.fillStyle = !it ? C.fog : conquer ? conquerColor(it.n || 0) || C.fog
                        : it.first ? yearColor(yearOf(it.first), y0y, y1) : UNKNOWN_YEAR_COLOR;
                    ctx.fill(pp);
                    ctx.stroke(pp);
                }
            }
            ctx.restore();
        }
        // 圖例
        let ly = y0 + mh + 18;
        g.rect(x, ly + 2, 18, 18, { fill: C.fog, r: 3 });
        let lx = x + 26 + g.text('未解鎖', x + 26, ly, { size: 16, color: C.muted }) + 28;
        if (conquer) {
            for (const l of CONQUER_LEVELS) {
                g.rect(lx, ly + 2, 18, 18, { fill: l.color, stroke: C.border, r: 3 });
                lx += 26 + g.text(l.label, lx + 26, ly, { size: 16, color: C.muted }) + 22;
            }
            return ly + 26;
        }
        if (!g.dry) {
            const grad = g.ctx.createLinearGradient(lx, 0, lx + 120, 0);
            grad.addColorStop(0, YEAR_COLOR_FROM); grad.addColorStop(1, YEAR_COLOR_TO);
            g.rect(lx, ly + 2, 120, 18, { fill: grad, r: 3 });
        }
        g.text(`首次解鎖年份：${y0y}${y0y === EARLY_YEAR ? ' 前' : ''} → ${y1} 年`, lx + 132, ly, { size: 16, color: C.muted });
        return ly + 26;
    });
}

// ---------- 每年新解鎖 ----------

function paintYearly(g, y, { o, env }) {
    const level = o.mapLevel, C = g.c;
    const items = [...unlockedIndex(env.stats, level).values()].filter(v => v.first);
    const byYear = new Map();
    for (const v of items) { const yr = yearOf(v.first); byYear.set(yr, (byYear.get(yr) || 0) + 1); }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    return card(g, y, { title: `每年新解鎖（${UNIT_LABEL[level]}）`, right: `共 ${items.length.toLocaleString()} 個` }, (x, y0, w) => {
        if (!years.length) return empty(g, x, y0, '還沒有時間正常的紀錄');
        const labels = [], vals = [];
        const early = years.filter(yr => yr < EARLY_YEAR).reduce((s, yr) => s + byYear.get(yr), 0);
        if (early) { labels.push(`${EARLY_YEAR} 前`); vals.push(early); }
        for (let yr = Math.max(years[0], EARLY_YEAR); yr <= years[years.length - 1]; yr++) { labels.push(String(yr)); vals.push(byYear.get(yr) || 0); }
        const H = 220, top = y0 + 26, max = Math.max(...vals, 1);
        const bw = w / labels.length;
        const step = Math.ceil(labels.length / Math.max(1, Math.floor(w / 62)));
        g.rect(x, top + H, w, 1, { fill: C.border });
        vals.forEach((v, i) => {
            const h = v / max * H, bx = x + bw * i + bw * 0.15;
            if (v) g.rect(bx, top + H - h, bw * 0.7, h, { fill: YEARLY_BAR_COLOR, r: 3 });
            if (v && bw >= 34) g.text(v.toLocaleString(), bx + bw * 0.35, top + H - h - 22, { size: 14, color: C.text, align: 'center' });
            if (i % step === 0 || i === labels.length - 1) g.text(labels[i], bx + bw * 0.35, top + H + 8, { size: 14, color: C.muted, align: 'center' });
        });
        return top + H + 32;
    });
}

// ---------- 縣市制霸卡 ----------

function paintConquer(g, y, { ach, showMissing, date }) {
    const C = g.c;
    const a = ach.find(x => x.id === 'conquer');
    if (!a) return y - 22;
    const cells = [...a.cells].sort((p, q) => (q.done - p.done) || (q.progress / q.target - p.progress / p.target))
        .filter(c => showMissing || c.done);
    const extra = ach.filter(x => x.group === 'conquer' && x.id !== 'conquer');
    return card(g, y, { title: '縣市制霸', color: GROUP_COLOR.conquer, right: `已制霸 ${a.progress} / ${a.target}` }, (x, y0, w) => {
        let yy = y0;
        if (!cells.length) yy = empty(g, x, yy, '還沒有制霸任何縣市（縣市內所有鄉鎮市區都解鎖）');
        else {
            const gap = 10, { cols, cw } = gridCols(w, 128, gap), ch = date(1) ? 74 : 58;
            cells.forEach((c, i) => {
                const cx = x + (i % cols) * (cw + gap), cy = yy + Math.floor(i / cols) * (ch + gap);
                g.rect(cx, cy, cw, ch, c.done ? { fill: C.accent, r: 10 } : { fill: C.surface3, stroke: C.borderStrong, r: 10, dash: [5, 4] });
                const col = c.done ? C.onAccent : C.faint;
                g.text(c.name, cx + cw / 2, cy + 9, { size: 19, weight: 'bold', color: col, align: 'center', maxW: cw - 10 });
                g.text(c.done ? '✓ 制霸' : `${c.progress} / ${c.target}`, cx + cw / 2, cy + 35, { size: 14, color: col, align: 'center' });
                if (c.done && date(1)) g.text(date(c.date), cx + cw / 2, cy + 53, { size: 12, color: col, align: 'center' });
            });
            yy += Math.ceil(cells.length / cols) * (ch + gap) - gap;
        }
        // 六都踏足、六都制霸
        const xs = extra.filter(e => showMissing || e.done);
        if (xs.length) {
            yy += 18;
            let lx = x;
            for (const e of xs) {
                g.badge(e, lx, yy, 34);
                lx += 42 + g.text(e.name + (e.done ? (date(e.date) ? `（${date(e.date)}）` : '') : `（${e.progress} / ${e.target}）`), lx + 42, yy + 7,
                    { size: 17, color: e.done ? C.text : C.faint }) + 28;
            }
            yy += 34;
        }
        return yy;
    });
}

// ---------- 村里探索進度 ----------

function paintVillages(g, y, { env, showMissing }) {
    const C = g.c, s = env.stats.summary.village;
    const list = [...env.stats.counties].sort((a, b) => b.villages_unlocked / b.villages - a.villages_unlocked / a.villages || a.code.localeCompare(b.code))
        .filter(c => showMissing || c.villages_unlocked > 0);
    return card(g, y, { title: '村里探索進度', color: GROUP_COLOR.milestone, right: `${s.unlocked.toLocaleString()} / ${s.total.toLocaleString()} 村里` }, (x, y0, w) => {
        if (!list.length) return empty(g, x, y0, '還沒有解鎖任何村里');
        const rh = 34, nameW = 120, numW = 170, bx = x + nameW, bw = w - nameW - numW;
        list.forEach((c, i) => {
            const cy = y0 + i * rh, r = c.villages ? c.villages_unlocked / c.villages : 0;
            g.text(c.name, x, cy + 4, { size: 18, color: r > 0 ? C.text : C.faint });
            g.rect(bx, cy + 9, bw, 12, { fill: C.surface3, r: 6 });
            if (r > 0) g.rect(bx, cy + 9, Math.max(12, bw * r), 12, { fill: r >= 1 ? GROUP_COLOR.conquer : C.accent, r: 6 });
            g.text(`${c.villages_unlocked} / ${c.villages}（${(r * 100).toFixed(0)}%）`, x + w, cy + 5, { size: 15, color: C.muted, align: 'right' });
        });
        return y0 + list.length * rh - 6;
    });
}

// ---------- 徽章類（里程碑、地點類、旅行） ----------

function paintBadgeGroup(group) {
    return (g, y, { ach, showMissing, date }) => {
        const C = g.c;
        const all = ach.filter(a => a.group === group && !a.cells);
        if (!all.length) return y - 22;
        const list = all.filter(a => showMissing || a.done);
        const done = all.filter(a => a.done).length;
        return card(g, y, { title: GROUP_LABEL[group], color: GROUP_COLOR[group], right: `${done} / ${all.length}` }, (x, y0, w) => {
            if (!list.length) return empty(g, x, y0, '還沒有達成這一類的成就');
            // 有兩個以上分區才加小標題；里程碑的名稱已含縣市／鄉鎮／村里，不分（排在一起比較緊湊）
            const secOf0 = a => a.section || '';
            const withHead = group !== 'milestone' && new Set(list.map(secOf0)).size > 1;
            const secOf = a => withHead ? secOf0(a) : '';
            const sections = [...new Set(list.map(secOf))];
            const gap = 12, { cols, cw } = gridCols(w, 150, gap);
            const ch = date(1) ? 128 : 108;
            let yy = y0;
            for (const s of sections) {
                const sl = list.filter(a => secOf(a) === s);
                if (withHead && s) {
                    g.text(`${s}  ${all.filter(a => a.done && secOf0(a) === s).length} / ${all.filter(a => secOf0(a) === s).length}`, x, yy, { size: 17, weight: 'bold', color: C.muted });
                    yy += 30;
                }
                sl.forEach((a, i) => {
                    const cx = x + (i % cols) * (cw + gap), cy = yy + Math.floor(i / cols) * (ch + gap);
                    g.badge(a, cx + (cw - 56) / 2, cy, 56);
                    g.text(a.name, cx + cw / 2, cy + 62, { size: 16, weight: 'bold', color: a.done ? C.strong : C.faint, align: 'center', maxW: cw - 4 });
                    const sub = a.done ? date(a.date) : (a.target > 1 ? `${a.progress.toLocaleString()} / ${a.target.toLocaleString()}` : '尚未造訪');
                    if (sub) g.text(sub, cx + cw / 2, cy + 86, { size: 13, color: C.muted, align: 'center', maxW: cw - 4 });
                });
                yy += Math.ceil(sl.length / cols) * (ch + gap) - gap + 18;
            }
            return yy - 18;
        });
    };
}

// ---------- 集點卡（百岳、小百岳、鐵道各卡） ----------

/** 一張集點卡的格子；回傳結束的 y */
function stampGrid(g, x, y, w, cells, { showMissing, date, minW, lineColors }) {
    const C = g.c;
    const list = cells.filter(c => showMissing || c.done);
    const gap = 8, { cols, cw } = gridCols(w, minW, gap);
    const withDate = !!date(1);
    const ch = withDate ? 50 : 36;
    list.forEach((c, i) => {
        const cx = x + (i % cols) * (cw + gap), cy = y + Math.floor(i / cols) * (ch + gap);
        const grade = c.tier ? { bronze: '#c27c4e', silver: '#8e9aa8', gold: '#e0a526' }[c.tier] : null;
        const colors = lineColors && c.colors ? (c.colors.length > 2 ? ['#8e9aa8', '#8e9aa8'] : [c.colors[0], c.colors[1] || c.colors[0]]) : null;
        if (c.done) {
            if (colors && !g.dry) {
                // 轉乘站斜線雙色
                const ctx = g.ctx;
                ctx.save();
                ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, 7); ctx.clip();
                ctx.fillStyle = colors[0]; ctx.fillRect(cx, cy, cw, ch);
                ctx.fillStyle = colors[1];
                ctx.beginPath(); ctx.moveTo(cx + cw, cy); ctx.lineTo(cx + cw, cy + ch); ctx.lineTo(cx, cy + ch); ctx.closePath(); ctx.fill();
                ctx.restore();
            } else g.rect(cx, cy, cw, ch, { fill: grade || C.accent, r: 7 });
        } else {
            g.rect(cx, cy, cw, ch, { fill: C.surface3, stroke: C.borderStrong, r: 7, dash: [4, 3] });
            const bar = colors || (grade ? [grade, grade] : null);
            if (bar) { g.rect(cx + 2, cy + ch - 5, (cw - 4) / 2, 3, { fill: bar[0] }); g.rect(cx + cw / 2, cy + ch - 5, (cw - 4) / 2, 3, { fill: bar[1] }); }
        }
        // 黃、淺綠等淺色路線上改用深色字
        const col = !c.done ? C.faint : colors && colors.every(isLight) ? '#1f2937' : '#fff';
        g.text(c.name, cx + cw / 2, cy + (withDate ? 6 : 9), { size: 15, weight: 'bold', color: col, align: 'center', maxW: cw - 8 });
        if (withDate && c.done) g.text(date(c.date), cx + cw / 2, cy + 29, { size: 12, color: col, align: 'center' });
    });
    return list.length ? y + Math.ceil(list.length / cols) * (ch + gap) - gap : y;
}

/** '#rrggbb' 是否為淺色（相對亮度 > 0.5） */
function isLight(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    if (!Number.isFinite(n)) return false;
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) > 0.5;
}

function paintPeaks(g, y, opt) {
    const { ach, showMissing } = opt;
    const lists = ach.filter(a => a.group === 'peak' && a.cells);
    if (!lists.length) return y - 22;
    const C = g.c;
    const ps = POINT_STAMPS.peak;
    const total = lists.reduce((s, a) => s + a.cells.filter(c => c.done).length, 0);
    return card(g, y, { title: '登山', color: GROUP_COLOR.peak, right: `已${ps.verb} ${total} 座` }, (x, y0, w) => {
        let yy = y0;
        lists.forEach((a, k) => {
            if (k) yy += 22;
            g.text(`${a.name}　已${ps.verb} ${a.progress} / ${a.target} ${ps.unit}`, x, yy, { size: 19, weight: 'bold', color: C.text });
            yy += 34;
            const end = stampGrid(g, x, yy, w, a.cells, { ...opt, showMissing, minW: 104 });
            yy = end === yy ? empty(g, x, yy, `還沒有${ps.verb}任何一${ps.unit}`) : end;
        });
        return yy;
    });
}

function paintRail(group) {
    return (g, y, opt) => {
        const { ach, showMissing, date } = opt;
        const C = g.c;
        const cards = ach.filter(a => a.group === group && a.cells);
        if (!cards.length) return y - 22;
        const routes = ach.filter(a => a.group === group && !a.cells && a.section === '路線制霸');
        const cells = cards.flatMap(a => a.cells);
        const shown = cards.filter(a => showMissing || a.progress > 0);
        return card(g, y, { title: GROUP_LABEL[group], color: GROUP_COLOR[group], right: `已到站 ${cells.filter(c => c.done).length} / ${cells.length} 站` }, (x, y0, w) => {
            let yy = y0;
            // 路線制霸：只列達成的路線
            const doneRoutes = routes.filter(r => r.done);
            if (routes.length) {
                const label = `路線制霸 ${doneRoutes.length} / ${routes.length}${doneRoutes.length ? '：' : ''}`;
                const lw = g.text(label, x, yy, { size: 17, weight: 'bold', color: C.muted });
                if (doneRoutes.length) yy += g.para(doneRoutes.map(r => '✓ ' + r.name).join('　'), x + lw + 6, yy + 1, w - lw - 6, { size: 16, color: C.text, lh: 1.6 }) + 8;
                else yy += 34;
            }
            // 臺鐵格子依站級上色（同成就頁：大站銅、小站金）
            if (cells.some(c => c.tier)) {
                let lx = x + g.text('格子顏色：', x, yy, { size: 15, color: C.muted });
                for (const [col, label] of [['#c27c4e', '特等／一等站'], ['#8e9aa8', '二等站'], ['#e0a526', '三等／簡易／招呼站']]) {
                    g.rect(lx, yy + 3, 14, 14, { fill: col, r: 3 });
                    lx += 20 + g.text(label, lx + 20, yy, { size: 15, color: C.muted }) + 16;
                }
                yy += 32;
            }
            if (!shown.length) return empty(g, x, yy, '還沒有到過任何一站');
            let section = null;
            shown.forEach((a, k) => {
                if (a.section && a.section !== section && cards.some(c => c.section !== a.section)) {
                    section = a.section;
                    yy += k ? 14 : 0;
                    g.text(section, x, yy, { size: 17, weight: 'bold', color: C.muted });
                    yy += 30;
                } else if (k) yy += 18;
                g.text(`${a.name}`, x, yy, { size: 18, weight: 'bold', color: C.text });
                g.text(`${a.progress} / ${a.target} 站`, x + w, yy + 2, { size: 15, color: C.muted, align: 'right' });
                yy += 30;
                const end = stampGrid(g, x, yy, w, a.cells, { ...opt, showMissing, minW: group === 'rail' ? 92 : 104, lineColors: group !== 'rail' });
                yy = end === yy ? yy - 8 : end;
            });
            return yy;
        });
    };
}

const BLOCK_PAINT = {
    summary: paintSummary, map: paintMap, yearly: paintYearly, conquer: paintConquer, villages: paintVillages,
    milestone: paintBadgeGroup('milestone'), peak: paintPeaks,
    rail: paintRail('rail'), metro: paintRail('metro'), lrt: paintRail('lrt'),
    pole: paintBadgeGroup('pole'), island: paintBadgeGroup('island'), landmark: paintBadgeGroup('landmark'),
    bspot: paintBadgeGroup('bspot'), nature: paintBadgeGroup('nature'), travel: paintBadgeGroup('travel'),
};

/** 主題色（每次繪製時重新讀，切換深淺色後立即反映） */
function themeColors() {
    const get = n => (window.photoTheme ? window.photoTheme.color(n) : getComputedStyle(document.documentElement).getPropertyValue(n)).trim();
    return {
        bg: get('--c-bg'), surface: get('--c-surface'), surface2: get('--c-surface-2'), surface3: get('--c-surface-3'),
        border: get('--c-border'), borderStrong: get('--c-border-strong'),
        text: get('--c-text'), strong: get('--c-text-strong'), muted: get('--c-text-muted'), faint: get('--c-text-faint'),
        accent: get('--c-accent'), onAccent: get('--c-on-accent'),
        fog: get('--c-fog'), fogLine: get('--c-fog-line'), badgeOff: get('--c-badge-off'), badgeOffRing: get('--c-badge-off-ring'),
    };
}

/**
 * 產生報表畫布
 * @returns { canvas, height, tooTall }
 */
export function renderReport(o, env) {
    const colors = themeColors();
    const probe = document.createElement('canvas').getContext('2d');
    const g = new Painter(probe, colors);
    const h = paint(g, o, env);
    const height = Math.min(h, MAX_HEIGHT);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, height);
    g.ctx = ctx;
    g.dry = false;
    paint(g, o, env);
    return { canvas, height, tooTall: h > MAX_HEIGHT };
}

// =====================================================================
// 報表彈窗
// =====================================================================

const PREF_KEY = 'fog-report';   // 選項記在 localStorage（暱稱除外的顯示偏好；暱稱也存，只在這台）

function loadPref() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; }
}
function savePref(o) {
    try {
        localStorage.setItem(PREF_KEY, JSON.stringify({ preset: o.preset, blocks: [...o.blocks], missing: [...o.missing],
            hideDates: o.hideDates, hideRegular: o.hideRegular, townMax: o.townMax, nickname: o.nickname, mapLevel: o.mapLevel, mapColor: o.mapColor }));
    } catch (e) { /* 存不了只影響下次 */ }
}

// 手機（觸控）且瀏覽器能分享檔案：按鈕改為「分享到 IG／Threads」，叫出系統分享選單；電腦一律下載
function canShareFile(file = new File([''], 'a.png', { type: 'image/png' })) {
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    try { return !!(touch && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; }
}

const presetBlocks = id => new Set((PRESETS.find(p => p.id === id) || PRESETS[0]).blocks);
const defaultMissing = () => new Set(BLOCKS.filter(b => b.missingOn).map(b => b.id));

export function createReport({ getStats, loadMap, getMeta }) {
    let modal = null, timer = null, last = null, lastMs = 0;
    const p = loadPref();
    const o = {
        preset: p.preset || 'overview',
        blocks: p.blocks ? new Set(p.blocks) : presetBlocks('overview'),
        missing: p.missing ? new Set(p.missing) : defaultMissing(),
        hideDates: !!p.hideDates,
        hideRegular: p.hideRegular ?? true,
        townMax: p.townMax ?? true,
        mapColor: p.mapColor || 'year',
        nickname: p.nickname || '',
        mapLevel: p.mapLevel || 'town',
    };
    const maps = {};

    function build() {
        modal = document.createElement('div');
        modal.className = 'rp-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="rp-box" role="dialog" aria-modal="true" aria-labelledby="rp-title">
                <div class="rp-head">
                    <span id="rp-title" class="rp-title">📤 分享成就</span>
                    <span class="rp-hint">產生一張 PNG 圖片，只含地名與日期，不含座標與照片</span>
                    <button type="button" class="rp-x" data-act="close" title="關閉（Esc）">✕</button>
                </div>
                <div class="rp-main">
                    <div class="rp-opts">
                        <fieldset class="rp-privacy">
                            <legend>🔒 隱私控制</legend>
                            <label class="rp-check"><input type="checkbox" id="rp-hide"> 隱藏日期</label>
                            <label class="rp-check" id="rp-regular-row"><input type="checkbox" id="rp-regular"> 隱藏「老地方」</label>
                            <label class="rp-check"><input type="checkbox" id="rp-townmax"> 迷霧地圖最細到鄉鎮</label>
                            <label class="rp-field" id="rp-color-row">地圖上色
                                <select id="rp-color"><option value="year">首次解鎖年份</option><option value="count">制霸五色（照片張數，看得出常去的地方）</option></select></label>
                        </fieldset>
                        <label class="rp-field">預設組合
                            <select id="rp-preset">${PRESETS.map(x => `<option value="${x.id}">${x.label}</option>`).join('')}<option value="custom">自訂</option></select></label>
                        <label class="rp-field">暱稱（選填）
                            <input type="text" id="rp-nick" maxlength="24" placeholder="例如：小明的足跡"></label>
                        <label class="rp-field">迷霧地圖、每年新解鎖
                            <select id="rp-level"><option value="county">縣市</option><option value="town">鄉鎮</option><option value="village">村里</option></select></label>
                        <div class="rp-blocks-title">區塊 <small>右欄勾選＝顯示未達成</small></div>
                        <ul class="rp-blocks" id="rp-blocks">${BLOCKS.map(b => `
                            <li><label class="rp-check"><input type="checkbox" data-block="${b.id}"> ${esc(b.label)}</label>
                                ${b.missing ? `<label class="rp-miss" title="顯示未達成的項目"><input type="checkbox" data-miss="${b.id}"> 未達成</label>` : ''}</li>`).join('')}
                        </ul>
                    </div>
                    <div class="rp-preview">
                        <div class="rp-status" id="rp-status">產生中…</div>
                        <div class="rp-canvas" id="rp-canvas"></div>
                    </div>
                </div>
                <div class="rp-foot">
                    <span class="rp-size" id="rp-size"></span>
                    <button type="button" class="rp-btn" data-act="close">關閉</button>
                    <button type="button" class="rp-btn primary" id="rp-save">${canShareFile() ? '📤 分享到 IG／Threads' : '⬇ 下載 PNG'}</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => {
            if (e.target === modal || e.target.dataset.act === 'close') close();
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal && !modal.hidden) close(); });
        const $ = id => modal.querySelector('#' + id);
        $('rp-preset').addEventListener('change', e => {
            if (e.target.value === 'custom') { o.preset = 'custom'; return; }
            o.preset = e.target.value;
            o.blocks = presetBlocks(o.preset);
            o.missing = defaultMissing();
            syncForm(); schedule();
        });
        $('rp-nick').addEventListener('input', e => { o.nickname = e.target.value; schedule(400); });
        $('rp-level').addEventListener('change', e => { o.mapLevel = e.target.value; syncForm(); schedule(); });
        $('rp-hide').addEventListener('change', e => { o.hideDates = e.target.checked; schedule(); });
        $('rp-regular').addEventListener('change', e => { o.hideRegular = e.target.checked; schedule(); });
        $('rp-townmax').addEventListener('change', e => { o.townMax = e.target.checked; syncForm(); schedule(); });
        $('rp-color').addEventListener('change', e => { o.mapColor = e.target.value; schedule(); });
        $('rp-blocks').addEventListener('change', e => {
            const t = e.target;
            if (t.dataset.block) { t.checked ? o.blocks.add(t.dataset.block) : o.blocks.delete(t.dataset.block); o.preset = 'custom'; }
            if (t.dataset.miss) t.checked ? o.missing.add(t.dataset.miss) : o.missing.delete(t.dataset.miss);
            syncForm(); schedule();
        });
        $('rp-save').addEventListener('click', save);
        document.addEventListener('themechange', () => { if (modal && !modal.hidden) schedule(); });
    }

    function syncForm() {
        const $ = id => modal.querySelector('#' + id);
        // 勾選內容剛好等於某個預設組合時，選單顯示那個組合
        const same = PRESETS.find(x => x.blocks.length === o.blocks.size && x.blocks.every(b => o.blocks.has(b)));
        if (o.preset === 'custom' && same) o.preset = same.id;
        $('rp-preset').value = o.preset;
        $('rp-nick').value = o.nickname;
        $('rp-level').value = mapLevelOf(o);
        $('rp-level').querySelector('option[value="village"]').disabled = o.townMax;
        $('rp-hide').checked = o.hideDates;
        $('rp-regular').checked = o.hideRegular;
        $('rp-townmax').checked = o.townMax;
        const stats = getStats();
        $('rp-regular-row').hidden = stats?.mode !== 'photo';   // 老地方只在照片模式
        $('rp-color-row').hidden = stats?.mode !== 'photo';
        $('rp-color').value = o.mapColor;
        $('rp-color').disabled = !(o.blocks.has('map') && canConquer(mapLevelOf(o), stats));
        modal.querySelectorAll('[data-block]').forEach(b => { b.checked = o.blocks.has(b.dataset.block); });
        modal.querySelectorAll('[data-miss]').forEach(b => {
            b.checked = o.missing.has(b.dataset.miss);
            b.disabled = !o.blocks.has(b.dataset.miss);
        });
        const needMap = o.blocks.has('map') || o.blocks.has('yearly');
        $('rp-level').disabled = !needMap;
    }

    function schedule(ms = 120) {
        clearTimeout(timer);
        timer = setTimeout(draw, ms);
    }

    async function draw() {
        const $ = id => modal.querySelector('#' + id);
        savePref(o);
        if (!o.blocks.size) {
            $('rp-status').textContent = '請至少勾選一個區塊';
            $('rp-status').hidden = false;
            $('rp-canvas').innerHTML = '';
            $('rp-save').disabled = true;
            $('rp-size').textContent = '';
            last = null;
            return;
        }
        $('rp-status').hidden = false;
        $('rp-status').textContent = '產生中…';
        const level = mapLevelOf(o);
        if (o.blocks.has('map') && !maps[level]) {
            try { maps[level] = await loadMap(level); } catch (e) { /* 地圖載入失敗時區塊顯示「載入中」 */ }
        }
        const stats = getStats();
        if (!stats) return;
        const t0 = performance.now();
        const r = renderReport(o, { stats, meta: getMeta(), maps });
        last = r;
        r.canvas.className = 'rp-img';
        $('rp-canvas').innerHTML = '';
        $('rp-canvas').appendChild(r.canvas);
        $('rp-status').hidden = !r.tooTall;
        if (r.tooTall) $('rp-status').textContent = '⚠ 內容太長，超出的部分被截掉了；請減少區塊或關掉「未達成」';
        $('rp-save').disabled = false;
        $('rp-size').textContent = `${W} × ${r.height.toLocaleString()} px${r.height > 8000 ? '・圖片很長，部分手機 App 可能無法完整顯示' : ''}`;
        lastMs = Math.round(performance.now() - t0);
    }

    async function save() {
        if (!last) return;
        const blob = await new Promise(res => last.canvas.toBlob(res, 'image/png'));
        if (!blob) { alert('無法產生圖片（可能是內容太長），請減少區塊後再試。'); return; }
        const filename = `台灣旅遊護照成就報表-${todayStr()}.png`;
        const file = new File([blob], filename, { type: 'image/png' });
        if (canShareFile(file)) {
            try { await navigator.share({ files: [file], title: filename }); return; }
            catch (e) { if (e.name === 'AbortError') return; }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function open() {
        if (!modal) build();
        syncForm();
        modal.hidden = false;
        document.body.classList.add('ex-modal-open');
        draw();
    }

    function close() {
        modal.hidden = true;
        document.body.classList.remove('ex-modal-open');
    }

    return { open, close, get lastMs() { return lastMs; }, get last() { return last; } };   // lastMs、last：開發測試用
}
