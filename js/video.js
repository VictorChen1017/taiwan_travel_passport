// 把一連串畫面做成影片（迷霧地圖播放動畫的「匯出影片」用；不用外部套件）
//
// 兩種做法，能用 WebCodecs 就用 WebCodecs：
// 1. WebCodecs（新版 Chrome、Edge、iPhone iOS 16.4 以上）：每一格畫好後直接交給瀏覽器的 H.264 編碼器，
//    每格都標上它在影片裡的時間，再用下面的 Mp4Writer 自己包成 MP4。不用等實際時間（30 秒的影片幾秒就做完），
//    手機卡頓也不會錄進影片（2026-11-27 維護者實測：村里＋全島＋3× 用錄影的方式開頭結尾會卡一下）
// 2. MediaRecorder（其他瀏覽器）：錄一張不在畫面上的 canvas，依實際時間錄；換格時間對準整條時間軸，
//    前一格畫太久下一格就少停一點，總長度不會越錄越長
// 兩種都是畫在不在畫面上的 canvas：按鈕、拉桿不會被錄進去
//
// 用法：const fmt = await videoSupport()  → { engine: 'webcodecs' | 'recorder', ext } 或 null（不能做影片）
//       const { blob, ext } = await makeVideo(fmt, { width, height, count, holdMs(i), draw(ctx, i), onProgress(0~1), signal })

const FPS = 30;
const GOP = FPS * 2;   // 每 2 秒一個關鍵格（拉進度條時才順）
// H.264：High、Main、Baseline，level 4.0（1080×1920 剛好在 level 4.0 的上限內）
const AVC_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.420028'];
const MIMES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** 這個瀏覽器做影片的方式；width、height 是影片尺寸（檢查編碼器支不支援） */
export async function videoSupport(width = 1080, height = 1920) {
    if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
        for (const codec of AVC_CODECS) {
            try {
                const { supported } = await VideoEncoder.isConfigSupported(encoderConfig(codec, width, height));
                if (supported) return { engine: 'webcodecs', ext: 'mp4', codec };
            } catch (e) { /* 換下一個 */ }
        }
    }
    if (typeof MediaRecorder !== 'undefined' && HTMLCanvasElement.prototype.captureStream) {
        const mime = MIMES.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
        if (mime) return { engine: 'recorder', ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm', mime };
    }
    return null;
}

const encoderConfig = (codec, width, height) => ({
    codec, width, height, framerate: FPS, bitrate: 6_000_000,
    avc: { format: 'avc' },   // 輸出 MP4 用的格式（長度前綴＋avcC 設定）
});

/**
 * @param fmt videoSupport() 的結果
 * @param o.width,o.height 影片尺寸（px，偶數）
 * @param o.count 畫面數；o.holdMs(i) 第 i 格停多久；o.draw(ctx, i) 畫第 i 格（每格只畫一次）
 * @param o.onProgress(0~1)；o.signal（AbortSignal，取消）
 */
export function makeVideo(fmt, o) {
    return fmt.engine === 'webcodecs' ? encodeVideo(fmt, o) : recordVideo(fmt, o);
}

// ---------- 1. WebCodecs ----------

async function encodeVideo(fmt, { width, height, count, holdMs, draw, onProgress, signal }) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const mp4 = new Mp4Writer(width, height, FPS);
    let failed = null;
    const enc = new VideoEncoder({
        output: (chunk, meta) => mp4.add(chunk, meta),
        error: e => { failed = e; },
    });
    enc.configure(encoderConfig(fmt.codec, width, height));
    // 每格停的時間換成影格數，用累積時間取整數，總長度才準
    const ends = [];
    let t = 0;
    for (let i = 0; i < count; i++) { t += holdMs(i); ends.push(Math.round(t * FPS / 1000)); }
    const total = ends[count - 1];
    let n = 0;
    try {
        for (let i = 0; i < count; i++) {
            if (signal && signal.aborted) throw new DOMException('取消', 'AbortError');
            draw(ctx, i);
            const base = new VideoFrame(canvas, { timestamp: 0 });
            for (; n < ends[i]; n++) {
                if (failed) throw failed;
                // 同一格重複的影格用同一張畫面（不再複製 canvas）；編碼器的佇列太長就等它消化，記憶體才不會爆
                while (enc.encodeQueueSize > 8) await dequeued(enc);
                const f = new VideoFrame(base, { timestamp: Math.round(n * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
                enc.encode(f, { keyFrame: n % GOP === 0 });
                f.close();
            }
            base.close();
            if (onProgress) onProgress(n / total);
            await yieldTask();   // 讓進度、取消按鈕有機會更新
        }
        await enc.flush();
        if (failed) throw failed;
    } finally {
        if (enc.state !== 'closed') enc.close();
    }
    return { blob: mp4.finish(), ext: 'mp4' };
}

// 讓出執行緒一下：用 MessageChannel 而不是 setTimeout（分頁在背景時 setTimeout 會被放慢到每秒一次）
const yieldTask = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
// 等編碼器消化一格：有 dequeue 事件就等事件，沒有就讓出執行緒
// （另加 100 毫秒的保險：編碼器出錯時不會發 dequeue，不能一直等）
const dequeued = enc => 'ondequeue' in enc
    ? new Promise(r => { enc.addEventListener('dequeue', r, { once: true }); setTimeout(r, 100); })
    : yieldTask();

/**
 * 最簡單的 MP4 封裝：只有一軌 H.264、固定影格率、全部影格放一個 mdat，moov 放在前面（手機、網頁不用下載完就能播）
 * 結構：ftyp、moov（mvhd、trak（tkhd、mdia（mdhd、hdlr、minf（vmhd、dinf、stbl（stsd avc1＋avcC、stts、stss、stsc、stsz、stco））））））、mdat
 */
class Mp4Writer {
    constructor(width, height, fps) {
        this.w = width; this.h = height;
        this.scale = fps * 1000; this.dur = 1000;   // 時間單位：1/(fps×1000) 秒，每格 1000
        this.samples = [];   // Uint8Array
        this.keys = [];      // 關鍵格的編號（從 1 起）
        this.avcC = null;
    }
    add(chunk, meta) {
        if (!this.avcC && meta && meta.decoderConfig && meta.decoderConfig.description) {
            const d = meta.decoderConfig.description;
            this.avcC = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.samples.push(data);
        if (chunk.type === 'key') this.keys.push(this.samples.length);
    }
    finish() {
        if (!this.avcC) throw new Error('編碼器沒有給 H.264 設定');
        const n = this.samples.length, dur = n * this.dur;
        const mdatSize = 8 + this.samples.reduce((a, s) => a + s.length, 0);
        const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
        // stco 要寫 mdat 資料的位置，先用 0 算出 moov 長度，再寫一次
        const moov = off => box('moov', this.mvhd(dur), this.trak(dur, off));
        const offset = ftyp.length + moov(0).length + 8;
        const head = new Uint8Array(8);
        new DataView(head.buffer).setUint32(0, mdatSize);
        head.set(str('mdat'), 4);
        return new Blob([ftyp, moov(offset), head, ...this.samples], { type: 'video/mp4' });
    }
    mvhd(dur) {
        return fullBox('mvhd', 0, 0, u32(0), u32(0), u32(this.scale), u32(dur), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
    }
    trak(dur, off) {
        const { w, h } = this;
        const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), zeros(4), u32(dur), zeros(8), u16(0), u16(0), u16(0), zeros(2), MATRIX, u32(w << 16), u32(h << 16));
        const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(this.scale), u32(dur), u16(0x55c4), u16(0));   // 語言 und
        const hdlr = fullBox('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('VideoHandler\0'));
        const vmhd = fullBox('vmhd', 0, 1, zeros(8));
        const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
        const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(0x18), u16(0xffff),
            box('avcC', this.avcC));
        const n = this.samples.length;
        const stbl = box('stbl',
            fullBox('stsd', 0, 0, u32(1), avc1),
            fullBox('stts', 0, 0, u32(1), u32(n), u32(this.dur)),
            fullBox('stss', 0, 0, u32(this.keys.length), ...this.keys.map(u32)),
            fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
            fullBox('stsz', 0, 0, u32(0), u32(n), ...this.samples.map(s => u32(s.length))),
            fullBox('stco', 0, 0, u32(1), u32(off)));
        return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl)));
    }
}

const MATRIX = cat(...[0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; }
function zeros(n) { return new Uint8Array(n); }
function str(s) { return Uint8Array.from(s, c => c.charCodeAt(0)); }
function cat(...parts) {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
function box(type, ...parts) {
    const body = cat(...parts);
    return cat(u32(8 + body.length), str(type), body);
}
function fullBox(type, version, flags, ...parts) {
    return box(type, u32((version << 24) | flags), ...parts);
}

// ---------- 2. MediaRecorder（不支援 WebCodecs 時） ----------

async function recordVideo(fmt, { width, height, count, holdMs, draw, onProgress, signal }) {
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
        // 換格時間對準整條時間軸（從開始錄算起）：前一格畫太久，這一格就少停一點
        const t0 = performance.now();
        let end = 0;
        for (let i = 0; i < count; i++) {
            if (signal && signal.aborted) throw new DOMException('取消', 'AbortError');
            if (i > 0) { draw(fctx, i); octx.drawImage(frame, 0, 0); }
            end += holdMs(i);
            await wait(Math.max(0, t0 + end - performance.now()), signal);
            if (onProgress) onProgress(end / total);
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
