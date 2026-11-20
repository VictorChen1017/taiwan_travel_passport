// 載入 data/ 的靜態資料（各檔雜湊當查詢參數，資料更新後瀏覽器會重新下載）

/** 載入單一檔案；files 為 version.json 的 { 檔名: 雜湊 } */
export async function loadOne(base, name, files = {}) {
    const r = await fetch(`${base}${name}?v=${files[name] || Date.now()}`);
    if (!r.ok) throw new Error(`無法載入 ${name}（HTTP ${r.status}）`);
    return r.json();
}

/**
 * 載入計算需要的靜態資料（明細小地圖用的 shapes.topo.json 另外延遲載入）
 * @param base  data/ 的網址（結尾要有 /）
 * @param onProgress  (已完成檔數, 總檔數) 回呼
 */
export async function loadStatic(base, onProgress = () => {}) {
    const ver = await fetch(base + 'version.json', { cache: 'no-cache' }).then(r => {
        if (!r.ok) throw new Error(`無法載入 version.json（HTTP ${r.status}）`);
        return r.json();
    });
    const files = {
        units: 'units.json',
        achievements: 'achievements.json',
        peaks: 'peaks.json',
        rail: 'rail.json',
        villagesTopo: 'villages.topo.json',
        areasTopo: 'areas.topo.json',
    };
    const entries = Object.entries(files);
    let done = 0;
    const out = { version: ver.version, files: ver.files };
    await Promise.all(entries.map(async ([key, name]) => {
        out[key] = await loadOne(base, name, ver.files);
        onProgress(++done, entries.length);
    }));
    return out;
}
