// 把一連串畫面錄成影片（迷霧地圖播放動畫的「匯出影片」用；不用外部套件）
// - 用瀏覽器內建的 MediaRecorder 錄一張不在畫面上的 canvas：按鈕、拉桿都不會被錄進去
// - 優先 MP4（iPhone Safari、新版 Chrome 都支援，分享到 LINE／IG 不受限）；瀏覽器不支援才用 WebM
// - 依實際時間錄（每格停多久就錄多久），所以錄製時間等於影片長度
//
// 用法：const rec = await recordVideo({ width, height, count, holdMs(i), draw(ctx, i), onProgress(0~1), signal })
//       → { blob, ext }；不支援時丟出錯誤

const MIMES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
const FPS = 30;

/** 瀏覽器可以錄的影片格式（{ mime, ext }）；不能錄為 null */
export function videoFormat() {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
    const mime = MIMES.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
    return mime ? { mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' } : null;
}

/**
 * @param o.width,o.height 影片尺寸（px）
 * @param o.count 畫面數；o.holdMs(i) 第 i 格停多久；o.draw(ctx, i) 畫第 i 格（每格只畫一次，之後重複貼上）
 * @param o.onProgress(0~1)；o.signal（AbortSignal，取消錄製）
 */
export async function recordVideo({ width, height, count, holdMs, draw, onProgress, signal }) {
    const fmt = videoFormat();
    if (!fmt) throw new Error('這個瀏覽器不支援錄製影片');
    // 錄的 canvas：每 1/30 秒把目前這格貼上一次（canvas 有更新，錄影才會持續產生畫面）
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const octx = out.getContext('2d');
    // 每格先畫在另一張 canvas（村里地圖要畫幾千個區域，不能每 1/30 秒重畫）
    const frame = document.createElement('canvas');
    frame.width = width; frame.height = height;
    const fctx = frame.getContext('2d');

    const total = Array.from({ length: count }, (_, i) => holdMs(i)).reduce((a, b) => a + b, 0);
    draw(fctx, 0);
    octx.drawImage(frame, 0, 0);

    const stream = out.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(1000);

    let pump = 0;
    try {
        pump = setInterval(() => octx.drawImage(frame, 0, 0), 1000 / FPS);
        let elapsed = 0;
        for (let i = 0; i < count; i++) {
            if (signal && signal.aborted) throw new DOMException('取消', 'AbortError');
            if (i > 0) { draw(fctx, i); octx.drawImage(frame, 0, 0); }
            const ms = holdMs(i);
            await wait(ms, signal);
            elapsed += ms;
            if (onProgress) onProgress(elapsed / total);
        }
    } finally {
        clearInterval(pump);
        if (rec.state !== 'inactive') rec.stop();
        await stopped;
        stream.getTracks().forEach(t => t.stop());
    }
    return { blob: new Blob(chunks, { type: fmt.mime.split(';')[0] }), ext: fmt.ext };
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('取消', 'AbortError')); }, { once: true });
    });
}
