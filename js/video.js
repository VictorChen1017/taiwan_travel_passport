// 把一連串畫面做成影片（迷霧地圖播放動畫的「匯出影片」用；不用外部套件）
//
// 兩種做法，能用 WebCodecs 就用 WebCodecs：
// 1. WebCodecs（新版 Chrome、Edge、iPhone iOS 16.4 以上）：每一格畫好後直接交給瀏覽器的 H.264 編碼器，
//    每格都標上它在影片裡的時間，再用下面的 Mp4Writer 自己包成 MP4。不用等實際時間，手機卡頓也不會錄進影片
//    （2026-11-27 維護者實測：村里＋全島＋3× 用錄影的方式開頭結尾會卡一下）。
//    畫面是一格一格靜止的，所以每個時間格只編一張、直接標它停多久（可變影格率，手機相機拍的影片也是這樣）；
//    停超過 1 秒的每秒補一張，拉進度條才順。編碼張數約為固定 30fps 的五分之一（電腦的編碼器常是軟體編碼，比手機慢很多）
// 2. MediaRecorder（其他瀏覽器）：錄一張不在畫面上的 canvas，依實際時間錄；換格時間對準整條時間軸，
//    前一格畫太久下一格就少停一點，總長度不會越錄越長
// 兩種都是畫在不在畫面上的 canvas：按鈕、拉桿不會被錄進去
//
// 用法：const fmt = await videoSupport()  → { engine: 'webcodecs' | 'recorder', ext } 或 null（不能做影片）
//       const { blob, ext } = await makeVideo(fmt, { width, height, count, holdMs(i), draw(ctx, i), onProgress(0~1, 已完成格數), signal })

const FPS = 30;                 // MediaRecorder 的影格率；WebCodecs 平均影格率的上限
const MAX_HOLD_US = 1_000_000;  // WebCodecs：一張最多停 1 秒，再久就補一張
const KEY_US = 2_000_000;       // 至少每 2 秒一個關鍵格（拉進度條時才順）
// H.264：High 4.2（30 Mbps 超過 level 4.0 的 25 Mbps 上限）、High 5.0／5.1（有些電腦的硬體編碼器要更高的 level）、Main、Baseline
const AVC_CODECS = ['avc1.64002a', 'avc1.640032', 'avc1.640033', 'avc1.640028', 'avc1.4d002a', 'avc1.42002a'];
const MIMES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** 這個瀏覽器做影片的方式；width、height 是影片尺寸（檢查編碼器支不支援） */
export async function videoSupport(width = 1080, height = 1920) {
    if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
        // 先試固定畫質（quantizer：直接指定每張的量化值），不支援再用位元率
        for (const quantizer of [true, false]) {
            for (const codec of AVC_CODECS) {
                try {
                    const { supported } = await VideoEncoder.isConfigSupported(encoderConfig(codec, width, height, FPS, quantizer));
                    if (supported) return { engine: 'webcodecs', ext: 'mp4', codec, quantizer };
                } catch (e) { /* 換下一個 */ }
            }
        }
    }
    if (typeof MediaRecorder !== 'undefined' && HTMLCanvasElement.prototype.captureStream) {
        const mime = MIMES.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
        if (mime) return { engine: 'recorder', ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm', mime };
    }
    return null;
}

// 畫質（2026-11-27 維護者回饋：電腦匯出的影片很小、細的村里界糊掉）：
// - 能用固定畫質就用（bitrateMode 'quantizer'，每張量化值 QP，越小越清楚）：電腦的硬體編碼器遇到變化少的畫面時
//   不會用滿設定的位元率（實測 8.8 秒只有 180 KB、關鍵格 15 KB），直接指定畫質才穩定
// - 不支援（例如 Safari）才用位元率 30 Mbps（維護者要求）。framerate 給實際的平均影格率：
//   編碼器依「位元率 ÷ 影格率」分配每張的資料量，每格只編一張時實際約每秒 5～6 張，若照 30 給，每張只分到 1/5
const QP = 18;
const BITRATE = 30_000_000;
const encoderConfig = (codec, width, height, framerate = FPS, quantizer = false) => ({
    codec, width, height, framerate,
    ...(quantizer ? { bitrateMode: 'quantizer' } : { bitrate: BITRATE }),
    avc: { format: 'avc' },   // 輸出 MP4 用的格式（長度前綴＋avcC 設定）
});
// 色彩：自己把畫面轉成 BT.709 有限範圍（16～235）的 I420 再交給編碼器，並在 MP4 寫上 colr 標記。
// 交給編碼器自己轉時，有些電腦輸出全範圍卻沒標記，播放器當成有限範圍 → 顏色偏青、偏淡（2026-11-27 實測背景色 219,236,255 變成 241,255,255）
const COLOR = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

/**
 * @param fmt videoSupport() 的結果
 * @param o.width,o.height 影片尺寸（px，偶數）
 * @param o.count 畫面數；o.holdMs(i) 第 i 格停多久；o.draw(ctx, i) 畫第 i 格（每格只畫一次）
 * @param o.onProgress(0~1, 已完成格數)；o.signal（AbortSignal，取消）
 */
export function makeVideo(fmt, o) {
    return fmt.engine === 'webcodecs' ? encodeVideo(fmt, o) : recordVideo(fmt, o);
}

// ---------- 1. WebCodecs ----------

async function encodeVideo(fmt, { width, height, count, holdMs, draw, onProgress, signal }) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const mp4 = new Mp4Writer(width, height);
    let failed = null;
    const enc = new VideoEncoder({
        output: (chunk, meta) => mp4.add(chunk, meta),
        error: e => { failed = e; },
    });
    // 每格的開始、結束時間（微秒），用累積時間取整數，總長度才準
    const ends = [];
    let t = 0;
    for (let i = 0; i < count; i++) { t += holdMs(i); ends.push(Math.round(t * 1000)); }
    // 實際要編幾張（每格停超過 1 秒的會拆成多張）→ 平均影格率
    let pics = 0;
    ends.forEach((e, i) => { pics += Math.ceil((e - (i ? ends[i - 1] : 0)) / MAX_HOLD_US); });
    const fps = Math.max(1, Math.min(FPS, pics / (ends[count - 1] / 1e6)));
    enc.configure(encoderConfig(fmt.codec, width, height, fps, fmt.quantizer));
    const yuv = new Uint8Array(width * height * 3 / 2);
    const opts = key => fmt.quantizer ? { keyFrame: key, avc: { quantizer: QP } } : { keyFrame: key };
    let start = 0, lastKey = -Infinity;
    try {
        for (let i = 0; i < count; i++) {
            if (signal && signal.aborted) throw new DOMException('取消', 'AbortError');
            if (failed) throw failed;
            draw(ctx, i);
            rgbaToI420(ctx.getImageData(0, 0, width, height).data, width, height, yuv);
            const base = new VideoFrame(yuv, { format: 'I420', codedWidth: width, codedHeight: height, timestamp: 0, colorSpace: COLOR });
            // 這一格停的時間切成每段最多 1 秒，每段一張（同一張畫面，不再複製 canvas）
            for (let ts = start; ts < ends[i]; ts += MAX_HOLD_US) {
                const dur = Math.min(MAX_HOLD_US, ends[i] - ts);
                // 編碼器的佇列太長就等它消化，記憶體才不會爆
                while (enc.encodeQueueSize > 4 && !failed) await dequeued(enc);
                const f = new VideoFrame(base, { timestamp: ts, duration: dur });
                const key = ts - lastKey >= KEY_US;
                if (key) lastKey = ts;
                enc.encode(f, opts(key));
                f.close();
            }
            base.close();
            start = ends[i];
            if (onProgress) onProgress(start / ends[count - 1], i + 1);
            await yieldTask();   // 讓進度、取消按鈕有機會更新
        }
        await enc.flush();
        if (failed) throw failed;
    } finally {
        if (enc.state !== 'closed') enc.close();
    }
    return { blob: mp4.finish(ends[count - 1]), ext: 'mp4' };
}

/**
 * RGBA → I420（BT.709、有限範圍）：Y 每個像素一個；U、V 每 2×2 像素一個（取四個像素的平均）。寬高要是偶數
 * 係數 ×65536 用整數算（1080×1920 一張約 20～40 毫秒）
 */
function rgbaToI420(px, w, h, out) {
    const ySize = w * h, cw = w >> 1;
    const U = ySize, V = ySize + (ySize >> 2);
    // Y = 16 + 219/255 × (0.2126R + 0.7152G + 0.0722B)
    const YR = Math.round(0.2126 * 219 / 255 * 65536), YG = Math.round(0.7152 * 219 / 255 * 65536), YB = Math.round(0.0722 * 219 / 255 * 65536);
    // Cb = 128 + 224/255 × (−0.1146R − 0.3854G + 0.5B)；Cr = 128 + 224/255 × (0.5R − 0.4542G − 0.0458B)
    const k = 224 / 255 * 65536;
    const UR = Math.round(-0.1146 * k), UG = Math.round(-0.3854 * k), UB = Math.round(0.5 * k);
    const VR = Math.round(0.5 * k), VG = Math.round(-0.4542 * k), VB = Math.round(-0.0458 * k);
    for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
            let r = 0, g = 0, b = 0;
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const p = ((y + dy) * w + x + dx), q = p * 4;
                    const R = px[q], G = px[q + 1], B = px[q + 2];
                    out[p] = 16 + ((YR * R + YG * G + YB * B + 32768) >> 16);
                    r += R; g += G; b += B;
                }
            }
            const c = (y >> 1) * cw + (x >> 1);
            // 四個像素加總 → ÷4（>> 18 ＝ >> 16 再 >> 2）
            out[U + c] = 128 + ((UR * r + UG * g + UB * b + 131072) >> 18);
            out[V + c] = 128 + ((VR * r + VG * g + VB * b + 131072) >> 18);
        }
    }
}

// 讓出執行緒一下：用 MessageChannel 而不是 setTimeout（分頁在背景時 setTimeout 會被放慢到每秒一次）
const yieldTask = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
// 等編碼器消化一格：有 dequeue 事件就等事件，沒有就讓出執行緒
// （另加 100 毫秒的保險：編碼器出錯時不會發 dequeue，不能一直等）
const dequeued = enc => 'ondequeue' in enc
    ? new Promise(r => { enc.addEventListener('dequeue', r, { once: true }); setTimeout(r, 100); })
    : yieldTask();

/**
 * 最簡單的 MP4 封裝：只有一軌 H.264（可變影格率：每張的時間取自編碼器輸出的 timestamp）、全部影格放一個 mdat，moov 放在前面（手機、網頁不用下載完就能播）
 * 結構：ftyp、moov（mvhd、trak（tkhd、mdia（mdhd、hdlr、minf（vmhd、dinf、stbl（stsd avc1＋avcC、stts、stss、stsc、stsz、stco））））））、mdat
 */
class Mp4Writer {
    constructor(width, height) {
        this.w = width; this.h = height;
        this.scale = 90000;  // 時間單位：1/90000 秒（影片常用）
        this.samples = [];   // Uint8Array
        this.times = [];     // 每張的開始時間（微秒）；H.264 沒有 B 格，輸出順序就是播放順序
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
        this.times.push(chunk.timestamp);
        if (chunk.type === 'key') this.keys.push(this.samples.length);
    }
    /** @param endUs 影片總長（微秒） */
    finish(endUs) {
        if (!this.avcC) throw new Error('編碼器沒有給 H.264 設定');
        const tick = us => Math.round(us * this.scale / 1e6);
        // 每張的長度＝下一張的開始－這一張的開始（換成時間單位後再相減，總長才不會有誤差）
        const at = [...this.times.map(tick), tick(endUs)];
        this.durs = this.times.map((_, i) => Math.max(1, at[i + 1] - at[i]));
        const dur = this.durs.reduce((a, b) => a + b, 0);
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
            box('avcC', this.avcC),
            box('colr', str('nclx'), u16(1), u16(1), u16(1), new Uint8Array([0])));   // BT.709 原色／轉換／矩陣、有限範圍（和 COLOR 一致）
        const n = this.samples.length;
        const stbl = box('stbl',
            fullBox('stsd', 0, 0, u32(1), avc1),
            fullBox('stts', 0, 0, ...stts(this.durs)),
            fullBox('stss', 0, 0, u32(this.keys.length), ...this.keys.map(u32)),
            fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
            fullBox('stsz', 0, 0, u32(0), u32(n), ...this.samples.map(s => u32(s.length))),
            fullBox('stco', 0, 0, u32(1), u32(off)));
        return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl)));
    }
}

/** stts：連續相同長度的合成一筆 [筆數, (張數, 長度)…] */
function stts(durs) {
    const runs = [];
    for (const d of durs) {
        const last = runs[runs.length - 1];
        if (last && last[1] === d) last[0]++;
        else runs.push([1, d]);
    }
    return [u32(runs.length), ...runs.flatMap(([c, d]) => [u32(c), u32(d)])];
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
    const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: BITRATE });
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
            if (onProgress) onProgress(end / total, i + 1);
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
