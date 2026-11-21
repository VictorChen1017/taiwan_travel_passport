// 主執行緒端：包裝計算 Worker，以 Promise 呼叫
//   const fog = new FogClient(new URL('../data/', location.href).href);
//   await fog.init();  const stats = await fog.compute(records, 'visit');  const d = await fog.detail('pole_n');

export class FogClient {
    constructor(dataBase, workerUrl = new URL('../worker/compute.worker.js', import.meta.url)) {
        this.base = dataBase;
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.seq = 0;
        this.pending = new Map();
        this.onprogress = null;
        this.worker.onmessage = e => {
            const m = e.data, p = this.pending.get(m.id);
            if (!p) return;
            if (m.progress) { if (this.onprogress) this.onprogress(m.progress); return; }
            this.pending.delete(m.id);
            if (m.ok) { this.lastMs = m.ms; p.resolve(m.result); } else p.reject(new Error(m.error));
        };
        this.worker.onerror = e => {
            for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker 錯誤'));
            this.pending.clear();
        };
    }

    call(msg, transfer = []) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ ...msg, id }, transfer);
        });
    }

    init() { return this.call({ type: 'init', base: this.base }); }

    /** records 的陣列會轉移給 Worker（呼叫後在主執行緒不可再用）；要保留請先複製 */
    compute(records, mode = 'visit', now) {
        const transfer = ['lat', 'lng', 'time', 'kind', 'ref'].filter(k => records[k]).map(k => records[k].buffer);
        return this.call({ type: 'compute', records, mode, now }, transfer);
    }

    detail(achievement) { return this.call({ type: 'detail', achievement }); }
}
