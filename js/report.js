// 成就報表：把成就頁的結果畫成一張 PNG 長圖（寬 1080 px，高度依內容），給人看、分享用（docs/SPEC.md §15.4）
//
// - 全部在瀏覽器內用 Canvas 2D 繪製，不經伺服器；報表只放彙總結果（地名、日期），不含座標與照片
// - 顏色依當下的淺色／深色主題（介面色取 css/theme.css 的 --c-*，資料色取 js/shared.js）
// - 預設組合用選單切換，之後可以自己勾選區塊；未達成預設顯示，勾選的區塊下方展開進階選項：隱藏未達成、選子項目（鐵路各區、各捷運系統等）
// - 可填暱稱；沒填時預覽圖顯示淡色範例「小明的足跡」，匯出時不印
// - 隱私控制：隱藏月/日、隱藏「老地方」；照片模式的鄉鎮・村里地圖可選「制霸五色」
// - 行政區尺度（迷霧地圖、每年新解鎖用）：縣市／鄉鎮／村里，旁邊「?」提醒村里容易看出住處
//
// 用法：
//   const rp = createReport({ getStats: () => stats, loadMap: level => Promise<{viewBox, paths}>, getMeta: () => ({ from, to, mode, manual }) });
//   rp.open();
//
// 繪製分兩次：先「量」（dry，只算高度），再依總高度建立畫布真正畫出來

import { GROUP_LABEL, POINT_STAMPS } from './explore.js';
import { canShareFile } from './device.js';
import { GROUP_COLOR, ICONS, shapeOf, badgeColors, yearColor, EARLY_YEAR, YEAR_COLOR_FROM, YEAR_COLOR_TO, UNKNOWN_YEAR_COLOR, YEARLY_BAR_COLOR, CONQUER_LEVELS, conquerColor } from './shared.js';

const W = 1080, PAD = 44, CW = W - PAD * 2;   // 圖寬、外邊距、內容寬
const CARD_PAD = 26;
const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
const MAX_HEIGHT = 30000;   // 瀏覽器畫布高度上限（Chrome 約 32,767）

// ---------- 區塊與預設組合 ----------

// missing：可在 ⚙ 進階選項隱藏未達成（預設顯示）；子項目見 subsOf
export const BLOCKS = [
    { id: 'summary', label: '探索率摘要' },
    { id: 'map', label: '迷霧地圖' },
    { id: 'yearly', label: '每年新解鎖', adv: true },   // adv：沒有未達成，但有其他進階選項
    { id: 'conquer', label: '縣市制霸卡', missing: true },
    { id: 'villages', label: '村里探索進度', missing: true },
    { id: 'milestone', label: '里程碑', missing: true },
    { id: 'peak', label: '登山（百岳、小百岳）', missing: true },
    { id: 'rail', label: '鐵路', missing: true },
    { id: 'metro', label: '捷運', missing: true },
    { id: 'lrt', label: '輕軌', missing: true },
    { id: 'pole', label: '極點', missing: true },
    { id: 'island', label: '離島', missing: true },
    { id: 'landmark', label: '景點', missing: true },
    { id: 'bspot', label: 'B 級景點', missing: true },
    { id: 'nature', label: '國家公園與保護區', missing: true },
    { id: 'travel', label: '旅行成就', missing: true },
];
// 預設組合只決定勾哪些區塊；子項目用下面的 DEFAULT_SUB_OFF，切換組合時保留使用者自己改過的
export const PRESETS = [
    { id: 'overview', label: '足跡總覽', blocks: ['summary', 'map', 'yearly'] },
    { id: 'conquer', label: '制霸卡', blocks: ['summary', 'map', 'conquer'] },
    { id: 'villages', label: '村里探索', blocks: ['summary', 'villages'] },
    { id: 'peak', label: '登山', blocks: ['peak'] },
    { id: 'pole', label: '極點', blocks: ['pole'] },
    { id: 'metro', label: '捷運', blocks: ['metro', 'lrt'] },
    { id: 'rail', label: '台鐵', blocks: ['rail'] },
    { id: 'island', label: '離島', blocks: ['island'] },
    { id: 'bspot', label: 'B級景點', blocks: ['bspot'] },
    { id: 'nature', label: '國家公園', blocks: ['nature'] },
];
// 子項目預設關掉的（{ 區塊 id: [子項目 key] }，key 見 subsOf）：捷運只留北捷、新北捷；輕軌只留淡海、安坑；
// 鐵路只留高鐵、臺鐵北部、支線；國家公園與保護區不含野生動物重要棲息環境；登山百岳、小百岳都開
export const DEFAULT_SUB_OFF = {
    metro: ['rail_tymc', 'rail_tmrt', 'rail_krtc', 'rail_maokong'],
    lrt: ['rail_lrt_kaohsiung'],
    rail: ['tra_c', 'tra_s', 'tra_e', 'afr'],
    nature: ['野生動物重要棲息環境'],
};
const defaultSubOff = () => JSON.parse(JSON.stringify(DEFAULT_SUB_OFF));
const UNIT_LABEL = { county: '縣市', town: '鄉鎮', village: '村里' };
// 村里探索進度的縣市選單順序：六都（由北到南）、其他縣市（西部由北到南，再東部由北到南）、離島
const COUNTY_ORDER = [
    ['六都', ['63000', '65000', '68000', '66000', '67000', '64000']],   // 臺北、新北、桃園、臺中、臺南、高雄
    ['其他縣市', ['10017', '10018', '10004', '10005', '10007', '10008', '10009', '10020', '10010', '10013', '10002', '10015', '10014']],
    // 基隆、新竹市、新竹縣、苗栗、彰化、南投、雲林、嘉義市、嘉義縣、屏東、宜蘭、花蓮、臺東
    ['離島', ['10016', '09020', '09007']],   // 澎湖、金門、連江
];
export const NICK_SAMPLE = '小明的足跡';   // 暱稱沒填時預覽用的範例

// 進階選項的子項目：鐵路分臺鐵各區、高鐵、林鐵；登山、捷運、輕軌依成就卡（各山岳清單、各系統）
const RAIL_SUBS = [
    { key: 'hsr', label: '高鐵', ids: ['rail_hsr'] },
    { key: 'tra_n', label: '臺鐵北部（含宜蘭線）', ids: ['rail_tra_wl_north', 'rail_tra_yilan'] },
    { key: 'tra_c', label: '臺鐵中部（山線、海線）', ids: ['rail_tra_mountain', 'rail_tra_coast'] },
    { key: 'tra_s', label: '臺鐵南部（含屏東線、南迴線）', ids: ['rail_tra_wl_south', 'rail_tra_pingtung', 'rail_tra_south_link'] },
    { key: 'tra_e', label: '臺鐵東部（北迴線、臺東線）', ids: ['rail_tra_north_link', 'rail_tra_taitung'] },
    { key: 'tra_b', label: '臺鐵支線', ids: ['rail_tra_pingxi', 'rail_tra_shenao', 'rail_tra_neiwan', 'rail_tra_jiji', 'rail_tra_shalun'] },
    { key: 'afr', label: '阿里山林業鐵路', ids: ['rail_afr'] },
];
const SECTION_SUBS = new Set(['landmark', 'nature']);
/** 區塊的子項目 [{ key, label, ids }]；沒有子項目回傳空陣列 */
export function subsOf(blockId, stats) {
    if (blockId === 'rail') return RAIL_SUBS;
    if (!stats) return [];
    // 景點（北中南東）、國家公園與保護區（各類別）：依成就的 section 分
    if (SECTION_SUBS.has(blockId)) {
        const list = stats.achievements.filter(a => a.group === blockId && !a.cells && a.section);
        return [...new Set(list.map(a => a.section))].map(sec => ({ key: sec, label: sec, ids: list.filter(a => a.section === sec).map(a => a.id) }));
    }
    if (!['peak', 'metro', 'lrt'].includes(blockId)) return [];
    return stats.achievements.filter(a => a.group === blockId && a.cells).map(a => ({ key: a.id, label: a.name, ids: [a.id] }));
}
/** 被進階選項關掉的成就卡 id（o.subOff：{ 區塊 id: [子項目 key] }） */
function offCards(o, blockId, stats) {
    const off = new Set(o.subOff?.[blockId] || []);
    return new Set(subsOf(blockId, stats).filter(x => off.has(x.key)).flatMap(x => x.ids));
}
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
 * @param o 選項 { blocks: Set, missing: Set（顯示未達成的區塊）, subOff: { 區塊: [子項目 key] }, hideDates, hideRegular, nickname, nickSample, mapLevel, mapColor }
 * @param env { stats, meta, maps: { level: {viewBox, paths} } }
 */
function paint(g, o, env) {
    const { stats } = env;
    o = { ...o, mapColor: mapColorOf(o, stats) };
    const C = g.c;
    const date = t => o.hideDates ? null : t ? fmtDate(t) : '時間不明';
    let y = PAD;

    // ---------- 標題 ----------
    g.text('🛂 台灣旅遊護照', PAD, y, { size: 26, weight: 'bold', color: C.accent });
    g.text(MODE_LABEL[stats.mode] || '', W - PAD, y + 6, { size: 17, color: C.muted, align: 'right' });
    y += 44;
    const nick = (o.nickname || '').trim();
    if (nick) { g.text(nick, PAD, y, { size: 46, weight: 'bold', color: C.strong, maxW: CW }); y += 64; }
    else if (o.nickSample) {
        // 預覽用：淡色範例，讓使用者看到暱稱的大小；匯出時不印
        const w = g.text(NICK_SAMPLE, PAD, y, { size: 46, weight: 'bold', color: C.faint });
        g.text('（暱稱範例，沒填不會出現在圖上）', PAD + w + 14, y + 22, { size: 16, color: C.faint });
        y += 64;
    }
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

/** 實際使用的上色：制霸五色只在照片模式的鄉鎮、村里 */
const canConquer = (level, stats) => stats?.mode === 'photo' && level !== 'county' && !!stats.towns?.some(t => t.n !== undefined);
export const mapColorOf = (o, stats) => o.mapColor === 'count' && canConquer(o.mapLevel, stats) ? 'count' : 'year';

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
    const cumul = o.cumul !== false;   // 累積曲線（預設開）
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
        let top = y0 + 26;
        if (cumul) {
            // 圖例：長條＝當年新解鎖、折線＝累積（右側刻度）
            g.rect(x, y0 + 4, 14, 11, { fill: YEARLY_BAR_COLOR, r: 2 });
            let lx = x + 20 + g.text('當年新解鎖', x + 20, y0, { size: 14, color: C.muted }) + 18;
            g.rect(lx, y0 + 9, 20, 2, { fill: C.text });
            g.text('累積', lx + 26, y0, { size: 14, color: C.muted });
            top += 22;
        }
        const H = 220, max = Math.max(...vals, 1);
        const bw = w / labels.length;
        const step = Math.ceil(labels.length / Math.max(1, Math.floor(w / 62)));
        g.rect(x, top + H, w, 1, { fill: C.border });
        // 順序：長條 → 累積折線 → 長條上的數字（數字墊卡片底色，不被折線蓋住）
        vals.forEach((v, i) => {
            const h = v / max * H, bx = x + bw * i + bw * 0.15;
            if (v) g.rect(bx, top + H - h, bw * 0.7, h, { fill: YEARLY_BAR_COLOR, r: 3 });
            if (i % step === 0 || i === labels.length - 1) g.text(labels[i], bx + bw * 0.35, top + H + 8, { size: 14, color: C.muted, align: 'center' });
        });
        const barNumbers = () => vals.forEach((v, i) => {
            if (!v || bw < 34) return;
            const cx = x + bw * i + bw / 2, ty = top + H - v / max * H - 22, str = v.toLocaleString();
            if (cumul) { const tw = g.width(str, 14); g.rect(cx - tw / 2 - 3, ty - 1, tw + 6, 19, { fill: C.surface, r: 4 }); }
            g.text(str, cx, ty, { size: 14, color: C.text, align: 'center' });
        });
        if (!cumul) barNumbers();
        if (cumul) {
            // 累積折線：自己的比例（最高點＝總數），最後一點標數字
            let acc = 0;
            const cum = vals.map(v => (acc += v));
            const pts = cum.map((v, i) => [x + bw * i + bw / 2, top + H - v / Math.max(acc, 1) * H]);
            if (!g.dry) {
                const ctx = g.ctx;
                ctx.beginPath();
                pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
                ctx.strokeStyle = C.text; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
                ctx.stroke();
                ctx.fillStyle = C.text;
                for (const [px, py] of pts) { ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill(); }
            }
            barNumbers();
            const [lx, ly] = pts[pts.length - 1];
            g.text(`累積 ${acc.toLocaleString()}`, Math.min(lx, x + w), ly - 24, { size: 14, weight: 'bold', color: C.text, align: 'right' });
        }
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
        g.text('格子數字為鄉鎮進度：已解鎖鄉鎮市區 / 總數，全部解鎖即制霸', x, yy, { size: 15, color: C.muted });
        yy += 30;
        if (!cells.length) yy = empty(g, x, yy, '還沒有制霸任何縣市（縣市內所有鄉鎮市區都解鎖）');
        else {
            const gap = 10, { cols, cw } = gridCols(w, 128, gap), ch = date(1) ? 74 : 58;
            cells.forEach((c, i) => {
                const cx = x + (i % cols) * (cw + gap), cy = yy + Math.floor(i / cols) * (ch + gap);
                g.rect(cx, cy, cw, ch, c.done ? { fill: C.accent, r: 10 } : { fill: C.surface3, stroke: C.borderStrong, r: 10, dash: [5, 4] });
                const col = c.done ? C.onAccent : C.faint;
                g.text(c.name, cx + cw / 2, cy + 9, { size: 19, weight: 'bold', color: col, align: 'center', maxW: cw - 10 });
                g.text(c.done ? '✓ 制霸' : `鄉鎮 ${c.progress} / ${c.target}`, cx + cw / 2, cy + 35, { size: 14, color: col, align: 'center' });
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

function paintVillages(g, y, { o, env, showMissing }) {
    const C = g.c, st = env.stats;
    // 選了某個縣市（o.vCounty）：改列該縣市各鄉鎮；否則列各縣市
    const county = o.vCounty ? st.counties.find(c => c.code === o.vCounty) : null;
    const rows = county ? st.towns.filter(t => t.county === county.code) : st.counties;
    const s = county ? { unlocked: county.villages_unlocked, total: county.villages } : st.summary.village;
    const list = [...rows].sort((a, b) => (b.villages ? b.villages_unlocked / b.villages : 0) - (a.villages ? a.villages_unlocked / a.villages : 0) || a.code.localeCompare(b.code))
        .filter(c => showMissing || c.villages_unlocked > 0);
    return card(g, y, { title: county ? `村里探索進度・${county.name}各鄉鎮` : '村里探索進度', color: GROUP_COLOR.milestone, right: `${s.unlocked.toLocaleString()} / ${s.total.toLocaleString()} 村里` }, (x, y0, w) => {
        if (!list.length) return empty(g, x, y0, '還沒有解鎖任何村里');
        const rh = 34, nameW = 120, numW = 170, bx = x + nameW, bw = w - nameW - numW;
        list.forEach((c, i) => {
            const cy = y0 + i * rh, r = c.villages ? c.villages_unlocked / c.villages : 0;
            g.text(c.name, x, cy + 4, { size: 18, color: r > 0 ? C.text : C.faint, maxW: nameW - 8 });
            g.rect(bx, cy + 9, bw, 12, { fill: C.surface3, r: 6 });
            if (r > 0) g.rect(bx, cy + 9, Math.max(12, bw * r), 12, { fill: r >= 1 ? GROUP_COLOR.conquer : C.accent, r: 6 });
            g.text(`${c.villages_unlocked} / ${c.villages}（${(r * 100).toFixed(0)}%）`, x + w, cy + 5, { size: 15, color: C.muted, align: 'right' });
        });
        return y0 + list.length * rh - 6;
    });
}

// ---------- 徽章類（里程碑、地點類、旅行） ----------

function paintBadgeGroup(group) {
    return (g, y, { o, env, ach, showMissing, date }) => {
        const C = g.c;
        const off = offCards(o, group, env.stats);   // 進階選項關掉的子類別
        const all = ach.filter(a => a.group === group && !a.cells && !off.has(a.id));
        if (!all.length) return y - 22;
        const list = all.filter(a => showMissing || a.done);
        const done = all.filter(a => a.done).length;
        return card(g, y, { title: BLOCKS.find(b => b.id === group)?.label || GROUP_LABEL[group], color: GROUP_COLOR[group], right: `${done} / ${all.length}` }, (x, y0, w) => {
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
    const off = offCards(opt.o, 'peak', opt.env.stats);
    const lists = ach.filter(a => a.group === 'peak' && a.cells && !off.has(a.id));
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
        const off = offCards(opt.o, group, opt.env.stats);
        const cards = ach.filter(a => a.group === group && a.cells && !off.has(a.id));
        if (!cards.length) return y - 22;
        // 路線制霸的 id 是「成就卡 id_路線」
        const routes = ach.filter(a => a.group === group && !a.cells && a.section === '路線制霸' && ![...off].some(id => a.id.startsWith(id + '_')));
        const cells = cards.flatMap(a => a.cells);
        const shown = cards.filter(a => showMissing || a.progress > 0);
        return card(g, y, { title: BLOCKS.find(b => b.id === group)?.label || GROUP_LABEL[group], color: GROUP_COLOR[group], right: `已到站 ${cells.filter(c => c.done).length} / ${cells.length} 站` }, (x, y0, w) => {
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
const PREF_VER = 2;              // 2：子項目改用 DEFAULT_SUB_OFF（舊版存的子項目不沿用，改回新預設一次）

function loadPref() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; }
}
function savePref(o) {
    try {
        localStorage.setItem(PREF_KEY, JSON.stringify({ v: PREF_VER, preset: o.preset, blocks: [...o.blocks], hideMissing: [...o.hideMissing], subOff: o.subOff, cumul: o.cumul, vCounty: o.vCounty,
            hideDates: o.hideDates, hideRegular: o.hideRegular, nickname: o.nickname, mapLevel: o.mapLevel, mapColor: o.mapColor }));
    } catch (e) { /* 存不了只影響下次 */ }
}

const presetBlocks = id => new Set((PRESETS.find(p => p.id === id) || PRESETS[0]).blocks);

export function createReport({ getStats, loadMap, getMeta }) {
    let modal = null, timer = null, last = null, lastMs = 0;
    const p = loadPref();
    const known = id => id === 'custom' || PRESETS.some(x => x.id === id);
    const o = {
        // 舊版的組合（旅人、完整）已拿掉：保留當時勾的區塊，選單顯示「自訂」
        preset: p.preset ? (known(p.preset) ? p.preset : 'custom') : 'overview',
        blocks: p.blocks ? new Set(p.blocks) : presetBlocks('overview'),
        hideMissing: new Set(p.hideMissing || []),   // 隱藏未達成的區塊（預設都顯示；舊版的 missing 不沿用）
        // 進階選項關掉的子項目
        subOff: p.v === PREF_VER && p.subOff && typeof p.subOff === 'object' ? p.subOff : defaultSubOff(),
        cumul: p.cumul ?? true,          // 每年新解鎖：累積曲線
        vCounty: p.vCounty || '',        // 村里探索進度：只看這個縣市的各鄉鎮（空＝各縣市）
        hideDates: !!p.hideDates,
        hideRegular: p.hideRegular ?? true,
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
                    <span class="rp-scroll-hint">👇 下滑看預覽</span>
                    <button type="button" class="rp-x" data-act="close" title="關閉（Esc）">✕</button>
                </div>
                <div class="rp-main">
                    <div class="rp-opts">
                        <fieldset class="rp-privacy">
                            <legend>🔒 隱私控制</legend>
                            <label class="rp-check"><input type="checkbox" id="rp-hide"> 隱藏月/日
                                <button type="button" class="qtip" data-tip="紀錄時間點只寫年份，避免別人從日期推出你的行程。" aria-label="說明：隱藏月/日">?</button></label>
                            <label class="rp-check" id="rp-regular-row"><input type="checkbox" id="rp-regular"> 隱藏「老地方」</label>
                            <label class="rp-field" id="rp-color-row">地圖上色
                                <select id="rp-color"><option value="year">首次解鎖年份</option><option value="count">制霸五色（照片張數，看得出常去的地方）</option></select></label>
                        </fieldset>
                        <label class="rp-field">預設組合
                            <select id="rp-preset">${PRESETS.map(x => `<option value="${x.id}">${x.label}</option>`).join('')}<option value="custom">自訂</option></select></label>
                        <label class="rp-field">暱稱（選填）
                            <input type="text" id="rp-nick" maxlength="24" placeholder="例如：${NICK_SAMPLE}"></label>
                        <div class="rp-field" role="radiogroup" aria-labelledby="rp-level-title"><span id="rp-level-title">行政區尺度（迷霧地圖、每年新解鎖）</span>
                            <div class="rp-seg" id="rp-level">${[['county', '縣市'], ['town', '鄉鎮'], ['village', '村里']].map(([v, t]) => `
                                <label><input type="radio" name="rp-level" value="${v}"> ${t}${v === 'village'
                                    ? ' <button type="button" class="qtip" data-tip="村里範圍很小，容易被看出住處或常去的地方。" aria-label="說明：村里">?</button>' : ''}</label>`).join('')}
                            </div></div>
                        <div class="rp-blocks-title">區塊 <small>勾選後可在下方隱藏未達成、選項目</small></div>
                        <ul class="rp-blocks" id="rp-blocks">${BLOCKS.map(b => `
                            <li><label class="rp-check"><input type="checkbox" data-block="${b.id}"> ${esc(b.label)}</label>
                                ${b.missing || b.adv ? `<div class="rp-adv" data-adv="${b.id}" hidden></div>` : ''}</li>`).join('')}
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
                    <button type="button" class="rp-btn primary" id="rp-save">${canShareFile() ? '📤 分享／儲存' : '⬇ 下載 PNG'}</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        const $ = id => modal.querySelector('#' + id);
        modal.addEventListener('click', e => {
            if (e.target === modal || e.target.dataset.act === 'close') close();
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal && !modal.hidden) close(); });
        $('rp-preset').addEventListener('change', e => {
            if (e.target.value === 'custom') { o.preset = 'custom'; return; }
            o.preset = e.target.value;
            o.blocks = presetBlocks(o.preset);
            syncForm(); schedule();
        });
        $('rp-nick').addEventListener('input', e => { o.nickname = e.target.value; schedule(400); });
        $('rp-level').addEventListener('change', e => { if (e.target.name === 'rp-level') { o.mapLevel = e.target.value; syncForm(); schedule(); } });
        $('rp-hide').addEventListener('change', e => { o.hideDates = e.target.checked; schedule(); });
        $('rp-regular').addEventListener('change', e => { o.hideRegular = e.target.checked; schedule(); });
        $('rp-color').addEventListener('change', e => { o.mapColor = e.target.value; schedule(); });
        $('rp-blocks').addEventListener('change', e => {
            const t = e.target;
            if (t.dataset.block) { t.checked ? o.blocks.add(t.dataset.block) : o.blocks.delete(t.dataset.block); o.preset = 'custom'; }
            // 進階選項（勾選的區塊下方）：隱藏未達成、子項目
            const id = t.closest('[data-adv]')?.dataset.adv;
            if (id && t.dataset.hidemiss !== undefined) t.checked ? o.hideMissing.add(id) : o.hideMissing.delete(id);
            if (t.dataset.cumul !== undefined) o.cumul = t.checked;
            if (t.dataset.vcounty !== undefined) o.vCounty = t.value;
            if (id && t.dataset.sub) {
                const off = new Set(o.subOff[id] || []);
                t.checked ? off.delete(t.dataset.sub) : off.add(t.dataset.sub);
                if (off.size) o.subOff[id] = [...off]; else delete o.subOff[id];
            }
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
        modal.querySelectorAll('[name="rp-level"]').forEach(r => { r.checked = r.value === o.mapLevel; });
        $('rp-hide').checked = o.hideDates;
        $('rp-regular').checked = o.hideRegular;
        const stats = getStats();
        $('rp-regular-row').hidden = stats?.mode !== 'photo';   // 老地方只在照片模式
        $('rp-color-row').hidden = stats?.mode !== 'photo';
        $('rp-color').value = o.mapColor;
        $('rp-color').disabled = !(o.blocks.has('map') && canConquer(o.mapLevel, stats));
        modal.querySelectorAll('[data-block]').forEach(b => { b.checked = o.blocks.has(b.dataset.block); });
        // 進階選項：區塊有勾才展開
        modal.querySelectorAll('[data-adv]').forEach(box => {
            const id = box.dataset.adv, off = o.subOff[id] || [];
            box.hidden = !o.blocks.has(id);
            const hm = box.querySelector('[data-hidemiss]');
            if (hm) hm.checked = o.hideMissing.has(id);
            const cu = box.querySelector('[data-cumul]');
            if (cu) cu.checked = o.cumul;
            const vc = box.querySelector('[data-vcounty]');
            if (vc) vc.value = vc.querySelector(`option[value="${o.vCounty}"]`) ? o.vCounty : '';
            box.querySelectorAll('[data-sub]').forEach(c => { c.checked = !off.includes(c.dataset.sub); });
        });
        const needMap = o.blocks.has('map') || o.blocks.has('yearly');
        modal.querySelectorAll('[name="rp-level"]').forEach(r => { r.disabled = !needMap; });
        $('rp-level').classList.toggle('off', !needMap);
    }

    /** 各區塊的進階選項內容（子項目依資料而定，每次打開彈窗重畫） */
    function renderAdv() {
        const stats = getStats();
        modal.querySelectorAll('[data-adv]').forEach(box => {
            const id = box.dataset.adv, b = BLOCKS.find(x => x.id === id);
            const subs = subsOf(id, stats);
            box.innerHTML = (id === 'yearly' ? '<label class="rp-check"><input type="checkbox" data-cumul> 累積曲線</label>' : '')
                + (id === 'villages' && stats ? `<label class="rp-field">縣市<select data-vcounty>
                    <option value="">全部縣市</option>
                    ${COUNTY_ORDER.map(([g, codes]) => `<optgroup label="${g}">${codes.map(code => stats.counties.find(c => c.code === code))
                        .filter(Boolean).map(c => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>` : '')
                + (b.missing ? '<label class="rp-check"><input type="checkbox" data-hidemiss> 隱藏未達成</label>' : '')
                + subs.map(x => `<label class="rp-check"><input type="checkbox" data-sub="${esc(x.key)}"> ${esc(x.label)}</label>`).join('');
        });
    }

    /** 給畫圖用的選項：missing 為顯示未達成的區塊 */
    const paintOpts = extra => ({ ...o, missing: new Set(BLOCKS.filter(b => b.missing && !o.hideMissing.has(b.id)).map(b => b.id)), ...extra });

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
        const level = o.mapLevel;
        if (o.blocks.has('map') && !maps[level]) {
            try { maps[level] = await loadMap(level); } catch (e) { /* 地圖載入失敗時區塊顯示「載入中」 */ }
        }
        const stats = getStats();
        if (!stats) return;
        const t0 = performance.now();
        const r = renderReport(paintOpts({ nickSample: true }), { stats, meta: getMeta(), maps });
        last = r;
        r.canvas.className = 'rp-img';
        $('rp-canvas').innerHTML = '';
        $('rp-canvas').appendChild(r.canvas);
        $('rp-status').hidden = !r.tooTall;
        if (r.tooTall) $('rp-status').textContent = '⚠ 內容太長，超出的部分被截掉了；請減少區塊，或在區塊下方隱藏未達成、減少項目';
        $('rp-save').disabled = false;
        $('rp-size').textContent = `${W} × ${r.height.toLocaleString()} px${r.height > 8000 ? '・圖片很長，部分手機 App 可能無法完整顯示' : ''}`;
        lastMs = Math.round(performance.now() - t0);
    }

    async function save() {
        if (!last) return;
        // 預覽圖有暱稱範例時，匯出用不含範例的版本重畫
        const out = (o.nickname || '').trim() ? last : renderReport(paintOpts(), { stats: getStats(), meta: getMeta(), maps });
        const blob = await new Promise(res => out.canvas.toBlob(res, 'image/png'));
        if (!blob) { alert('無法產生圖片（可能是內容太長），請減少區塊後再試。'); return; }
        const filename = `台灣旅遊護照成就報表-${todayStr()}.png`;
        const file = new File([blob], filename, { type: 'image/png' });
        if (canShareFile(file)) {
            try { await navigator.share({ files: [file], title: filename }); document.dispatchEvent(new Event('reportsaved')); return; }
            catch (e) { if (e.name === 'AbortError') return; }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        document.dispatchEvent(new Event('reportsaved'));   // 首頁「匯出卡片」打勾
    }

    function open() {
        if (!modal) build();
        renderAdv();
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
