// 首頁範例圖：用虛構的示範足跡產生「分享成就」的圖片（淺色、深色各一張），存到 img/
//   window.__sample = { done: Promise, files: [{ name, kb, height }] }（給自動化工具讀取）
//
// 示範足跡只用公開圖資裡的座標（車站、山頂、景點），日期由固定種子的亂數產生，每次結果相同；不讀 test/ 的真實資料。

import { FogClient } from '../js/core/client.js';
import { renderReport, BLOCKS } from '../js/report.js';

const DATA = new URL('../data/', location.href).href;
const NICK = '小明';
const OPTS = { blocks: new Set(['summary', 'map', 'yearly', 'conquer']), missing: new Set(BLOCKS.filter(b => b.missing).map(b => b.id)),
               hideDates: false, hideRegular: true, nickname: NICK, mapLevel: 'town', mapColor: 'year' };

// 固定種子的亂數（mulberry32）
let seed = 20261121;
const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (arr, ratio) => arr.filter(() => rand() < ratio);
/** 隨機月份；最後一年只到 10 月，紀錄期間才不會超過製作日期 */
const month = y => 1 + Math.floor(rand() * (y >= 2026 ? 10 : 12));

/** 一趟旅行：某一天（當地時鐘時間當 UTC，秒），途經的點各拍 1～3 張 */
function trip(out, y, m, d, pts) {
    let t = Date.UTC(y, m - 1, d, 8) / 1000;
    for (const [lat, lng] of pts) {
        const n = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < n; i++) {
            out.push([lat + (rand() - 0.5) * 0.0006, lng + (rand() - 0.5) * 0.0006, t]);
            t += 60 + Math.floor(rand() * 900);
        }
    }
}

/** 把點分成幾天走完（環島、登山都會跨好幾天） */
function multiDay(out, y, m, d, pts, perDay) {
    for (let i = 0; i < pts.length; i += perDay) trip(out, y, m, d + Math.floor(i / perDay), pts.slice(i, i + perDay));
}

async function build() {
    const [rail, peaks, ach] = await Promise.all(['rail', 'peaks', 'achievements'].map(f => fetch(DATA + f + '.json').then(r => r.json())));
    const st = sys => rail.stations.filter(s => s.system === sys).map(s => [s.lat, s.lng]);
    const out = [];

    // 住在台北：捷運沿線的日常（2019 起每年都有）
    const trtc = st('trtc');
    for (let y = 2019; y <= 2026; y++) for (let k = 0; k < 6; k++) trip(out, y, month(y), 1 + Math.floor(rand() * 27), pick(trtc, 0.08));
    // 高鐵南下、環島鐵路（臺鐵隔站停）
    trip(out, 2020, 7, 4, st('hsr'));
    multiDay(out, 2022, 2, 1, st('tra').filter((_, i) => i % 2 === 0), 20);
    trip(out, 2023, 10, 14, pick(st('krtc'), 0.5));
    trip(out, 2024, 3, 9, st('afr'));
    // 登山：百岳前段、小百岳一部分
    const baiyue = peaks.lists.find(l => l.id === 'peaks_baiyue').peaks, xiao = peaks.lists.find(l => l.id === 'peaks_xiao').peaks;
    multiDay(out, 2021, 9, 18, baiyue.slice(0, 14).map(p => [p[2], p[3]]), 3);
    multiDay(out, 2025, 8, 2, pick(baiyue.slice(14), 0.12).map(p => [p[2], p[3]]), 2);
    multiDay(out, 2019, 11, 2, pick(xiao, 0.3).map(p => [p[2], p[3]]), 2);
    // 景點、離島、極點：有代表點的挑一部分，分散在各年
    const places = pick(ach.places.map(p => (p.points && p.points[0]) || p.rep).filter(Boolean), 0.45);
    places.forEach((p, i) => trip(out, 2019 + (i % 8), month(2019 + (i % 8)), 1 + Math.floor(rand() * 27), [p]));

    const n = out.length;
    return { lat: Float64Array.from(out, r => r[0]), lng: Float64Array.from(out, r => r[1]), time: Float64Array.from(out, r => r[2]),
             kind: new Uint8Array(n), ref: new Int32Array(n).fill(-1), targets: [] };
}

async function save(name, blob) {
    // 只有 tools/dev_server.py 接受 POST（只能寫 img/ 底下的圖片）；其他伺服器就只在頁面上顯示
    try {
        const r = await fetch('/__save?path=' + encodeURIComponent(name), { method: 'POST', body: blob });
        return r.ok;
    } catch (e) { return false; }
}

async function run() {
    const fog = new FogClient(DATA);
    await fog.init();
    const records = await build();
    const times = [...records.time], count = records.lat.length;   // compute 會把陣列轉移給 Worker，之後就不能讀
    const stats = await fog.compute(records, 'photo');
    const maps = { town: await fetch(DATA + 'map_town.json').then(r => r.json()) };
    const meta = { from: Math.min(...times), to: Math.max(...times), mode: 'photo', manual: 0 };
    const s = stats.summary;
    const files = [];
    const before = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    for (const theme of ['light', 'dark']) {
        window.photoTheme && window.photoTheme.set(theme);
        const r = renderReport(OPTS, { stats, meta, maps });
        const blob = await new Promise(ok => r.canvas.toBlob(ok, 'image/webp', 0.85));
        const name = `img/sample-report-${theme}.webp`;
        const saved = await save(name, blob);
        files.push({ name, kb: Math.round(blob.size / 1024), height: r.height, saved });
        document.getElementById('out').insertAdjacentHTML('beforeend',
            `<figure><img src="${URL.createObjectURL(blob)}" alt=""><figcaption>${name}（${Math.round(blob.size / 1024)} KB，${r.height} px${saved ? '，已存檔' : '，未存檔'}）</figcaption></figure>`);
    }
    window.photoTheme && window.photoTheme.set(before);
    document.getElementById('sum').textContent =
        `示範足跡 ${count.toLocaleString()} 筆：縣市 ${s.county.unlocked}/${s.county.total}、鄉鎮 ${s.town.unlocked}/${s.town.total}、村里 ${s.village.unlocked}/${s.village.total}`;
    return { files, summary: s };
}

window.__sample = { done: run().then(r => Object.assign(window.__sample, r)) };
