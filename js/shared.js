// 成就頁（js/explore.js）與成就報表（js/report.js）共用：資料色、徽章圖形、年份色
// 這裡的顏色都是資料色，深淺主題相同（介面色一律用 css/theme.css 的 --c-*）

// 成就等級色
export const TIER_COLOR = { bronze: '#c27c4e', silver: '#8e9aa8', gold: '#e0a526', platinum: '#3fa7c2', legend: '#8b5cf6' };
export const TIER_LABEL = { bronze: '銅', silver: '銀', gold: '金', platinum: '白金', legend: '傳奇' };
export const NO_TIER_COLOR = '#0284c7';   // 不分等級的卡片（鐵道）徽章色，同鐵道分類標題色

// 分類標題色（同 css/explore.css 的 .ex-badge-group-title.g-*）
export const GROUP_COLOR = { milestone: '#ff4d1a', conquer: '#e0a526', pole: '#3fa7c2', island: '#14b8a6', landmark: '#ec4899', bspot: '#7c3aed', peak: '#0f766e', rail: '#0284c7', metro: '#d90023', lrt: '#7cbd52', nature: '#16a34a', travel: '#8b5cf6' };

// 徽章圖示（24×24 座標）
export const ICONS = {
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

// 徽章外框（80×80 座標；[外圈, 內圈]）：里程碑圓形、制霸盾形、地點類與登山鐵道六角形、旅行圓角方形
// 全部寫成 path，SVG 與 Canvas（Path2D）共用同一份
const HEX = ['M40 4 71 22v36L40 76 9 58V22z', 'M40 11 65 25.5v29L40 69 15 54.5v-29z'];
export const SHAPES = {
    milestone: ['M5 40a35 35 0 1 0 70 0a35 35 0 1 0-70 0z', 'M11 40a29 29 0 1 0 58 0a29 29 0 1 0-58 0z'],
    conquer: ['M40 4 70 14v24c0 19-13 32-30 38C23 70 10 57 10 38V14z', 'M40 10 64 18v20c0 15-10 26-24 31C26 64 16 53 16 38V18z'],
    travel: ['M24 6h32a18 18 0 0 1 18 18v32a18 18 0 0 1-18 18H24A18 18 0 0 1 6 56V24A18 18 0 0 1 24 6z',
             'M26 12h28a14 14 0 0 1 14 14v28a14 14 0 0 1-14 14H26a14 14 0 0 1-14-14V26a14 14 0 0 1 14-14z'],
};
export const shapeOf = group => SHAPES[group] || HEX;

/** 顏色加深（amt < 0）或變淺：'#rrggbb' → 'rgb(…)' */
export function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const ch = s => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * (1 + amt))));
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** 徽章的主色與外圈色；未達成時回傳 null（由呼叫端用主題色 --c-badge-off） */
export function badgeColors(a) {
    if (!a.done) return null;
    const color = TIER_COLOR[a.tier] || NO_TIER_COLOR;
    return [color, shade(color, -0.18)];
}

// 迷霧地圖：依首次解鎖年份上色，越早越淡、越近越深
export const EARLY_YEAR = 2015;   // 之前的零星紀錄合併顯示，地圖顏色也從這年起算
export function yearColor(year, y0, y1) {
    const r = y1 > y0 ? Math.max(0, Math.min(1, (year - y0) / (y1 - y0))) : 1;
    const from = [255, 226, 205], to = [232, 74, 23];
    return `rgb(${from.map((v, i) => Math.round(v + (to[i] - v) * r)).join(',')})`;
}
export const YEAR_COLOR_FROM = 'rgb(255,226,205)', YEAR_COLOR_TO = 'rgb(232,74,23)', UNKNOWN_YEAR_COLOR = '#ffcfb5';
export const YEARLY_BAR_COLOR = '#ff8a5c';   // 每年新解鎖長條

// 制霸五色（照片模式，鄉鎮・村里）：依照片張數上色；0 張＝迷霧（主題色 --c-fog）
// min：達到這個張數起用這個顏色；label：圖例的張數區間
export const CONQUER_LEVELS = [
    { min: 1, color: '#ffffff', label: '1–9 張' },
    { min: 10, color: '#4a90e2', label: '10–49 張' },
    { min: 50, color: '#43a047', label: '50–99 張' },
    { min: 100, color: '#fb8c00', label: '100–499 張' },
    { min: 500, color: '#e53935', label: '500 張以上' },
];
export function conquerColor(n) {
    let c = null;
    for (const l of CONQUER_LEVELS) if (n >= l.min) c = l.color;
    return c;
}
