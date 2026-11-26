// 簡易 GIF89a 編碼器（分享成就的動圖用；不用外部套件）
// - 全部影格共用一組 256 色調色盤：以 RGB 各 5 位元分箱後做中位數切割（median cut）
// - 第 2 格起只存和上一格不同的矩形（處置方式 1：保留上一格），檔案小很多
// - 無限循環（NETSCAPE2.0）
//
// 用法：encodeGif([ImageData, ...], 每格毫秒) → Uint8Array

/** @param frames ImageData 陣列（同尺寸） @param delayMs 每格時間 */
export function encodeGif(frames, delayMs) {
    const { width: W, height: H } = frames[0];
    const { palette, lut } = buildPalette(frames);
    const out = new Bytes();

    // 檔頭、邏輯畫面（全域調色盤 256 色）
    out.str('GIF89a');
    out.u16(W); out.u16(H);
    out.byte(0xf7); out.byte(0); out.byte(0);
    for (let i = 0; i < 256; i++) {
        const c = palette[i] || [0, 0, 0];
        out.byte(c[0]); out.byte(c[1]); out.byte(c[2]);
    }
    // 無限循環
    out.byte(0x21); out.byte(0xff); out.byte(11); out.str('NETSCAPE2.0');
    out.byte(3); out.byte(1); out.u16(0); out.byte(0);

    const delay = Math.round(delayMs / 10);
    let prev = null;
    for (const f of frames) {
        const d = f.data;
        // 和上一格不同的範圍（第一格整張）
        let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
        if (prev) {
            x0 = W; y0 = H; x1 = -1; y1 = -1;
            for (let y = 0; y < H; y++) {
                const row = y * W * 4;
                for (let x = 0; x < W; x++) {
                    const p = row + x * 4;
                    if (d[p] !== prev[p] || d[p + 1] !== prev[p + 1] || d[p + 2] !== prev[p + 2]) {
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
            }
            if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }   // 完全相同：放一個像素
        }
        const fw = x1 - x0 + 1, fh = y1 - y0 + 1;
        const idx = new Uint8Array(fw * fh);
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
            const p = ((y0 + y) * W + x0 + x) * 4;
            idx[y * fw + x] = lut[key(d[p], d[p + 1], d[p + 2])];
        }
        // 影格控制：處置方式 1（保留），延遲
        out.byte(0x21); out.byte(0xf9); out.byte(4); out.byte(0x04); out.u16(delay); out.byte(0); out.byte(0);
        // 影像描述（用全域調色盤）
        out.byte(0x2c); out.u16(x0); out.u16(y0); out.u16(fw); out.u16(fh); out.byte(0);
        lzw(idx, out);
        prev = d;
    }
    out.byte(0x3b);
    return out.done();
}

const key = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** 中位數切割：回傳 { palette: [[r,g,b]...], lut: 15 位元色 → 調色盤編號 } */
function buildPalette(frames) {
    const cnt = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    // 第一格全部取樣；其他格只取和第一格不同的像素（閃爍的部分）
    const first = frames[0].data;
    frames.forEach((f, k) => {
        const d = f.data;
        for (let p = 0; p < d.length; p += 4) {
            if (k && d[p] === first[p] && d[p + 1] === first[p + 1] && d[p + 2] === first[p + 2]) continue;
            const i = key(d[p], d[p + 1], d[p + 2]);
            cnt[i]++; sr[i] += d[p]; sg[i] += d[p + 1]; sb[i] += d[p + 2];
        }
    });
    const bins = [];
    for (let i = 0; i < 32768; i++) if (cnt[i]) bins.push({ i, n: cnt[i], r: sr[i] / cnt[i], g: sg[i] / cnt[i], b: sb[i] / cnt[i] });

    // 箱子：依「顏色範圍 × 像素數」最大的先切，切在加權中位數
    const stat = list => {
        let lo = [255, 255, 255], hi = [0, 0, 0], n = 0;
        for (const c of list) {
            const v = [c.r, c.g, c.b];
            for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
            n += c.n;
        }
        const span = hi.map((h, k) => h - lo[k]);
        const ch = span.indexOf(Math.max(...span));
        return { list, n, ch, span: span[ch] };
    };
    let boxes = [stat(bins)];
    while (boxes.length < 256) {
        let best = -1, score = 0;
        boxes.forEach((b, k) => {
            const s = b.list.length > 1 ? b.span * Math.sqrt(b.n) : 0;
            if (s > score) { score = s; best = k; }
        });
        if (best < 0) break;
        const b = boxes[best], ch = ['r', 'g', 'b'][b.ch];
        const list = b.list.slice().sort((p, q) => p[ch] - q[ch]);
        let acc = 0, cut = 1;
        for (let k = 0; k < list.length - 1; k++) { acc += list[k].n; if (acc >= b.n / 2) { cut = k + 1; break; } cut = k + 1; }
        boxes.splice(best, 1, stat(list.slice(0, cut)), stat(list.slice(cut)));
    }
    const palette = boxes.map(b => {
        let n = 0, r = 0, g = 0, bl = 0;
        for (const c of b.list) { n += c.n; r += c.r * c.n; g += c.g * c.n; bl += c.b * c.n; }
        return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
    });
    // 每個用到的分箱找最近的調色盤顏色
    const lut = new Uint8Array(32768);
    for (const c of bins) {
        let best = 0, bd = Infinity;
        for (let k = 0; k < palette.length; k++) {
            const p = palette[k], dr = p[0] - c.r, dg = p[1] - c.g, db = p[2] - c.b;
            const dd = dr * dr * 2 + dg * dg * 4 + db * db * 3;
            if (dd < bd) { bd = dd; best = k; }
        }
        lut[c.i] = best;
    }
    return { palette, lut };
}

/** LZW 壓縮（最小碼長 8），寫成 255 位元組的子區塊 */
function lzw(idx, out) {
    const MIN = 8, CLEAR = 1 << MIN, EOI = CLEAR + 1;
    out.byte(MIN);
    let size = MIN + 1, next = EOI + 1;
    const dict = new Map();
    let cur = 0, bits = 0;
    const block = [];
    const flushBlock = () => { if (!block.length) return; out.byte(block.length); for (const v of block) out.byte(v); block.length = 0; };
    const write = code => {
        cur |= code << bits; bits += size;
        while (bits >= 8) { block.push(cur & 255); if (block.length === 255) flushBlock(); cur >>>= 8; bits -= 8; }
    };
    write(CLEAR);
    let prefix = idx[0];
    for (let i = 1; i < idx.length; i++) {
        const k = idx[i], kk = (prefix << 8) | k;
        const hit = dict.get(kk);
        if (hit !== undefined) { prefix = hit; continue; }
        write(prefix);
        if (next > (1 << size) - 1 && size < 12) size++;
        if (next < 4096) dict.set(kk, next++);
        else { write(CLEAR); dict.clear(); next = EOI + 1; size = MIN + 1; }
        prefix = k;
    }
    write(prefix);
    if (next > (1 << size) - 1 && size < 12) size++;
    write(EOI);
    if (bits > 0) { block.push(cur & 255); if (block.length === 255) flushBlock(); }
    flushBlock();
    out.byte(0);
}

class Bytes {
    constructor() { this.buf = new Uint8Array(1 << 20); this.n = 0; }
    byte(v) {
        if (this.n === this.buf.length) { const b = new Uint8Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
        this.buf[this.n++] = v;
    }
    u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
    str(s) { for (const ch of s) this.byte(ch.charCodeAt(0)); }
    done() { return this.buf.slice(0, this.n); }
}
