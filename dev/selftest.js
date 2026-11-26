// 自動檢查：一次跑完核心功能的檢查，結果顯示成表格，並放在 window.__selftest（給自動化工具讀取）
//   window.__selftest = { done: Promise, pass, fail, results: [{ group, name, ok, info, ms }] }
// 只測核心邏輯；介面外觀由維護者實際使用時確認（docs/devlog 2026-11-21 決定）

import { FogClient } from '../js/core/client.js';
import * as manual from '../js/manual.js';
import { exportBackup, parseBackup } from '../js/backup.js';
import { renderReport, renderFestivalGif, PRESETS, BLOCKS, subsOf, DEFAULT_SUB_OFF } from '../js/report.js';

// 基準值：原專案照片（test/legacy/photos.json）在 2026-11-26 圖資下的結果
// （2026-11-26 換成內政部未簡化原檔、不留縫簡化：村里 1287 → 1289，邊界附近 11 個新進、9 個移出）
const BASE = {
    county: [19, 22], town: [219, 368], village: [1289, 7975],
    photoAchievements: [71, 260],    // 照片模式：達成 / 總數（含「老地方」；2026-11-26 起含新北撒旦城、月老巡禮，測試照片都有去過）
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
    // 迷霧地圖補點（SPEC §15.5）
    let mapVill = null, mapTown = null;
    await check('手動紀錄', '迷霧地圖資料都有代表點（村里 c；鄉鎮 c、v、vn）', async () => {
        [mapVill, mapTown] = await Promise.all(['village', 'town'].map(lv => fetch(DATA + `map_${lv}.json`).then(r => r.json())));
        const badV = mapVill.paths.filter(p => !Array.isArray(p.c) || p.c.length !== 2).length;
        const badT = mapTown.paths.filter(p => !Array.isArray(p.c) || !p.v || p.v.slice(0, 8) !== p.code || !p.vn).length;
        return res(badV === 0 && badT === 0, `村里 ${mapVill.paths.length}（缺 ${badV}）、鄉鎮 ${mapTown.paths.length}（缺或不符 ${badT}）`);
    });
    await check('手動紀錄', '迷霧地圖補點（kind 5）只解鎖該村里，不觸發地點成就', async () => {
        // 找一個以村里判定、照片沒去過的地點成就，補點補在它的第一個村里；座標故意放在一個沒去過、以半徑判定的地點上
        const pv = achDefs.places.find(p => p.villages && !ach(base, p.id)?.done && !villSet(base).has(p.villages[0]));
        const pr = achDefs.places.find(p => p.points && !ach(base, p.id)?.done);
        if (!pv || !pr) return res(false, '找不到測試用的地點成就');
        const code = pv.villages[0];
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: manual.VILL_TARGET + code, label: code, lat: pr.points[0][0], lng: pr.points[0][1], area: false }, '2024-03-05'));
        manual.refresh(m);
        const s = await fog.compute(records(photos, m), 'visit');
        const v = s.villages.find(x => x.code === code);
        const t = s.towns.find(x => x.code === code.slice(0, 8));
        const ok = m.records.kind[0] === 5 && !!v && v.first === Date.UTC(2024, 2, 5, 12) / 1000 && t.unlocked
            && s.summary.village.unlocked === BASE.village[0] + 1 && !ach(s, pv.id).done && !ach(s, pr.id).done;
        return res(ok, `kind ${m.records.kind[0]}、村里 ${v ? '解鎖' : '未解鎖'}、村里數 ${s.summary.village.unlocked}（應 ${BASE.village[0] + 1}）、`
            + `${pv.name} ${ach(s, pv.id).done ? '誤解鎖' : '未解鎖'}、${pr.name} ${ach(s, pr.id).done ? '誤解鎖' : '未解鎖'}`);
    });

    // ---------- 節慶活動（新北撒旦城：年份集點卡） ----------
    const fest = achDefs.festivals?.find(f => f.id === 'fest_xmas_ntpc');
    const at = (ymdhm, dLat = 0) => {
        const [d, h] = ymdhm.split(' ');
        const [y, mo, da] = d.split('-').map(Number), [hh, mm] = h.split(':').map(Number);
        return [fest.points[0][0] + dLat, fest.points[0][1], Date.UTC(y, mo - 1, da, hh, mm) / 1000];
    };
    const synth = list => ({ lat: Float64Array.from(list, x => x[0]), lng: Float64Array.from(list, x => x[1]), time: Float64Array.from(list, x => x[2]) });
    await check('節慶活動', '年份判定：期間、時段、範圍；沒去過就不列出', async () => {
        if (!fest) return res(false, 'achievements.json 沒有 festivals（要重新匯出成就）');
        const none = await fog.compute(synth([at('2019-12-01 12:00'), at('2019-10-01 19:30'), at('2019-12-01 23:00'), at('2019-12-01 19:30', 0.01)]), 'visit');
        const s = await fog.compute(synth([
            at('2019-12-01 19:30'),            // 2019 年
            at('2019-12-02 18:00'),            // 同一年：取最早
            at('2025-01-01 21:59'),            // 跨年：算 2024 年
            at('2020-12-31 20:00'),            // 2020 年提前關城（12/30）：不算
            at('2013-02-10 19:00'),            // 2012 年預設期間到 1/3：不算
            at('2014-02-14 22:00'),            // 2013 年延長到元宵（含 22:00 整）：算
        ]), 'visit');
        const a = ach(s, 'fest_xmas_ntpc');
        const years = a ? a.cells.map(c => c.year).join(',') : '';
        return res(!ach(none, 'fest_xmas_ntpc') && !!a && a.done && years === '2024,2019,2013' && a.date === at('2014-02-14 22:00')[2],
            `沒去過 ${ach(none, 'fest_xmas_ntpc') ? '仍列出' : '不列出'}；年份 ${years}（應為 2024,2019,2013）`);
    });
    await check('節慶活動', '手動加入某一年（kind 4，不解鎖村里）、明細可選未蓋章的年份', async () => {
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: fest.id, label: fest.name, lat: fest.points[0][0], lng: fest.points[0][1], area: true }, '2016-11-19'));
        manual.refresh(m);
        const s = await fog.compute(records(synth([at('2019-12-01 19:30')]), m), 'visit');
        const a = ach(s, 'fest_xmas_ntpc');
        const c16 = a?.cells.find(c => c.year === 2016);
        const d = await fog.detail(fest.id);
        const years = d.add?.years?.map(y => y.year) || [];
        const ok = !!c16 && !c16.auto && c16.manual.length === 1 && s.summary.village.unlocked === 1
            && d.ok && d.rows.some(r => r.manual === 0) && !years.includes(2016) && !years.includes(2019) && years.includes(2011)
            && d.geo.photos?.length === 1;
        return res(ok, `2016 ${c16 ? '有（手動）' : '沒有'}、村里 ${s.summary.village.unlocked}（應為 1）、可加入 ${years.length} 年、地圖藍點 ${d.geo.photos?.length ?? 0}（應為 1）`);
    });
    await check('節慶活動', '分享成就：去過才畫節慶活動區塊', async () => {
        const env = s => ({ stats: s, meta: {}, maps: {} });
        const o = { blocks: new Set(['festival']), missing: new Set(), hideDates: false, nickname: '', mapLevel: 'town' };
        const yes = renderReport(o, env(await fog.compute(synth([at('2019-12-01 19:30'), at('2024-12-01 19:30')]), 'visit'))).height;
        const no = renderReport(o, env(await fog.compute(synth([at('2019-12-01 12:00')]), 'visit'))).height;
        return res(yes > no + 300, `去過 ${yes} px、沒去過 ${no} px`);
    });

    await check('節慶活動', '動圖（GIF）：8 格、解碼後和原圖接近、閃爍的格子不同', async () => {
        const s = await fog.compute(synth([at('2019-12-01 19:30'), at('2024-12-01 19:30'), at('2025-12-01 19:30')]), 'visit');
        const env = { stats: s, meta: {}, maps: {} };
        const o = { blocks: new Set(['festival']), missing: new Set(), hideDates: false, nickname: '測試', mapLevel: 'town' };
        const t0 = performance.now();
        const blob = renderFestivalGif(o, env);
        const ms = Math.round(performance.now() - t0);
        if (!blob) return res(false, '沒有產生動圖');
        if (!('ImageDecoder' in window)) return res(blob.size > 1000, `${Math.round(blob.size / 1024)} KB（瀏覽器不支援 ImageDecoder，沒有解碼比對）`);
        const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif' });
        await dec.tracks.ready;
        const count = dec.tracks.selectedTrack.frameCount;
        const pixels = async k => {
            const { image } = await dec.decode({ frameIndex: k });
            const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
            const ctx = c.getContext('2d');
            ctx.drawImage(image, 0, 0); image.close();
            return ctx.getImageData(0, 0, c.width, c.height).data;
        };
        const src = k => { const { canvas } = renderReport({ ...o, xmasFrame: k }, env); return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; };
        const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length / 4) / 3; };
        const [g0, g2] = [await pixels(0), await pixels(2)];
        const e0 = diff(g0, src(0)), e2 = diff(g2, src(2)), between = diff(g0, g2);
        return res(count === 8 && e0 < 3 && e2 < 3 && between > 0,
            `${count} 格、${Math.round(blob.size / 1024)} KB、${ms} ms；和原圖平均差 ${e0.toFixed(2)}／${e2.toFixed(2)}（< 3）、第 1 與第 3 格差 ${between.toFixed(3)}（> 0）`);
    });

    // ---------- 民俗活動（月老巡禮：地點型集章） ----------
    const yl = achDefs.festivals?.find(f => f.id === 'fest_yuelao');
    const ylAt = (code, t = Date.UTC(2024, 7, 10, 10) / 1000, dLat = 0) => { const p = yl.places.find(x => x.code === code); return [p.lat + dLat, p.lng, t]; };
    await check('民俗活動', '月老巡禮：每間一個章、半徑 50 公尺（台南兩間不重疊）；沒去過不列出', async () => {
        if (!yl) return res(false, 'achievements.json 沒有 fest_yuelao（要重新匯出成就）');
        const none = await fog.compute(synth([ylAt('tianhou', undefined, 0.001)]), 'visit');   // 約 110 公尺外
        const s = await fog.compute(synth([ylAt('tianhou'), ylAt('xiahai', Date.UTC(2023, 1, 1, 9) / 1000), ylAt('xiahai', Date.UTC(2025, 1, 1, 9) / 1000)]), 'visit');
        const a = ach(s, 'fest_yuelao');
        const codes = a ? a.cells.map(c => c.code).join(',') : '';
        const xh = a?.cells.find(c => c.code === 'xiahai');
        return res(!ach(none, 'fest_yuelao') && codes === 'tianhou,xiahai' && xh.date === Date.UTC(2023, 1, 1, 9) / 1000 && a.summary === '已參拜 2 / 13 間',
            `沒去過 ${ach(none, 'fest_yuelao') ? '仍列出' : '不列出'}；章 ${codes}（應為 tianhou,xiahai，不含武廟）；${a?.summary}`);
    });
    await check('民俗活動', '月老巡禮：手動加入（kind 3）、明細列出 13 間、地圖 13 點', async () => {
        const p = yl.places.find(x => x.code === 'chongqing');
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: `fest_yuelao#chongqing`, label: p.name, lat: p.lat, lng: p.lng, area: false }, '2024-08-10'));
        manual.refresh(m);
        const s = await fog.compute(records(synth([ylAt('xiahai')]), m), 'visit');
        const c = ach(s, 'fest_yuelao')?.cells.find(x => x.code === 'chongqing');
        const d = await fog.detail('fest_yuelao');
        const names = new Set(d.rows.map(r => r.cells[0]));
        const ok = !!c && !c.any && c.bottom === '✋ 手動' && d.ok && names.size === 13 && d.rows.some(r => r.manual === 0)
            && d.rows.filter(r => r.add).length === 11 && d.geo.marks.length === 13 && d.geo.marks.filter(x => x[3]).length === 2;
        return res(ok, `重慶寺 ${c ? '蓋章（手動）' : '沒有'}；明細 ${names.size} 間、可加入 ${d.rows.filter(r => r.add).length}（應為 11）、地圖紅點 ${d.geo.marks.filter(x => x[3]).length}（應為 2）`);
    });
    await check('民俗活動', '分享成就與動圖：兩張集章卡都畫得出來、子項目可以單獨關掉', async () => {
        const s = await fog.compute(synth([at('2019-12-01 19:30'), ylAt('tianhou'), ylAt('lukang')]), 'visit');
        const env = { stats: s, meta: {}, maps: {} };
        const o = { blocks: new Set(['festival']), missing: new Set(), hideDates: false, nickname: '', mapLevel: 'town' };
        const both = renderReport(o, env).height;
        const one = renderReport(o, { ...env, stats: await fog.compute(synth([at('2019-12-01 19:30')]), 'visit') }).height;
        const gif = renderFestivalGif(o, env);
        // 進階選項：子項目關掉月老巡禮 → 和只有耶誕城一樣高；兩張都關 → 不畫、沒有動圖
        const subs = subsOf('festival', s).map(x => x.key).join(',');
        const offYl = renderReport({ ...o, subOff: { festival: ['fest_yuelao'] } }, env).height;
        const offAll = { ...o, subOff: { festival: ['fest_yuelao', 'fest_xmas_ntpc'] } };
        const noGif = renderFestivalGif(offAll, env);
        return res(both > one + 300 && !!gif && gif.size > 1000 && subs === 'fest_xmas_ntpc,fest_yuelao' && offYl === one && !noGif && renderReport(offAll, env).height < one,
            `兩張 ${both} px、只有耶誕城 ${one} px、關掉月老巡禮 ${offYl} px；子項目 ${subs}；動圖 ${gif ? Math.round(gif.size / 1024) + ' KB' : '沒有'}、全關 ${noGif ? '仍有動圖' : '沒有動圖'}`);
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
    await check('備份', '迷霧地圖補點（kind 5）匯出再匯入相同', async () => {
        const m = manual.emptyManual();
        m.items.push(manual.newItem({ target: manual.VILL_TARGET + '63000010001', label: '臺北市 松山區 莊敬里', lat: 25.05, lng: 121.56 }, '2024-03-05'));
        manual.refresh(m);
        const parsed = parseBackup(await exportBackup([m]).blob.text()).sources[0];
        const same = JSON.stringify(parsed.items) === JSON.stringify(m.items) && parsed.records.kind.join() === '5';
        return res(same, `往返相同 ${same}、kind ${parsed.records.kind.join()}`);
    });
    await check('備份', '不是備份檔時給清楚的錯誤', async () => {
        try { parseBackup('{"semanticSegments": []}'); return res(false, '沒有丟出錯誤'); }
        catch (e) { return res(/不是台灣旅遊護照的備份檔/.test(e.message), e.message); }
    });

    // ---------- 成就報表 ----------
    await check('報表', '每種預設組合都能產生圖片（淺色、深色）', async () => {
        const maps = {};
        for (const lv of ['county', 'town', 'village']) maps[lv] = await fetch(DATA + `map_${lv}.json`).then(r => r.json());
        const stats = await fog.compute(records(photos), 'photo');
        const missing = new Set(BLOCKS.filter(b => b.missing).map(b => b.id));   // 預設：全部顯示未達成
        const out = [];
        for (const theme of ['light', 'dark']) {
            window.photoTheme && window.photoTheme.set(theme);
            for (const p of PRESETS) {
                const r = renderReport({ blocks: new Set(p.blocks), missing, subOff: DEFAULT_SUB_OFF, hideDates: theme === 'dark', nickname: '測試', mapLevel: 'town' },
                                       { stats, meta: { from: null, to: null, mode: 'photo', manual: 0 }, maps });
                if (!(r.height > 300) || r.tooTall) throw new Error(`${p.label}（${theme}）高度 ${r.height}`);
                if (theme === 'light') out.push(`${p.label} ${r.height}`);
            }
        }
        window.photoTheme && window.photoTheme.set('light');
        return res(true, out.join('、') + ' px');
    });
    await check('報表', '子項目預設值的代號都存在（打錯字會悄悄失效）', async () => {
        const stats = await fog.compute(records(photos), 'photo');
        const bad = [];
        for (const [block, keys] of Object.entries(DEFAULT_SUB_OFF)) {
            const have = new Set(subsOf(block, stats).map(x => x.key));
            for (const k of keys) if (!have.has(k)) bad.push(`${block}:${k}`);
        }
        return res(!bad.length, bad.length ? '找不到 ' + bad.join('、') : Object.entries(DEFAULT_SUB_OFF).map(([b, k]) => `${b} 關 ${k.length}`).join('、'));
    });
    await check('報表', '產生的畫布能輸出 PNG', async () => {
        const stats = await fog.compute(records(photos), 'photo');
        const r = renderReport({ blocks: new Set(['summary', 'conquer']), missing: new Set(), hideDates: false, nickname: '', mapLevel: 'town' },
                               { stats, meta: {}, maps: {} });
        const blob = await new Promise(ok => r.canvas.toBlob(ok, 'image/png'));
        return res(!!blob && blob.size > 1000, blob ? `${Math.round(blob.size / 1024)} KB` : '輸出失敗');
    });
    await check('報表', '進階選項：鐵路只留高鐵時圖變短、全關時區塊不畫', async () => {
        const stats = await fog.compute(records(photos), 'photo');
        const env = { stats, meta: {}, maps: {} };
        const base = { blocks: new Set(['rail']), missing: new Set(['rail']), hideDates: false, nickname: '測試', mapLevel: 'town' };
        const all = renderReport(base, env).height;
        const keys = subsOf('rail', stats).map(x => x.key);
        const hsr = renderReport({ ...base, subOff: { rail: keys.filter(k => k !== 'hsr') } }, env).height;
        const none = renderReport({ ...base, subOff: { rail: keys } }, env).height;
        const empty = renderReport({ ...base, blocks: new Set() }, env).height;
        return res(hsr < all && none === empty, `全部 ${all}、只留高鐵 ${hsr}、全關 ${none}（沒有區塊 ${empty}）px`);
    });
    await check('報表', '進階選項：景點分區、國家公園與保護區分類別，關掉的子類別不畫', async () => {
        const stats = await fog.compute(records(photos), 'photo');
        const env = { stats, meta: {}, maps: {} };
        const out = [];
        let ok = true;
        for (const id of ['landmark', 'nature']) {
            const subs = subsOf(id, stats);
            const base = { blocks: new Set([id]), missing: new Set([id]), hideDates: false, nickname: '測試', mapLevel: 'town' };
            const all = renderReport(base, env).height;
            const one = renderReport({ ...base, subOff: { [id]: subs.slice(1).map(x => x.key) } }, env).height;
            const none = renderReport({ ...base, subOff: { [id]: subs.map(x => x.key) } }, env).height;
            const empty = renderReport({ ...base, blocks: new Set() }, env).height;
            ok = ok && subs.length > 1 && one < all && none === empty;
            out.push(`${id}：${subs.map(x => x.label).join('、')}（全部 ${all}、只留${subs[0].label} ${one} px）`);
        }
        return res(ok, out.join('；'));
    });
    await check('報表', '進階選項：累積曲線開關、村里進度選一個縣市改列各鄉鎮', async () => {
        const stats = await fog.compute(records(photos), 'photo');
        const env = { stats, meta: {}, maps: {} };
        const base = { blocks: new Set(['yearly']), missing: new Set(['villages']), hideDates: false, nickname: '測試', mapLevel: 'town' };
        const on = renderReport(base, env).height, off = renderReport({ ...base, cumul: false }, env).height;
        // 村里進度：各縣市 22 列；選第一個有足跡的縣市，列數＝該縣市鄉鎮數
        const vb = { ...base, blocks: new Set(['villages']) };
        const all = renderReport(vb, env).height;
        const c = stats.counties.find(x => x.villages_unlocked > 0);
        const towns = stats.towns.filter(t => t.county === c.code).length;
        const one = renderReport({ ...vb, vCounty: c.code }, env).height;
        const ok = on === off + 22 && one - all === (towns - stats.counties.length) * 34;
        return res(ok, `每年新解鎖：有曲線 ${on}、無曲線 ${off} px；村里進度：各縣市 ${all}、${c.name}（${towns} 鄉鎮）${one} px`);
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
