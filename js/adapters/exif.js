// 資料來源轉接器：照片資料夾（EXIF）
//
// 取得檔案的三種方式（都只在使用者的瀏覽器內讀取）：
//   pickFolder()        showDirectoryPicker（Chrome、Edge）；不支援時回傳 null，改用 <input webkitdirectory>
//   filesFromInput()    <input type="file" webkitdirectory> 的 FileList
//   filesFromDrop()     拖曳進來的資料夾或檔案（DataTransfer）
// 再交給 scanFiles() 在 Worker 解析 EXIF，輸出統一格式的紀錄（docs/SPEC.md §4）

// exifr 讀得到 GPS 的格式（CR3、影片不支援）
const EXT = new Set(['jpg', 'jpeg', 'jfif', 'heic', 'heif', 'avif', 'tif', 'tiff', 'dng', 'cr2', 'nef', 'nrw', 'arw', 'orf', 'rw2', 'pef', 'srw', 'raf', 'png']);
const VIDEO = new Set(['mov', 'mp4', 'm4v', '3gp', 'avi', 'mts', 'm2ts']);
const BATCH = 200;

const extOf = name => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); };
// 略過的資料夾：隱藏資料夾、Synology 縮圖（@eaDir）、資源回收筒
const skipDir = name => name.startsWith('.') || name.startsWith('@') || name === '#recycle' || name === '$RECYCLE.BIN';

export const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

/** 用 showDirectoryPicker 選資料夾；使用者取消回傳 null */
export async function pickFolder() {
    try {
        return await window.showDirectoryPicker({ id: 'fog-photos', mode: 'read' });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}

/** 走訪資料夾 handle，收集檔案；onFound(已找到數) */
export async function filesFromHandle(dir, onFound = () => {}, signal) {
    const out = [];
    const walk = async (d, path) => {
        for await (const h of d.values()) {
            if (signal?.aborted) return;
            if (h.kind === 'directory') {
                if (!skipDir(h.name)) await walk(h, path + h.name + '/');
            } else {
                out.push({ path: path + h.name, get: () => h.getFile() });
                if (out.length % 500 === 0) onFound(out.length);
            }
        }
    };
    await walk(dir, '');
    onFound(out.length);
    return out;
}

/** <input webkitdirectory> 的 FileList */
export function filesFromInput(fileList) {
    return Array.from(fileList)
        .filter(f => !(f.webkitRelativePath || f.name).split('/').slice(0, -1).some(skipDir))
        .map(f => ({ path: f.webkitRelativePath || f.name, get: async () => f }));
}

/** 拖曳進來的項目（資料夾或檔案） */
export async function filesFromDrop(dataTransfer, onFound = () => {}) {
    const out = [];
    const entries = Array.from(dataTransfer.items || []).map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    const readAll = reader => new Promise((resolve, reject) => {
        const all = [];
        const step = () => reader.readEntries(batch => { if (!batch.length) resolve(all); else { all.push(...batch); step(); } }, reject);
        step();
    });
    const walk = async (entry, path) => {
        if (entry.isDirectory) {
            if (skipDir(entry.name)) return;
            for (const child of await readAll(entry.createReader())) await walk(child, path + entry.name + '/');
        } else {
            out.push({ path: path + entry.name, get: () => new Promise((res, rej) => entry.file(res, rej)) });
            if (out.length % 500 === 0) onFound(out.length);
        }
    };
    for (const e of entries) await walk(e, '');
    onFound(out.length);
    return { items: out, name: entries.length === 1 ? entries[0].name : `${entries.length} 個項目` };
}

/**
 * 解析 EXIF。
 * @param items     [{ path, get: () => Promise<File> }]
 * @param onProgress ({ done, total, located }) 回呼
 * @param signal    AbortSignal（取消）
 * @returns 來源物件：{ type: 'exif', stats, records: { lat, lng, time, kind } }
 */
export async function scanFiles(items, onProgress = () => {}, signal) {
    const photos = [], stats = { files: items.length, photos: 0, located: 0, noGps: 0, failed: 0, noTime: 0, videos: 0, other: 0, duplicates: 0 };
    for (const it of items) {
        const ext = extOf(it.path);
        if (EXT.has(ext)) photos.push(it);
        else if (VIDEO.has(ext)) stats.videos++;
        else stats.other++;
    }
    stats.photos = photos.length;

    const lat = [], lng = [], time = [];
    const seen = new Set();   // 同一張照片的多份備份（座標與時間都相同）只算一次
    const worker = new Worker(new URL('../worker/exif.worker.js', import.meta.url), { type: 'module' });
    let seq = 0;
    const parse = files => new Promise((resolve, reject) => {
        const id = ++seq;
        worker.onmessage = e => { if (e.data.id === id) resolve(e.data); };
        worker.onerror = e => reject(new Error(e.message || 'EXIF Worker 錯誤'));
        worker.postMessage({ id, files });
    });
    try {
        let done = 0;
        onProgress({ done, total: photos.length, located: 0 });
        for (let s = 0; s < photos.length; s += BATCH) {
            if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
            const chunk = photos.slice(s, s + BATCH);
            const files = await Promise.all(chunk.map(it => it.get().catch(() => null)));
            const ok = files.map((f, i) => [f, i]).filter(([f]) => f);
            stats.failed += files.length - ok.length;
            const r = await parse(ok.map(([f]) => f));
            for (let k = 0; k < ok.length; k++) {
                if (r.status[k] === 2) { stats.failed++; continue; }
                if (r.status[k] === 1) { stats.noGps++; continue; }
                const key = `${r.lat[k].toFixed(6)},${r.lng[k].toFixed(6)},${r.time[k]}`;
                if (seen.has(key)) { stats.duplicates++; continue; }
                seen.add(key);
                lat.push(r.lat[k]); lng.push(r.lng[k]); time.push(r.time[k]);
                if (Number.isNaN(r.time[k])) stats.noTime++;
            }
            done += chunk.length;
            stats.located = lat.length;
            onProgress({ done, total: photos.length, located: lat.length });
        }
    } finally {
        worker.terminate();
    }

    let from = null, to = null;
    for (const x of time) {
        if (!(x > 0)) continue;
        if (from === null || x < from) from = x;
        if (to === null || x > to) to = x;
    }
    // 台灣範圍內（與計算核心相同的外框；國外照片不參與成就計算）
    stats.taiwan = lat.filter((la, i) => la >= 10 && la <= 26.5 && lng[i] >= 114 && lng[i] <= 124.7).length;
    return {
        type: 'exif',
        stats: { ...stats, from, to },
        records: {
            lat: Float64Array.from(lat), lng: Float64Array.from(lng), time: Float64Array.from(time),
            kind: new Uint8Array(lat.length),   // 0：照片
        },
    };
}
