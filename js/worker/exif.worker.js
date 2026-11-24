// EXIF 解析 Worker（module worker）：只讀照片檔頭的 GPS 與拍攝時間，不讀整張照片
//
// 訊息（主執行緒 → Worker）：{ id, files: File[] }（一批）
// 回覆：{ id, lat: Float64Array, lng: Float64Array, time: Float64Array, status: Uint8Array }
//   status：0 有座標、1 沒有 GPS、2 讀取失敗
//   time：「當地時鐘時間當成 UTC」的 unix 秒（DateTimeOriginal 本身就是當地時間，直接當 UTC 解讀）；沒有則 NaN
//
// 套件：exifr 7.1.3 完整版（HEIC、JPEG、TIFF 系 RAW、PNG），放在 vendor/，不從 CDN 載入

import exifr from '../../vendor/exifr-7.1.3/full.esm.mjs';

const CONCURRENCY = 8;
const OPTIONS = {
    // 只要 GPS 與時間：其他區塊都不解析
    tiff: true, exif: true, gps: true,
    ifd1: false, interop: false, makerNote: false, userComment: false,
    xmp: false, icc: false, iptc: false, jfif: false, ihdr: false,
    pick: ['GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef', 'DateTimeOriginal', 'CreateDate', 'DateTimeDigitized'],
    reviveValues: false,   // 日期保留原始字串，自己當 UTC 解讀；GPS 保留 [度, 分, 秒]
    translateValues: false,
    translateKeys: true,
    chunked: true,         // 只讀需要的片段
    firstChunkSize: 64 * 1024,
};

/** 'YYYY:MM:DD HH:MM:SS' → unix 秒（當 UTC 解讀）；無效回傳 NaN */
function parseExifDate(s) {
    if (typeof s !== 'string') return NaN;
    const m = s.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return NaN;
    const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
    if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
    return Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
}

/** [度, 分, 秒] 與方位 → 十進位度數 */
function dms(v, ref) {
    if (v == null) return NaN;
    const a = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : [v];
    const deg = (+a[0] || 0) + (+a[1] || 0) / 60 + (+a[2] || 0) / 3600;
    return ref === 'S' || ref === 'W' ? -deg : deg;
}

async function parseOne(file) {
    try {
        const t = await exifr.parse(file, OPTIONS);
        if (!t) return [NaN, NaN, NaN, 1];
        const time = parseExifDate(t.DateTimeOriginal ?? t.CreateDate ?? t.DateTimeDigitized);
        const lat = dms(t.GPSLatitude, t.GPSLatitudeRef), lng = dms(t.GPSLongitude, t.GPSLongitudeRef);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            return [NaN, NaN, time, 1];
        }
        return [lat, lng, time, 0];
    } catch (e) {
        return [NaN, NaN, NaN, 2];
    }
}

onmessage = async e => {
    const { id, files } = e.data;
    const n = files.length;
    const lat = new Float64Array(n), lng = new Float64Array(n), time = new Float64Array(n), status = new Uint8Array(n);
    let next = 0;
    const work = async () => {
        while (next < n) {
            const i = next++;
            [lat[i], lng[i], time[i], status[i]] = await parseOne(files[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, work));
    postMessage({ id, lat, lng, time, status }, [lat.buffer, lng.buffer, time.buffer, status.buffer]);
};
