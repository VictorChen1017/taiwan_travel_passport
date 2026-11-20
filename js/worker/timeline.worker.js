// Google 時間軸解析 Worker（module worker）
//
// 訊息（主執行緒 → Worker）：{ id, files: File[] }
// 回覆：{ id, ok: true, result } 或 { id, ok: false, error }；進度 { id, progress: { done, total, name } }
//   result：{ formats: [...], records: { lat, lng, time, kind }, stats }
//   kind：1 停留點、2 移動途中（移動起訖點、路徑點、原始定位）
//   time：「當地時鐘時間當成 UTC」的 unix 秒（規則見 docs/SPEC.md §5）；不明為 NaN
//
// 支援格式（docs/SPEC.md §4.3）：
//   A 舊版 Takeout Records.json          { locations: [{ latitudeE7, longitudeE7, timestamp | timestampMs }] }
//   B 舊版 Takeout 語意位置記錄（每月）   { timelineObjects: [{ placeVisit } | { activitySegment }] }
//   C Android 裝置匯出 Timeline.json      { semanticSegments: [...], rawSignals: [...] }
//   D iOS 裝置匯出 location-history.json  [{ startTime, endTime, visit | activity | timelinePath }]

const MIN_VISIT_PROB = 0.3;          // 停留點可信度門檻（visit.probability；B 格式為 visitConfidence / 100）
const STAY_RADIUS = 200, STAY_MIN = 10 * 60;   // A 格式的停留偵測：200 公尺內停留 10 分鐘以上
const TW_OFFSET = 8 * 3600;          // 只有 UTC 的時間加 8 小時（成就範圍都在 UTC+8）

// ---------- 時間 ----------

/** ISO 時間 → 當地時鐘時間當 UTC 的秒數：有時區偏移就取字面上的日期時刻；Z（UTC）則加 8 小時 */
function isoLocal(s) {
    if (typeof s !== 'string') return NaN;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (!m) return NaN;
    const t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
    return m[7] === 'Z' || m[7] === undefined ? t + TW_OFFSET : t;
}
/** 毫秒字串（舊版 timestampMs）→ 加 8 小時 */
const msLocal = ms => (ms == null || ms === '') ? NaN : Math.floor(Number(ms) / 1000) + TW_OFFSET;
const anyTime = (iso, ms) => iso != null ? isoLocal(iso) : msLocal(ms);

// ---------- 座標 ----------

/** "geo:25.03,121.56"、"25.0330°, 121.5654°"、"25.0330, 121.5654" → [緯度, 經度] */
function parseLatLng(s) {
    if (typeof s !== 'string') return null;
    const m = s.replace(/^geo:/, '').match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)°?/);
    if (!m) return null;
    const la = +m[1], lo = +m[2];
    return Number.isFinite(la) && Number.isFinite(lo) && !(la === 0 && lo === 0) ? [la, lo] : null;
}
const e7 = (a, b) => (a == null || b == null || (a === 0 && b === 0)) ? null : [a / 1e7, b / 1e7];

// ---------- 輸出累積 ----------

function makeSink() {
    const lat = [], lng = [], time = [], kind = [];
    const seen = new Set();   // 移動途中的點：同一天、約 10 公尺內的重複只留一筆
    const stats = { visits: 0, lowProb: 0, path: 0, pathDup: 0, bad: 0 };
    return {
        lat, lng, time, kind, stats,
        visit(p, t, prob) {
            if (!p) { stats.bad++; return; }
            if (prob != null && Number.isFinite(prob) && prob < MIN_VISIT_PROB) { stats.lowProb++; return; }
            lat.push(p[0]); lng.push(p[1]); time.push(t); kind.push(1); stats.visits++;
        },
        path(p, t) {
            if (!p) { stats.bad++; return; }
            const day = Number.isFinite(t) ? Math.floor(t / 86400) : -1;
            const key = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${day}`;
            if (seen.has(key)) { stats.pathDup++; return; }
            seen.add(key);
            lat.push(p[0]); lng.push(p[1]); time.push(t); kind.push(2); stats.path++;
        },
    };
}

// ---------- 各格式 ----------

/** D：iOS 匯出（最外層是陣列） */
function parseIOS(arr, out) {
    for (const e of arr) {
        const t0 = isoLocal(e.startTime), t1 = isoLocal(e.endTime);
        if (e.visit) {
            const c = e.visit.topCandidate || {};
            out.visit(parseLatLng(c.placeLocation), t0, parseFloat(e.visit.probability));
        } else if (e.activity) {
            out.path(parseLatLng(e.activity.start), t0);
            out.path(parseLatLng(e.activity.end), t1);
        } else if (e.timelinePath) {
            for (const q of e.timelinePath) {
                const off = parseFloat(q.durationMinutesOffsetFromStartTime);
                out.path(parseLatLng(q.point), Number.isFinite(t0) && Number.isFinite(off) ? t0 + Math.round(off * 60) : t0);
            }
        }
    }
}

/** C：Android 匯出 */
function parseAndroid(d, out) {
    for (const s of d.semanticSegments || []) {
        const t0 = isoLocal(s.startTime), t1 = isoLocal(s.endTime);
        if (s.visit) {
            const c = s.visit.topCandidate || {};
            const loc = c.placeLocation && (c.placeLocation.latLng ?? c.placeLocation);
            out.visit(parseLatLng(loc), t0, parseFloat(s.visit.probability));
        }
        if (s.activity) {
            out.path(parseLatLng(s.activity.start?.latLng ?? s.activity.start), t0);
            out.path(parseLatLng(s.activity.end?.latLng ?? s.activity.end), t1);
        }
        for (const q of s.timelinePath || []) out.path(parseLatLng(q.point), isoLocal(q.time));
    }
    for (const r of d.rawSignals || []) {
        const p = r.position;
        if (p) out.path(parseLatLng(p.LatLng ?? p.latLng), isoLocal(p.timestamp));
    }
}

/** B：舊版 Takeout 語意位置記錄（每月一個檔） */
function parseSemantic(d, out) {
    for (const o of d.timelineObjects || []) {
        if (o.placeVisit) {
            const v = o.placeVisit, loc = v.location || {};
            const conf = v.visitConfidence != null ? Number(v.visitConfidence) / 100 : null;
            out.visit(e7(loc.latitudeE7, loc.longitudeE7), anyTime(v.duration?.startTimestamp, v.duration?.startTimestampMs), conf);
        } else if (o.activitySegment) {
            const a = o.activitySegment, du = a.duration || {};
            out.path(e7(a.startLocation?.latitudeE7, a.startLocation?.longitudeE7), anyTime(du.startTimestamp, du.startTimestampMs));
            out.path(e7(a.endLocation?.latitudeE7, a.endLocation?.longitudeE7), anyTime(du.endTimestamp, du.endTimestampMs));
            for (const w of a.waypointPath?.waypoints || []) out.path(e7(w.latE7, w.lngE7), anyTime(du.startTimestamp, du.startTimestampMs));
            for (const q of a.simplifiedRawPath?.points || []) out.path(e7(q.latE7, q.lngE7), anyTime(q.timestamp, q.timestampMs));
        }
    }
}

/** A：舊版 Takeout 原始定位 Records.json（沒有停留點：自己偵測，連續停在 200 公尺內 10 分鐘以上算一次停留） */
function parseRecords(d, out) {
    const pts = [];
    for (const r of d.locations || []) {
        const p = e7(r.latitudeE7, r.longitudeE7);
        if (!p) continue;
        pts.push([p[0], p[1], anyTime(r.timestamp, r.timestampMs)]);
    }
    pts.sort((a, b) => a[2] - b[2]);
    for (const [la, lo, t] of pts) out.path([la, lo], t);
    // 停留偵測
    const R = 6371000, rad = Math.PI / 180;
    const dist = (a, b) => { const x = (b[1] - a[1]) * rad * Math.cos((a[0] + b[0]) / 2 * rad), y = (b[0] - a[0]) * rad; return Math.sqrt(x * x + y * y) * R; };
    let i = 0;
    while (i < pts.length) {
        let j = i + 1, sl = pts[i][0], sg = pts[i][1], n = 1;
        while (j < pts.length && dist(pts[i], pts[j]) <= STAY_RADIUS) { sl += pts[j][0]; sg += pts[j][1]; n++; j++; }
        if (n > 1 && pts[j - 1][2] - pts[i][2] >= STAY_MIN) out.visit([sl / n, sg / n], pts[i][2], null);
        i = j;
    }
}

function detect(d) {
    if (Array.isArray(d)) return d.length && (d[0].startTime || d[0].visit || d[0].activity || d[0].timelinePath) ? 'ios' : null;
    if (d && typeof d === 'object') {
        if (Array.isArray(d.semanticSegments) || Array.isArray(d.rawSignals)) return 'android';
        if (Array.isArray(d.timelineObjects)) return 'semantic';
        if (Array.isArray(d.locations)) return 'records';
    }
    return null;
}

const PARSERS = { ios: parseIOS, android: parseAndroid, semantic: parseSemantic, records: parseRecords };

onmessage = async e => {
    const { id, files } = e.data;
    try {
        const out = makeSink();
        const formats = {}, skipped = [];
        for (let k = 0; k < files.length; k++) {
            const f = files[k];
            postMessage({ id, progress: { done: k, total: files.length, name: f.name } });
            let d;
            try { d = JSON.parse(await f.text()); } catch (err) { skipped.push(f.name); continue; }
            const fmt = detect(d);
            if (!fmt) { skipped.push(f.name); continue; }
            PARSERS[fmt](d, out);
            formats[fmt] = (formats[fmt] || 0) + 1;
        }
        let from = null, to = null, taiwan = 0, taiwanVisits = 0;
        for (let i = 0; i < out.lat.length; i++) {
            const t = out.time[i];
            if (t > 0) { if (from === null || t < from) from = t; if (to === null || t > to) to = t; }
            if (out.lat[i] >= 10 && out.lat[i] <= 26.5 && out.lng[i] >= 114 && out.lng[i] <= 124.7) { taiwan++; if (out.kind[i] === 1) taiwanVisits++; }
        }
        const records = {
            lat: Float64Array.from(out.lat), lng: Float64Array.from(out.lng),
            time: Float64Array.from(out.time), kind: Uint8Array.from(out.kind),
        };
        postMessage({ id, ok: true, result: { formats, skipped, records, stats: { ...out.stats, from, to, taiwan, taiwanVisits, files: files.length } } },
            [records.lat.buffer, records.lng.buffer, records.time.buffer, records.kind.buffer]);
    } catch (err) {
        postMessage({ id, ok: false, error: String(err && err.message || err) });
    }
};
