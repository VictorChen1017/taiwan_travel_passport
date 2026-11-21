// 資料備份與轉移：匯入的資料來源 ⇄ 一般 .json 檔（docs/SPEC.md §15.2）
//
// 用途：備份、換電腦、轉到手機（在手機開網站 → 匯入備份）。檔案含有位置紀錄，由使用者自行保管；全程不經伺服器。
//
// 格式（version 1）：
// {
//   "format": "taiwan-travel-passport-backup",
//   "version": 1,
//   "exported": "2026-11-20T23:00:00+08:00",
//   "note": "…",
//   "settings": { "includePath": false },
//   "sources": [
//     { "id": "…", "type": "exif" | "gphotos" | "gtimeline" | "manual", "name": "…",
//       "added": 1795…（加入時間，毫秒）, "updated": 1795…（最後修改時間，毫秒；匯入時用來比新舊）,
//       "stats": {…}, "formats": {…}（時間軸才有）,
//       "fields": ["lat", "lng", "time", "kind"],
//       "records": [
//         [25.0330000, 121.5654000, 1700000000, 0],    ← 每筆一行
//         …
//       ] }
//   ]
// }
// time：當地時鐘時間當成 UTC 的 unix 秒（docs/SPEC.md §5），不明為 null
// kind：0 照片、1 停留點、2 移動途中、3 手動紀錄、4 以範圍判定地點的手動紀錄（座標為代表點）
// 手動紀錄（type "manual"）的每一行多四個欄位：[緯度, 經度, 時間, 類型, 編號, 對象, 名稱, 加入時間]，匯入時以編號逐筆合併
// 座標原樣保存（不四捨五入），來回匯出匯入後計算結果完全相同

export const FORMAT = 'taiwan-travel-passport-backup';
export const VERSION = 1;
const TYPES = new Set(['exif', 'gphotos', 'gtimeline', 'manual']);
const FIELDS = ['lat', 'lng', 'time', 'kind'];
const MANUAL_FIELDS = [...FIELDS, 'id', 'target', 'label', 'added'];
const pad = n => String(n).padStart(2, '0');

/** 本地時間的 ISO 字串（含時區），只用在檔頭與檔名 */
function nowIso() {
    const d = new Date(), off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-', a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// 座標原樣保存（JavaScript 能精確還原的最短表示）：正好落在村里界線上的點，差幾公釐就可能判到隔壁村里
const num = x => Number.isFinite(x) ? String(x) : 'null';

/**
 * 產生備份檔
 * @param sources  來源物件陣列（js/store.js 的格式）
 * @param settings { includePath }
 * @returns { blob, filename, size, count }
 */
export function exportBackup(sources, settings = {}) {
    const exported = nowIso();
    const parts = [];
    let count = 0;
    parts.push('{\n');
    parts.push(`  "format": ${JSON.stringify(FORMAT)},\n  "version": ${VERSION},\n  "exported": ${JSON.stringify(exported)},\n`);
    parts.push(`  "note": ${JSON.stringify('台灣旅遊護照的資料備份。這個檔案含有你的位置紀錄（座標與時間），請自行保管，不要公開分享。')},\n`);
    parts.push(`  "settings": ${JSON.stringify({ includePath: !!settings.includePath })},\n`);
    parts.push('  "sources": [\n');
    sources.forEach((s, si) => {
        const head = { id: s.id, type: s.type, name: s.name, added: s.added, updated: s.updated || s.added, stats: s.stats || {} };
        if (s.formats) head.formats = s.formats;
        const headJson = JSON.stringify(head);
        const manual = s.type === 'manual' && Array.isArray(s.items);
        parts.push(`    ${headJson.slice(0, -1)},\n      "fields": ${JSON.stringify(manual ? MANUAL_FIELDS : FIELDS)},\n      "records": [\n`);
        const R = s.records, n = R.lat.length;
        const lines = new Array(n);
        for (let i = 0; i < n; i++) {
            const t = R.time[i];
            lines[i] = `        [${num(R.lat[i])}, ${num(R.lng[i])}, ${Number.isFinite(t) ? Math.round(t) : 'null'}, ${R.kind[i]}`;
            // 手動紀錄多存編號、對象、名稱、加入時間（匯入時逐筆合併用）
            if (manual) { const it = s.items[i]; lines[i] += `, ${JSON.stringify(it.id)}, ${JSON.stringify(it.target)}, ${JSON.stringify(it.label || '')}, ${+it.added || 0}`; }
            lines[i] += ']';
        }
        count += n;
        parts.push(lines.join(',\n'));
        parts.push(`\n      ]\n    }${si < sources.length - 1 ? ',' : ''}\n`);
    });
    parts.push('  ]\n}\n');
    const blob = new Blob(parts, { type: 'application/json' });
    return { blob, filename: `台灣旅遊護照備份-${exported.slice(0, 10)}.json`, size: blob.size, count, exported };
}

/**
 * 讀取備份檔（文字）。格式不對時丟出錯誤，訊息給使用者看
 * @returns { sources, settings, exported }
 */
export function parseBackup(text) {
    let d;
    try { d = JSON.parse(text); } catch (e) { throw new Error('這不是有效的 JSON 檔案'); }
    if (!d || d.format !== FORMAT) throw new Error('這不是台灣旅遊護照的備份檔');
    if (typeof d.version !== 'number' || d.version > VERSION) throw new Error(`備份檔版本（${d.version}）比網站新，請重新整理網站後再試`);
    if (!Array.isArray(d.sources)) throw new Error('備份檔裡沒有資料來源');
    const sources = d.sources.map((s, si) => {
        if (!TYPES.has(s.type)) throw new Error(`第 ${si + 1} 個來源的類型看不懂：${s.type}`);
        if (!Array.isArray(s.records)) throw new Error(`第 ${si + 1} 個來源沒有紀錄`);
        const n = s.records.length;
        const lat = new Float64Array(n), lng = new Float64Array(n), time = new Float64Array(n), kind = new Uint8Array(n);
        const manual = s.type === 'manual', items = [];
        let bad = 0, o = 0;
        for (const r of s.records) {
            const [la, lo, t, k, mid, target, label, added] = Array.isArray(r) ? r : [];
            if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180) || !(k >= 0 && k <= 4)) { bad++; continue; }
            if (manual) {
                if (typeof mid !== 'string' || !mid || typeof target !== 'string') { bad++; continue; }
                items.push({ id: mid, target, label: String(label || ''), lat: la, lng: lo, time: t == null ? null : +t, area: k === 4, added: +added || 0 });
            }
            lat[o] = la; lng[o] = lo; time[o] = t == null ? NaN : +t; kind[o] = k; o++;
        }
        const src = {
            id: typeof s.id === 'string' && s.id ? s.id : `b${Date.now().toString(36)}${si}`,
            type: s.type, name: String(s.name || '未命名'), added: +s.added || Date.now(), updated: +s.updated || +s.added || Date.now(), stats: s.stats || {},
            records: { lat: lat.slice(0, o), lng: lng.slice(0, o), time: time.slice(0, o), kind: kind.slice(0, o) },
            restored: { from: d.exported || null, bad },
        };
        if (s.formats) src.formats = s.formats;
        if (manual) src.items = items;
        return src;
    });
    return { sources, settings: d.settings || {}, exported: d.exported || null };
}
