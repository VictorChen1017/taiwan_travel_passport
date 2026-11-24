// 載入 data/ 的靜態資料（各檔雜湊當查詢參數，資料更新後瀏覽器會重新下載）

/**
 * 載入單一檔案；files 為 version.json 的 { 檔名: 雜湊 }
 * onBytes(本次新收到的位元組數)：邊下載邊回報（算的是解壓縮後的大小，和 version.json 的 sizes 同一把尺）
 */
export async function loadOne(base, name, files = {}, onBytes = null) {
    const r = await fetch(`${base}${name}?v=${files[name] || Date.now()}`);
    if (!r.ok) throw new Error(`無法載入 ${name}（HTTP ${r.status}）`);
    if (!onBytes || !r.body?.getReader) return r.json();
    const reader = r.body.getReader(), chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        onBytes(value.length);
    }
    return JSON.parse(await new Blob(chunks).text());
}

/**
 * 載入計算需要的靜態資料（明細小地圖用的 shapes.topo.json 另外延遲載入）
 * @param base  data/ 的網址（結尾要有 /）
 * @param onProgress  ({ done, total, bytes, totalBytes }) 回呼：done／total 為檔數；
 *                    bytes 為已收到的位元組，totalBytes 為總大小（version.json 沒有 sizes 時為 0）
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
    const sizes = ver.sizes || {};
    const totalBytes = entries.every(([, n]) => sizes[n] > 0) ? entries.reduce((s, [, n]) => s + sizes[n], 0) : 0;
    let done = 0, bytes = 0, last = 0;
    const report = force => {
        const now = Date.now();
        if (!force && now - last < 150) return;   // 進度訊息節流
        last = now;
        onProgress({ done, total: entries.length, bytes, totalBytes });
    };
    const out = { version: ver.version, files: ver.files };
    report(true);
    await Promise.all(entries.map(async ([key, name]) => {
        out[key] = await loadOne(base, name, ver.files, n => { bytes += n; report(false); });
        done++;
        report(true);
    }));
    return out;
}
