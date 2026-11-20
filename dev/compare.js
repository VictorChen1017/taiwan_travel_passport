// 計算核心比對（第 2 階段驗收）：新計算 vs 原專案 explore_stats.php
import { FogClient } from '../js/core/client.js';

const out = document.getElementById('out');
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const html = [];
const log = s => { html.push(s); out.innerHTML = html.join(''); };
const J = v => JSON.stringify(v);
const report = { sections: {} };
window.__cmp = report;

async function getJson(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}：HTTP ${r.status}`);
    return r.json();
}

/** 比對一組項目，輸出差異表 */
function section(title, diffs, total, note = '') {
    report.sections[title] = { total, diffs: diffs.length, list: diffs };
    const cls = diffs.length ? 'bad' : 'ok';
    let s = `<h2>${esc(title)}：<span class="${cls}">${total - diffs.length} / ${total} 一致</span> <span class="muted">${esc(note)}</span></h2>`;
    if (diffs.length) {
        s += '<table><tr><th>項目</th><th>原專案</th><th>新計算</th></tr>';
        for (const d of diffs.slice(0, 60)) s += `<tr><td>${esc(d[0])}</td><td><pre>${esc(d[1])}</pre></td><td><pre>${esc(d[2])}</pre></td></tr>`;
        if (diffs.length > 60) s += `<tr><td colspan="3">…另有 ${diffs.length - 60} 筆</td></tr>`;
        s += '</table>';
    }
    log(s);
}

function cmpList(oldList, newList, key, fields, label) {
    const nm = new Map(newList.map(x => [x[key], x]));
    const om = new Map(oldList.map(x => [x[key], x]));
    const diffs = [];
    for (const [k, o] of om) {
        const n = nm.get(k);
        if (!n) { diffs.push([`${label} ${k}`, J(pick(o, fields)), '（缺少）']); continue; }
        const a = pick(o, fields), b = pick(n, fields);
        if (J(a) !== J(b)) diffs.push([`${label} ${k} ${o.name ?? ''}`, J(a), J(b)]);
    }
    for (const [k, n] of nm) if (!om.has(k)) diffs.push([`${label} ${k}`, '（缺少）', J(pick(n, fields))]);
    return [diffs, om.size];
}
const pick = (o, fields) => Object.fromEntries(fields.map(f => [f, o[f] ?? null]));

// 明細列：去掉照片數欄位後比對
const PHOTO_COL = /^(照片數)$/;
function normRows(d) {
    const keep = d.columns.map((c, i) => PHOTO_COL.test(c) ? -1 : i).filter(i => i >= 0);
    return d.rows.map(r => ({ date: r.date, hit: r.hit, cells: keep.map(i => r.cells[i]), items: r.items ?? null }));
}

(async () => {
    try {
        const t0 = performance.now();
        const [photos, oldStats] = await Promise.all([getJson('../test/legacy/photos.json'), getJson('../test/legacy/stats.json')]);
        const n = photos.lat.length;
        const records = {
            lat: Float64Array.from(photos.lat), lng: Float64Array.from(photos.lng),
            time: Float64Array.from(photos.time, t => t === null ? NaN : t),
        };
        const fog = new FogClient(new URL('../data/', location.href).href);
        window.__fog = fog;
        const info = await fog.init();
        const initMs = fog.lastMs;
        const stats = await fog.compute(records, 'photo', oldStats._now);
        const computeMs = fog.lastMs;
        report.timing = { initMs, computeMs, records: n };
        log(`<p>資料版本 ${esc(info.version)}；紀錄 ${n.toLocaleString()} 筆；載入與建索引 ${initMs} ms；計算 ${computeMs} ms</p>`);

        // 摘要
        const sd = [];
        for (const lv of ['county', 'town', 'village']) {
            for (const k of ['total', 'unlocked', 'area', 'area_unlocked']) {
                if (oldStats.summary[lv][k] !== stats.summary[lv][k]) sd.push([`${lv}.${k}`, oldStats.summary[lv][k], stats.summary[lv][k]]);
            }
        }
        section('摘要', sd, 12);

        // 村里、鄉鎮、縣市
        let [d, t] = cmpList(oldStats.villages, stats.villages, 'code', ['first'], '村里');
        section('已解鎖村里（首次解鎖時間）', d, t);
        [d, t] = cmpList(oldStats.towns, stats.towns, 'code', ['unlocked', 'first', 'villages', 'villages_unlocked', 'village_area', 'village_area_unlocked'], '鄉鎮');
        section('鄉鎮', d, t);
        [d, t] = cmpList(oldStats.counties, stats.counties, 'code', ['unlocked', 'first', 'area', 'towns', 'towns_unlocked', 'town_area_unlocked', 'villages', 'villages_unlocked', 'village_area_unlocked'], '縣市');
        section('縣市', d, t);

        // 成就：進度、目標、達成、日期、分類；集點卡格子
        const fields = ['group', 'name', 'icon', 'tier', 'progress', 'target', 'done', 'date', 'section', 'note'];
        [d, t] = cmpList(oldStats.achievements, stats.achievements, 'id', fields, '');
        section('成就（進度、目標、達成日期等）', d, t, '說明文字不比對');
        const cd = [];
        let ct = 0;
        const nAch = new Map(stats.achievements.map(a => [a.id, a]));
        for (const a of oldStats.achievements) {
            if (!a.cells) continue;
            const b = nAch.get(a.id);
            a.cells.forEach((c, i) => {
                ct++;
                const x = b && b.cells && b.cells[i];
                const f = ['code', 'name', 'done', 'date', 'progress', 'target', 'grade', 'tier', 'lines', 'colors'];
                if (!x || J(pick(c, f)) !== J(pick(x, f))) cd.push([`${a.id} #${i + 1}`, J(pick(c, f)), x ? J(pick(x, f)) : '（缺少）']);
            });
        }
        section('集點卡格子', cd, ct);

        // 明細
        const dd = [];
        let dt = 0;
        const geoDiffs = [];
        for (const a of oldStats.achievements) {
            if (!a.detail) continue;
            dt++;
            const od = await getJson(`../test/legacy/detail/${encodeURIComponent(a.id)}.json`);
            const nd = await fog.detail(a.id);
            const ro = normRows(od), rn = normRows(nd);
            if (J(ro) !== J(rn)) {
                // 找出第一個不同的列
                let k = 0;
                while (k < ro.length && k < rn.length && J(ro[k]) === J(rn[k])) k++;
                dd.push([`${a.id}（${ro.length} 列 → ${rn.length} 列）`, J(ro[k] ?? null), J(rn[k] ?? null)]);
            }
            // 小地圖：紀錄點數、標記、範圍大致相同
            if (od.geo) {
                const g1 = od.geo, g2 = nd.geo || {};
                if ((g1.photos || []).length !== (g2.photos || []).length) geoDiffs.push([`${a.id} 小地圖紀錄點數`, (g1.photos || []).length, (g2.photos || []).length]);
                if (g1.marks && J(g1.marks) !== J(g2.marks)) geoDiffs.push([`${a.id} 標記`, g1.marks.length, (g2.marks || []).length]);
                if (g1.shape && !g2.shape) geoDiffs.push([`${a.id} 範圍`, '有', '沒有']);
                if (g1.points && J(g1.points) !== J(g2.points)) geoDiffs.push([`${a.id} 座標`, J(g1.points), J(g2.points)]);
            }
        }
        section('成就明細（列內容，不含照片數欄）', dd, dt);
        section('明細小地圖', geoDiffs, dt);

        report.done = true;
        log(`<p class="muted">完成，總耗時 ${Math.round(performance.now() - t0)} ms</p>`);
    } catch (e) {
        report.error = String(e.stack || e);
        log(`<pre class="bad">${esc(e.stack || e)}</pre>`);
    }
})();
