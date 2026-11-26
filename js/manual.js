// 手動紀錄（docs/SPEC.md §15.3）：沒有照片或時間軸、但確實去過的地點，由使用者在成就明細裡手動加入
//
// 只有一個來源：{ id: 'manual', type: 'manual', name: '手動紀錄', added, updated, items, records }
// items：[{ id, target, label, lat, lng, time, area, added }]
//   target：地點成就 id，或集點卡的「卡片 id#格子編號」（例如 peaks_baiyue#1），
//           或迷霧地圖補點的「village:村里代碼」（kind 5：座標是村里代表點，只解鎖這個村里）
//   time  ：日期中午 12:00（當地時鐘時間當 UTC 的秒數）；沒填日期為 null
//   area  ：以範圍判定的地點（國家公園、離島、保護區）→ kind 4，座標只是代表點，不解鎖村里
// records 由 items 產生（kind 3／4），參與計算時和其他來源一樣；只在造訪模式計入
// 每筆有獨立編號：匯入備份時逐筆合併（兩台各自新增的都保留；刪除不會同步）

import { newId } from './store.js';

export const MANUAL_ID = 'manual';
export const VILL_TARGET = 'village:';   // 迷霧地圖補點的 target 前綴（同 js/core/compute.js）
export const isVillTarget = target => typeof target === 'string' && target.startsWith(VILL_TARGET);

export function emptyManual() {
    const now = Date.now();
    return { id: MANUAL_ID, type: 'manual', name: '手動紀錄', added: now, updated: now, stats: {}, items: [], records: buildRecords([]) };
}

/** items → TypedArray 紀錄（ref 與 items 的順序相同） */
export function buildRecords(items) {
    const n = items.length;
    const r = { lat: new Float64Array(n), lng: new Float64Array(n), time: new Float64Array(n), kind: new Uint8Array(n) };
    items.forEach((it, i) => {
        r.lat[i] = it.lat; r.lng[i] = it.lng;
        r.time[i] = Number.isFinite(it.time) ? it.time : NaN;
        r.kind[i] = it.area ? 4 : isVillTarget(it.target) ? 5 : 3;
    });
    return r;
}

/** 重新產生 records 與統計（items 變動後呼叫） */
export function refresh(src) {
    src.records = buildRecords(src.items);
    const ts = src.items.map(it => it.time).filter(Number.isFinite);
    src.stats = { items: src.items.length, from: ts.length ? Math.min(...ts) : null, to: ts.length ? Math.max(...ts) : null };
    return src;
}

/** 'YYYY-MM-DD' → 當天中午（當地時鐘時間當 UTC）；空字串為 null */
export function dateToTime(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12) / 1000 : null;
}

export function newItem({ target, label, lat, lng, area }, date) {
    return { id: newId(), target, label, lat, lng, time: dateToTime(date), area: !!area, added: Date.now() };
}

/** 同一個地點、同一天（或都沒填日期）已經有手動紀錄 */
export const findSame = (src, target, time) => src.items.find(it => it.target === target && (it.time ?? null) === (time ?? null));

/**
 * 備份裡的手動紀錄逐筆合併進這裡：以編號判斷，這裡沒有的才加入
 * @returns 新增的筆數
 */
export function mergeItems(src, items) {
    const have = new Set(src.items.map(it => it.id));
    let added = 0;
    for (const it of items) if (!have.has(it.id)) { src.items.push(it); have.add(it.id); added++; }
    if (added) { src.updated = Date.now(); refresh(src); }
    return added;
}
