// 自動檢查：一次跑完核心功能的檢查，結果顯示成表格，並放在 window.__selftest（給自動化工具讀取）
//   window.__selftest = { done: Promise, pass, fail, results: [{ group, name, ok, info, ms }] }
// 只測核心邏輯；介面外觀由維護者實際使用時確認（docs/devlog 2026-11-21 決定）

import { FogClient } from '../js/core/client.js';
import * as manual from '../js/manual.js';
import { exportBackup, parseBackup } from '../js/backup.js';
import { renderReport, PRESETS, BLOCKS } from '../js/report.js';

// 基準值：原專案照片（test/legacy/photos.json）在 2026-11-21 圖資下的結果
const BASE = {
    county: [19, 22], town: [219, 368], village: [1287, 7975],
    photoAchievements: [69, 258],    // 照片模式：達成 / 總數（含「老地方」）
    yushanVillage: '10008120011',    // 玉山主峰所在村里（東埔村）；照片裡沒有
};

const DATA = new URL('../data/', location.href).href;
const results = [];
const rowsEl = document.getElementById('rows');
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function check(group, name, fn) {
    const t0 = performance.now();
    let ok = false, info = '';
    try {
        const r = await fn();
        ok = r === true || (r && r.ok === true);
        info = r && r.info !== undefined ? r.info : '';
    } catch (e) {
        info = '例外：' + (e && e.message || e);
        console.error(e);
    }
    const ms = Math.round(performance.now() - t0);
    results.push({ group, name, ok, info, ms });
    rowsEl.insertAdjacentHTML('beforeend', `<tr><td>${esc(group)}</td><td>${esc(name)}</td>
        <td class="${ok ? 'ok' : 'bad'}">${ok ? '通過' : '失敗'}</td><td>${esc(info)}</td><td>${ms}</td></tr>`);
    return ok;
}
const res = (ok, info) => ({ ok, info });

/** 照片紀錄＋手動紀錄合併成計算用的紀錄（同 js/app.js 的 mergedRecords，不去重複） */
function records(photos, man = null) {
    const m = man ? man.records : { lat: [], lng: [], time: [], kind: [] };
    const n = photos.lat.length + m.lat.length;
    const r = { lat: new Float64Array(n), lng: new Float64Array(n), time: new Float64Array(n),
                kind: new Uint8Array(n), ref: new Int32Array(n).fill(-1), targets: man ? man.items.map(it => it.target) : [] };
    r.lat.set(photos.lat); r.lng.set(photos.lng); r.time.set(photos.time);
    const o = photos.lat.length;
    for (let i = 0; i < m.lat.length; i++) {
        r.lat[o + i] = m.lat[i]; r.lng[o + i] = m.lng[i]; r.time[o + i] = m.time[i]; r.kind[o + i] = m.kind[i]; r.ref[o + i] = i;
    }
    return r;
}

const villSet = s => new Set(s.villages.map(v => v.code));
const ach = (s, id) => s.achievements.find(a => a.id === id);

async function run() {
    let fog, photos, base, achDefs;

    // ---------- 計算核心 ----------
    await check('計算', '載入圖資、建立索引', async () => {
        fog = new FogClient(DATA);
        const v = await fog.init();
        return res(v.villages === BASE.village[1], `村里 ${v.villages}、鄉鎮 ${v.towns}`);
    });
    await check('計算', '讀取測試照片', async () => {
        const p = await fetch('../test/legacy/photos.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}（沒有 test/legacy？）`); return r.json(); });
        photos = { lat: Float64Array.from(p.lat), lng: Float64Array.from(p.lng), time: Float64Array.from(p.time, t => t === null ? NaN : t) };
        achDefs = await fetch(DATA + 'achievements.json').then(r => r.json());
        return res(photos.lat.length > 0, `${photos.lat.length.toLocaleString()} 張`);
    });
    await check('計算', '照片模式：縣市、鄉鎮、村里解鎖數', async () => {
        base = await fog.compute(records(photos), 'photo');
        const s = base.summary;
        const got = [s.county.unlocked, s.county.total, s.town.unlocked, s.town.total, s.village.unlocked, s.village.total];
        const want = [...BASE.county, ...BASE.town, ...BASE.village];
        return res(got.every((v, i) => v === want[i]), `縣市 ${got[0]}/${got[1]}、鄉鎮 ${got[2]}/${got[3]}、村里 ${got[4]}/${got[5]}（基準 ${want.join(',')}）`);
    });
    await check('計算', '照片模式：成就達成數', async () => {
        const done = base.achievements.filter(a => a.done).length, total = base.achievements.length;
        return res(done === BASE.photoAchievements[0] && total === BASE.photoAchievements[1], `${done} / ${total}（基準 ${BASE.photoAchievements.join(' / ')}）`);
    });
    await check('計算', '造訪模式沒有「老地方」', async () => {
        const s = await fog.compute(records(photos), 'visit');
        return res(!ach(s, 'regular') && !!ach(base, 'regular'), `照片模式有、造訪模式${ach(s, 'regular') ? '也有' : '沒有'}`);
    });
    await check('計算', '明細：地點、集點卡、旅行都能產生', async () => {
        await fog.compute(records(photos), 'photo');
        const ids = ['isl_green', 'peaks_xiao', 'road_trip', 'annual'];
        const ds = await Promise.all(ids.map(id => fog.detail(id)));
        const bad = ids.filter((id, i) => !ds[i].ok);
        return res(!bad.length, bad.length ? `失敗：${bad.join('、')}` : ids.map((id, i) => `${id} ${ds[i].rows.length} 列`).join('、'));
    });

    // ---------- 手動紀錄 ----------
    const lieyu = achDefs.places.find(p => p.id === 'isl_lieyu');
    let yushan = null;
    await check('手動紀錄', '範圍類（小金門，kind 4）只解鎖該成就、不解鎖村里', async () => {
        if (!lieyu?.rep) return res(false, 'achievements.json 沒有 isl_lieyu 的 rep（要重新匯出圖資）');
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: 'isl_lieyu', label: '小金門', lat: lieyu.rep[0], lng: lieyu.rep[1], area: true }, '2024-05-01'));
        manual.refresh(m);
        const s = await fog.compute(records(photos, m), 'visit');
        const a = ach(s, 'isl_lieyu');
        return res(a.done && a.date === Date.UTC(2024, 4, 1, 12) / 1000 && s.summary.village.unlocked === BASE.village[0],
            `成就 ${a.done ? '解鎖' : '未解鎖'}、日期 ${a.date}、村里 ${s.summary.village.unlocked}（應不變）`);
    });
    await check('手動紀錄', '有座標的（玉山，kind 3、不填日期）連帶解鎖村里', async () => {
        const cell = ach(base, 'peaks_baiyue').cells.find(c => c.code === 1);
        yushan = cell;
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: 'peaks_baiyue#1', label: cell.name, lat: cell.lat, lng: cell.lng, area: false }, ''));
        manual.refresh(m);
        const s = await fog.compute(records(photos, m), 'visit');
        const c = ach(s, 'peaks_baiyue').cells.find(x => x.code === 1);
        const v = s.villages.find(x => x.code === BASE.yushanVillage);
        const d = await fog.detail('peaks_baiyue');
        const row = d.rows.find(r => r.manual === 0);
        return res(c.done && c.date === null && !!v && v.first === null && !!row,
            `登頂 ${c.done}、日期 ${c.date}、東埔村 ${v ? '解鎖（無日期）' : '未解鎖'}、明細手動列 ${row ? '有' : '沒有'}`);
    });
    await check('手動紀錄', '同地點同一天不能重複加入', async () => {
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: 'x', label: 'x', lat: 23, lng: 121 }, '2024-01-02'));
        return res(!!manual.findSame(m, 'x', manual.dateToTime('2024-01-02')) && !manual.findSame(m, 'x', manual.dateToTime('2024-01-03')), '同日擋下、不同日可加');
    });

    // ---------- 備份 ----------
    await check('備份', '匯出再匯入：座標、時間、類型完全相同', async () => {
        const n = 3000;
        const src = { id: 'a1', type: 'exif', name: '測試', added: 1, updated: 2, stats: {},
            records: { lat: photos.lat.slice(0, n), lng: photos.lng.slice(0, n), time: photos.time.slice(0, n), kind: new Uint8Array(n) } };
        const { blob } = exportBackup([src], { includePath: true });
        const { sources, settings } = parseBackup(await blob.text());
        const R = sources[0].records;
        let diff = 0;
        for (let i = 0; i < n; i++) {
            const t0 = src.records.time[i], t1 = R.time[i];
            if (R.lat[i] !== src.records.lat[i] || R.lng[i] !== src.records.lng[i] || !(t0 === t1 || (isNaN(t0) && isNaN(t1)))) diff++;
        }
        return res(diff === 0 && R.lat.length === n && settings.includePath === true, `${n} 筆、不同 ${diff} 筆`);
    });
    await check('備份', '手動紀錄逐筆合併（另一台多一筆只加一筆）', async () => {
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: 'peaks_baiyue#1', label: '玉山', lat: 23.47, lng: 120.957 }, ''));
        m.items.push(manual.newItem({ target: 'isl_lieyu', label: '小金門', lat: 24.44, lng: 118.25, area: true }, '2024-05-01'));
        manual.refresh(m);
        const parsed = parseBackup(await exportBackup([m]).blob.text()).sources[0];
        const same = JSON.stringify(parsed.items) === JSON.stringify(m.items) && parsed.records.kind.join() === '3,4';
        const other = [...parsed.items, manual.newItem({ target: 'peaks_baiyue#2', label: '雪山', lat: 24.38, lng: 121.23 }, '2023-08-10')];
        const k0 = manual.mergeItems(m, parsed.items), k1 = manual.mergeItems(m, other);
        return res(same && k0 === 0 && k1 === 1 && m.items.length === 3, `往返相同 ${same}、重複匯入加 ${k0}、另一台多一筆加 ${k1}`);
    });
    await check('備份', '不是備份檔時給清楚的錯誤', async () => {
        try { parseBackup('{"semanticSegments": []}'); return res(false, '沒有丟出錯誤'); }
        catch (e) { return res(/不是台灣旅遊護照的備份檔/.test(e.message), e.message); }
    });

    // ---------- 成就報表 ----------
    await check('報表', '六種預設組合都能產生圖片（淺色、深色）', async () => {
        const maps = {};
        for (const lv of ['county', 'town', 'village']) maps[lv] = await fetch(DATA + `map_${lv}.json`).then(r => r.json());
        const stats = await fog.compute(records(photos), 'photo');
        const missing = new Set(BLOCKS.filter(b => b.missingOn).map(b => b.id));
        const out = [];
        for (const theme of ['light', 'dark']) {
            window.photoTheme && window.photoTheme.set(theme);
            for (const p of PRESETS) {
                const r = renderReport({ blocks: new Set(p.blocks), missing, hideDates: theme === 'dark', nickname: '測試', mapLevel: 'town' },
                                       { stats, meta: { from: null, to: null, mode: 'photo', manual: 0 }, maps });
                if (!(r.height > 300) || r.tooTall) throw new Error(`${p.label}（${theme}）高度 ${r.height}`);
                if (theme === 'light') out.push(`${p.label} ${r.height}`);
            }
        }
        window.photoTheme && window.photoTheme.set('light');
        return res(true, out.join('、') + ' px');
    });
    await check('報表', '產生的畫布能輸出 PNG', async () => {
        const stats = await fog.compute(records(photos), 'photo');
        const r = renderReport({ blocks: new Set(['summary', 'conquer']), missing: new Set(), hideDates: false, nickname: '', mapLevel: 'town' },
                               { stats, meta: {}, maps: {} });
        const blob = await new Promise(ok => r.canvas.toBlob(ok, 'image/png'));
        return res(!!blob && blob.size > 1000, blob ? `${Math.round(blob.size / 1024)} KB` : '輸出失敗');
    });
}

const done = run().then(() => {
    const pass = results.filter(r => r.ok).length, fail = results.length - pass;
    document.getElementById('sum').innerHTML = fail
        ? `<span class="bad">❌ ${fail} 項失敗</span>，${pass} 項通過`
        : `<span class="ok">✅ 全部 ${pass} 項通過</span>`;
    Object.assign(window.__selftest, { pass, fail });
    return { pass, fail };
});
window.__selftest = { done, results };
