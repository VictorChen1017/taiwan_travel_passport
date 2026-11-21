// 匯入的資料來源存在瀏覽器的 IndexedDB（只在這台電腦、這個瀏覽器；不會上傳）
//
// 資料庫 fog、物件庫 sources（keyPath: id）
// 來源物件：{ id, type: 'exif' | 'gphotos' | 'gtimeline' | 'manual', name, added, updated, stats, records: { lat, lng, time, kind } }
// 手動紀錄（type 'manual'，id 固定 'manual'，只有一個）另有 items：[{ id, target, label, lat, lng, time, area, added }]，records 由 items 產生
// IndexedDB 不能用（無痕模式、被封鎖）時，所有操作改成只存在記憶體，頁面照常運作

const DB = 'fog', STORE = 'sources', VERSION = 1;
let dbp = null;
const memory = new Map();   // IndexedDB 不能用時的備援

function open() {
    if (!dbp) {
        dbp = new Promise((resolve) => {
            let req;
            try { req = indexedDB.open(DB, VERSION); } catch (e) { resolve(null); return; }
            req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });
    }
    return dbp;
}

async function tx(mode, fn) {
    const db = await open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store)).then(r => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

const req2p = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** 全部來源（依加入時間） */
export async function listSources() {
    try {
        const all = await tx('readonly', s => s ? req2p(s.getAll()) : [...memory.values()]);
        return (all || []).sort((a, b) => a.added - b.added);
    } catch (e) {
        return [...memory.values()];
    }
}

export async function saveSource(src) {
    memory.set(src.id, src);
    try { await tx('readwrite', s => s && req2p(s.put(src))); } catch (e) { /* 存不了就只留在記憶體 */ }
}

export async function removeSource(id) {
    memory.delete(id);
    try { await tx('readwrite', s => s && req2p(s.delete(id))); } catch (e) { /* 同上 */ }
}

export async function clearSources() {
    memory.clear();
    try { await tx('readwrite', s => s && req2p(s.clear())); } catch (e) { /* 同上 */ }
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
