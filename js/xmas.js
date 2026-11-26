// 節慶活動集點卡的像素場景：成就頁（SVG，js/explore.js）與分享成就（Canvas、GIF 動圖，js/report.js）共用同一份像素資料
// 場景依成就的 scene（tools/config/achievements.php 的 festivals）挑選：新增節慶時在 SCENES 加一張
//   像素格式 [x, y, w, h, 顏色, 閃爍組（0 不閃；1–4）]；閃爍組在成就頁用 CSS、動圖用 XMAS_FRAMES 格輪流變暗
//
// xmas：新北撒旦城（星空、月亮、板橋站周邊大樓剪影、耶誕樹）
// 大樓是示意剪影：新北市政府（頂部鏤空框架）、板橋車站（低矮長形）、大遠百（雙塔）

import { XMAS_COLORS as C } from './shared.js';

export const XMAS_W = 200, XMAS_H = 54;   // 像素格數（寬、高）；左邊 80 格是一般住宅（成就頁的戳章疊在這裡），地標與耶誕樹在右邊
const OX = 80;                            // 地標區的起點
const GROUND = 48;                        // 地面的 y

let cache = null;

/** 像素清單 [x, y, w, h, 顏色, 閃爍（0 不閃；1–4 閃爍組）] */
function xmasPixels() {
    if (cache) return cache;
    const px = [];
    const put = (x, y, w, h, c, tw = 0) => px.push([x, y, w, h, c, tw]);
    // 固定種子的亂數：每次畫出來都一樣
    let seed = 20111224;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

    // 夜空：由上而下分段變亮（像素風的色階）
    const band = Math.ceil(GROUND / C.sky.length);
    C.sky.forEach((c, i) => put(0, i * band, XMAS_W, Math.min(band, GROUND - i * band), c));

    // 月亮（彎月）：右上角、耶誕樹右邊（左上角是成就頁的標題）
    const MX = 193;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dy * dy <= 16 && (dx - 2) ** 2 + (dy + 1) ** 2 > 11) put(MX + dx, 7 + dy, 1, 1, C.moon);
    }

    // 星星：小星點＋幾顆十字亮星（會閃）
    for (let k = 0; k < 100; k++) {
        const x = Math.floor(rnd() * XMAS_W), y = Math.floor(rnd() * 30);
        if (Math.abs(x - MX) < 7 && y < 13) continue;   // 避開月亮
        put(x, y, 1, 1, C.star[k % 3], rnd() < 0.35 ? 1 + (k % 4) : 0);
    }
    [[34, 5], [58, 3], [76, 9], [110, 4], [48, 15], [6, 20], [138, 6], [156, 14], [146, 4], [122, 18]].forEach(([x, y], k) => {
        const c = C.star[k % 2], tw = 1 + (k % 4);
        put(x, y - 1, 1, 3, c, tw); put(x - 1, y, 3, 1, c, tw);
    });

    // 遠景：低矮的大樓群
    for (let x = 0; x < XMAS_W;) {
        const w = 4 + Math.floor(rnd() * 6), h = 8 + Math.floor(rnd() * 10);
        put(x, GROUND - h, w, h, C.far);
        x += w;
    }

    // 近景的窗戶：在大樓範圍內隨機亮燈
    const windows = (x, y, w, h, rate = 0.35) => {
        for (let yy = y + 2; yy < y + h - 1; yy += 2) for (let xx = x + 1; xx < x + w - 1; xx += 2) {
            if (rnd() < rate) put(xx, yy, 1, 1, C.win[rnd() < 0.7 ? 0 : 1]);
        }
    };
    const tower = (x, top, w, rate) => { put(x, top, w, GROUND - top, C.near); windows(x, top, w, GROUND - top, rate); };

    // 左邊的一般住宅（較矮）
    [[2, 34, 8], [12, 28, 9], [23, 36, 6], [31, 30, 10], [44, 38, 7], [53, 32, 9], [64, 36, 7]].forEach(([x, top, w]) => tower(x, top, w, 0.3));
    tower(OX + 2, 30, 12, 0.3);
    // 新北市政府：高樓＋頂部鏤空框架
    tower(OX + 17, 13, 12, 0.45);
    put(OX + 17, 8, 2, 5, C.near); put(OX + 27, 8, 2, 5, C.near); put(OX + 17, 7, 12, 2, C.near);
    put(OX + 22, 4, 1, 3, C.near); put(OX + 22, 3, 1, 1, C.beacon, 2);   // 避雷針的航空警示燈
    tower(OX + 30, 26, 5, 0.3);
    // 板橋車站：低矮長形，中段較高，一排玻璃帷幕
    put(OX + 36, 36, 26, GROUND - 36, C.near);
    put(OX + 44, 32, 10, 4, C.near);
    put(OX + 37, 39, 24, 2, C.glass);
    put(OX + 45, 34, 8, 1, C.glass);
    windows(OX + 36, 41, 26, GROUND - 41, 0.25);
    // 大遠百雙塔
    tower(OX + 65, 18, 7, 0.4); put(OX + 67, 16, 3, 2, C.near);
    tower(OX + 74, 15, 7, 0.4); put(OX + 76, 13, 3, 2, C.near); put(OX + 77, 11, 1, 2, C.near); put(OX + 77, 10, 1, 1, C.beacon, 3);
    tower(OX + 83, 34, 4, 0.3);
    tower(OX + 108, 24, 11, 0.35);                   // 右側大樓

    // 地面與廣場
    put(0, GROUND, XMAS_W, XMAS_H - GROUND, C.ground);
    put(0, GROUND, XMAS_W, 1, C.plaza);

    // 耶誕樹（三層）：左半亮綠、右半暗綠
    const cx = OX + 96;
    const tiers = [[13, 24, 1, 6], [21, 34, 3, 10], [31, 45, 5, 14]];   // [起 y, 迄 y, 頂半寬, 底半寬]
    const inTree = [];
    for (const [y0, y1, w0, w1] of tiers) {
        for (let y = y0; y <= y1; y++) {
            const hw = Math.round(w0 + (w1 - w0) * (y - y0) / (y1 - y0));
            put(cx - hw, y, hw, 1, C.tree);
            put(cx, y, hw + 1, 1, C.treeDark);
            for (let x = cx - hw + 1; x < cx + hw; x++) inTree.push([x, y]);
        }
    }
    put(cx - 2, 46, 5, GROUND - 46, C.trunk);
    // 彩燈：在樹裡挑位置（固定種子），會閃
    for (let k = 0; k < 34; k++) {
        const [x, y] = inTree[Math.floor(rnd() * inTree.length)];
        put(x, y, 1, 1, C.lights[k % C.lights.length], 1 + (k % 4));
    }
    // 樹頂星星
    put(cx, 8, 1, 5, C.top, 2); put(cx - 2, 10, 5, 1, C.top, 2);
    put(cx - 1, 9, 3, 3, C.top);
    // 地面上樹的光暈
    put(cx - 16, GROUND, 33, 1, C.glow);

    cache = px;
    return px;
}

/** 場景表：id → { w, h（像素格數）, pixels() } */
export const SCENES = {
    xmas: { w: XMAS_W, h: XMAS_H, pixels: xmasPixels },
};
const sceneOf = id => SCENES[id] || SCENES.xmas;
/** 場景的像素格數 [寬, 高] */
export const sceneSize = id => { const sc = sceneOf(id); return [sc.w, sc.h]; };

/** 成就頁用的 SVG（閃爍由 css/explore.css 的 .xm-tw1～4 控制） */
export function sceneSvg(id, cls = '') {
    const sc = sceneOf(id);
    const body = sc.pixels().map(([x, y, w, h, c, tw]) =>
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"${tw ? ` class="xm-tw${tw}"` : ''}/>`).join('');
    return `<svg class="${cls}" viewBox="0 0 ${sc.w} ${sc.h}" shape-rendering="crispEdges" preserveAspectRatio="xMaxYMax slice" aria-hidden="true">${body}</svg>`;
}

// 動圖：一輪 XMAS_FRAMES 格，閃爍組 tw 在第 (tw-1)*2、(tw-1)*2+1 格變暗（同成就頁 CSS 的 25% 不透明）
export const XMAS_FRAMES = 8, XMAS_FRAME_MS = 400;
const dimmed = (tw, frame) => frame >= 0 && tw > 0 && Math.floor(frame / 2) === tw - 1;

/**
 * 分享成就用：把夜景鋪滿 Canvas 的 (x, y, w, h)（同成就頁 xMaxYMax slice：右下對齊，多的從左上裁掉）
 * frame：動圖的第幾格（-1＝靜態，全部亮著）
 */
export function paintScene(ctx, id, x, y, w, h, frame = -1) {
    const sc = sceneOf(id);
    const s = Math.max(w / sc.w, h / sc.h);
    const ox = x + w - sc.w * s, oy = y + h - sc.h * s;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (const [px, py, pw, ph, c, tw] of sc.pixels()) {
        ctx.fillStyle = c;
        ctx.globalAlpha = dimmed(tw, frame) ? 0.25 : 1;
        // 取整避免相鄰像素之間出現細縫
        const x0 = Math.round(ox + px * s), y0 = Math.round(oy + py * s);
        ctx.fillRect(x0, y0, Math.round(ox + (px + pw) * s) - x0, Math.round(oy + (py + ph) * s) - y0);
    }
    ctx.restore();
}

/** 年份戳章的傾斜角度（度；每年固定，看起來像隨手蓋的） */
export const stampTilt = year => ((year * 37) % 17) - 8;
