// 計算 Worker（module worker）：載入靜態資料、建索引、計算統計與成就、成就明細
//
// 訊息（主執行緒 → Worker）：
//   { id, type: 'init', base }                     載入 data/（base 為 data/ 的網址）
//   { id, type: 'compute', records, mode, now? }   records：{ lat, lng, time }（Float64Array，time 不明為 NaN；可轉移）
//   { id, type: 'detail', achievement }            成就明細（用最近一次 compute 的結果）
// 回覆（Worker → 主執行緒）：
//   { id, ok: true, result, ms }、{ id, ok: false, error }、進度 { id, progress: { step, done, total } }

import { loadStatic, loadOne } from '../core/data.js';
import { prepareStatic, compute, detail } from '../core/compute.js';

let S = null;     // 靜態資料與索引
let ctx = null;   // 最近一次計算的內容（明細用）

const handlers = {
    async init({ id, base }) {
        const raw = await loadStatic(base, (done, total) => postMessage({ id, progress: { step: 'load', done, total } }));
        S = prepareStatic(raw);
        S.base = base;
        S.files = raw.files;
        return { version: raw.version, villages: S.vills.length, towns: S.towns.length };
    },
    compute({ records, mode, now }) {
        if (!S) throw new Error('尚未初始化');
        const r = compute(records, S, { mode, now });
        ctx = r.ctx;
        return r.stats;
    },
    async detail({ achievement }) {
        if (!ctx) throw new Error('尚未計算');
        // 範圍外框只在明細小地圖用到，第一次開明細時才載入
        if (!S.shapesTopo) S.shapesTopo = await loadOne(S.base, 'shapes.topo.json', S.files);
        return detail(ctx, achievement);
    },
};

onmessage = async e => {
    const msg = e.data;
    const t0 = performance.now();
    try {
        const h = handlers[msg.type];
        if (!h) throw new Error(`未知的訊息：${msg.type}`);
        const result = await h(msg);
        postMessage({ id: msg.id, ok: true, result, ms: Math.round(performance.now() - t0) });
    } catch (err) {
        postMessage({ id: msg.id, ok: false, error: String(err && err.stack || err) });
    }
};
