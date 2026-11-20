// 資料來源轉接器：Google 時間軸
//
// 使用者選一個或多個 JSON 檔（舊版 Takeout 的每月語意位置記錄可一次選整個資料夾或多個檔），
// 交給 Worker 解析（js/worker/timeline.worker.js），輸出統一格式的紀錄（docs/SPEC.md §4.3）

const LABEL = { ios: 'iPhone 匯出', android: 'Android 匯出', semantic: 'Takeout 語意位置記錄', records: 'Takeout Records.json' };
export const formatLabel = f => LABEL[f] || f;

/** 從拖曳或資料夾挑出 .json 檔 */
export const jsonOnly = files => files.filter(f => /\.json$/i.test(f.name));

/**
 * @param files      File[]（.json）
 * @param onProgress ({ done, total, name }) 回呼
 * @param signal     AbortSignal（取消時終止 Worker）
 * @returns 來源物件：{ type: 'gtimeline', stats, formats, records }
 */
export function parseTimeline(files, onProgress = () => {}, signal) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../worker/timeline.worker.js', import.meta.url), { type: 'module' });
        const done = fn => (...a) => { worker.terminate(); fn(...a); };
        const ok = done(resolve), fail = done(reject);
        if (signal) signal.addEventListener('abort', () => fail(new DOMException('已取消', 'AbortError')), { once: true });
        worker.onerror = e => fail(new Error(e.message || '時間軸 Worker 錯誤'));
        worker.onmessage = e => {
            const m = e.data;
            if (m.progress) { onProgress(m.progress); return; }
            if (!m.ok) { fail(new Error(m.error)); return; }
            const r = m.result;
            if (!r.records.lat.length) {
                fail(new Error(r.skipped.length === files.length
                    ? '看不出這是 Google 時間軸檔案（支援：手機匯出的 Timeline.json／location-history.json、Takeout 的 Records.json 或每月語意位置記錄）'
                    : '檔案裡沒有可用的位置紀錄'));
                return;
            }
            ok({ type: 'gtimeline', formats: r.formats, skipped: r.skipped, stats: r.stats, records: r.records });
        };
        worker.postMessage({ id: 1, files });
    });
}
