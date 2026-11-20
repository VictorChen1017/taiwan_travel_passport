// 幾何核心：TopoJSON 解碼、多邊形格子索引（點在哪個面內）、點的格子索引（半徑查詢）、距離
// 不依賴外部套件，可在 Web Worker 與主執行緒使用

// ---------------------------------------------------------------------
// TopoJSON
// ---------------------------------------------------------------------

/** 解差值編碼，回傳每條弧的量化座標（Int32Array，x0,y0,x1,y1,…） */
export function decodeArcs(topo) {
    return topo.arcs.map(arc => {
        const out = new Int32Array(arc.length * 2);
        let x = 0, y = 0;
        for (let i = 0; i < arc.length; i++) {
            x += arc[i][0]; y += arc[i][1];
            out[i * 2] = x; out[i * 2 + 1] = y;
        }
        return out;
    });
}

/** 由弧的引用組出一個環（量化座標，首尾相同） */
export function ringFromArcs(arcs, refs) {
    let len = 0;
    for (const r of refs) len += arcs[r >= 0 ? r : ~r].length / 2;
    len -= refs.length - 1;   // 相接的弧共用端點
    const out = new Int32Array(len * 2);
    let k = 0;
    refs.forEach((r, j) => {
        const a = arcs[r >= 0 ? r : ~r];
        const n = a.length / 2;
        for (let i = j === 0 ? 0 : 1; i < n; i++) {
            const s = r >= 0 ? i : n - 1 - i;
            out[k++] = a[s * 2]; out[k++] = a[s * 2 + 1];
        }
    });
    return out;
}

/** 幾何 → 多邊形清單，每個多邊形是環的清單 */
function polygonsOf(g, arcs) {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    return polys.map(rings => rings.map(refs => ringFromArcs(arcs, refs)));
}

/** 量化座標轉經緯度 */
function unq(topo, x, y) {
    const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
    return [+(x * sx + tx).toFixed(6), +(y * sy + ty).toFixed(6)];
}

/** TopoJSON 中某個幾何轉成 GeoJSON（經緯度）；找不到回傳 null */
export function toGeoJSON(topo, objectName, id) {
    const g = topo.objects[objectName].geometries.find(x => x.id === id);
    if (!g) return null;
    const arcs = topo._decoded || (topo._decoded = decodeArcs(topo));
    const ring = refs => {
        const r = ringFromArcs(arcs, refs), out = [];
        for (let k = 0; k < r.length; k += 2) out.push(unq(topo, r[k], r[k + 1]));
        return out;
    };
    return g.type === 'Polygon'
        ? { type: 'Polygon', coordinates: g.arcs.map(ring) }
        : { type: 'MultiPolygon', coordinates: g.arcs.map(p => p.map(ring)) };
}

// ---------------------------------------------------------------------
// 多邊形格子索引
// ---------------------------------------------------------------------

/** 點是否在多邊形內（偶奇規則，所有環一起算，內洞自然排除） */
function inPolygon(x, y, rings) {
    let c = false;
    for (const r of rings) {
        const n = r.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = r[i * 2], yi = r[i * 2 + 1], xj = r[j * 2], yj = r[j * 2 + 1];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
        }
    }
    return c;
}

export class PolygonIndex {
    /**
     * @param topo        TopoJSON
     * @param objectName  物件名稱（villages、areas）
     * @param cell        格子大小（度）
     */
    constructor(topo, objectName, cell = 0.02) {
        const arcs = decodeArcs(topo);
        topo._decoded = arcs;
        this.topo = topo;
        const [sx, sy] = topo.transform.scale;
        [this.tx, this.ty] = topo.transform.translate;
        this.sx = sx; this.sy = sy;
        this.cell = Math.round(cell / sx);   // 量化單位的格子大小
        this.ids = [];
        this.polys = [];
        this.grid = new Map();
        for (const g of topo.objects[objectName].geometries) {
            const i = this.ids.length;
            const polys = polygonsOf(g, arcs);
            this.ids.push(g.id);
            this.polys.push(polys);
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const rings of polys) for (const r of rings) for (let k = 0; k < r.length; k += 2) {
                if (r[k] < x0) x0 = r[k]; if (r[k] > x1) x1 = r[k];
                if (r[k + 1] < y0) y0 = r[k + 1]; if (r[k + 1] > y1) y1 = r[k + 1];
            }
            for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++) {
                for (let gy = Math.floor(y0 / this.cell); gy <= Math.floor(y1 / this.cell); gy++) {
                    const key = gx * 65536 + gy;
                    let list = this.grid.get(key);
                    if (!list) this.grid.set(key, list = []);
                    list.push(i);
                }
            }
        }
    }

    /** 包含此點的所有面（索引）；回呼 fn(i)，回傳 true 時停止 */
    each(lng, lat, fn) {
        const x = (lng - this.tx) / this.sx, y = (lat - this.ty) / this.sy;
        const list = this.grid.get(Math.floor(x / this.cell) * 65536 + Math.floor(y / this.cell));
        if (!list) return;
        for (const i of list) {
            for (const rings of this.polys[i]) {
                if (inPolygon(x, y, rings)) { if (fn(i)) return; break; }
            }
        }
    }

    /** 第一個包含此點的面（索引），沒有則 -1 */
    find(lng, lat) {
        let hit = -1;
        this.each(lng, lat, i => { hit = i; return true; });
        return hit;
    }
}

// ---------------------------------------------------------------------
// 距離（WGS84 橢球的局部近似；數公里內與 PostGIS geography 的差距在公分級）
// ---------------------------------------------------------------------

const A = 6378137, E2 = 0.00669437999014;
const RAD = Math.PI / 180;

/** 兩點距離（公尺） */
export function distance(lat1, lng1, lat2, lng2) {
    const phi = (lat1 + lat2) / 2 * RAD;
    const s = Math.sin(phi), w = 1 - E2 * s * s;
    const M = A * (1 - E2) / (w * Math.sqrt(w));   // 子午圈曲率半徑
    const N = A / Math.sqrt(w);                    // 卯酉圈曲率半徑
    const dy = (lat2 - lat1) * RAD * M, dx = (lng2 - lng1) * RAD * N * Math.cos(phi);
    return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------
// 點的格子索引（半徑查詢）
// ---------------------------------------------------------------------

export class PointIndex {
    /**
     * @param lat、lng  Float64Array
     * @param ids       要收進索引的紀錄編號（Int32Array）
     * @param cell      格子大小（度）
     */
    constructor(lat, lng, ids, cell = 0.01) {
        this.lat = lat; this.lng = lng; this.cell = cell;
        const keys = new Float64Array(ids.length);
        const count = new Map();
        for (let k = 0; k < ids.length; k++) {
            const i = ids[k];
            const key = Math.floor(lng[i] / cell) * 100000 + Math.floor(lat[i] / cell);
            keys[k] = key;
            count.set(key, (count.get(key) || 0) + 1);
        }
        // 依格子分桶（計數排序）
        this.start = new Map();
        let off = 0;
        for (const [key, n] of count) { this.start.set(key, [off, off + n]); off += n; }
        const pos = new Map();
        for (const [key, [s]] of this.start) pos.set(key, s);
        this.items = new Int32Array(ids.length);
        for (let k = 0; k < ids.length; k++) {
            const p = pos.get(keys[k]);
            this.items[p] = ids[k];
            pos.set(keys[k], p + 1);
        }
    }

    /** 半徑 r 公尺內的紀錄：回呼 fn(i) */
    around(lat, lng, r, fn) {
        const dLat = r / 110574 * 1.01, dLng = r / (111320 * Math.cos(lat * RAD)) * 1.01;
        const c = this.cell;
        for (let gx = Math.floor((lng - dLng) / c); gx <= Math.floor((lng + dLng) / c); gx++) {
            for (let gy = Math.floor((lat - dLat) / c); gy <= Math.floor((lat + dLat) / c); gy++) {
                const b = this.start.get(gx * 100000 + gy);
                if (!b) continue;
                for (let k = b[0]; k < b[1]; k++) {
                    const i = this.items[k];
                    if (distance(lat, lng, this.lat[i], this.lng[i]) <= r) fn(i);
                }
            }
        }
    }
}
