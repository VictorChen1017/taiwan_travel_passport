// 迷霧探索計算核心：紀錄 → 所屬村里 → 解鎖統計、成就、成就明細
// 改寫自原專案 dashboard/explore_stats.php（規格見 docs/SPEC.md §3、§6）
//
// 與原專案的差異：
// - 不輸出照片數（統計只看首次解鎖時間）；以張數計算的成就（regular 老地方）只在照片模式出現
// - 鄉鎮由村里代碼前 8 碼推得
// - 文字「拍照」改為「有足跡」，「張」改為「筆」（照片模式的老地方除外）

import { PolygonIndex, PointIndex, toGeoJSON } from './geo.js';

// 台灣範圍（含東沙、太平島）；範圍外的紀錄不參與任何計算
const BOUNDS = { lng0: 114, lng1: 124.7, lat0: 10, lat1: 26.5 };
const DAY = 86400;
const SIX = ['63000', '64000', '65000', '66000', '67000', '68000'];

const pad = n => String(n).padStart(2, '0');
// time 是「當地時鐘時間當成 UTC」：一律用 UTC 解讀
const ymd = t => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const md = t => { const d = new Date(t * 1000); return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const hm = t => { const d = new Date(t * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const year = t => new Date(t * 1000).getUTCFullYear();
const fmtInt = n => n.toLocaleString('en-US');
const fmtNum = n => Number.isInteger(n) ? fmtInt(n) : n.toLocaleString('en-US', { maximumFractionDigits: 1 });
const minNull = (a, b) => a === null ? b : b === null ? a : Math.min(a, b);
const maxOrNull = arr => arr.length && !arr.includes(null) ? Math.max(...arr) : null;

// =====================================================================
// 靜態資料準備（索引建一次，之後每次計算共用）
// =====================================================================

/**
 * @param d  { units, achievements, peaks, rail, villagesTopo, areasTopo }（data/ 下的 JSON）
 */
export function prepareStatic(d) {
    const S = { ...d };
    S.villIndex = new PolygonIndex(d.villagesTopo, 'villages');
    S.areaIndex = d.areasTopo ? new PolygonIndex(d.areasTopo, 'areas') : null;

    // 村里、鄉鎮的索引與對照
    S.towns = d.units.towns.map(([code, county, countyName, name, area]) => ({ code, county, countyName, name, area }));
    S.townIdx = new Map(S.towns.map((t, i) => [t.code, i]));
    S.vills = d.units.villages.map(([code, town, name, area]) => ({ code, town, name, area, ti: S.townIdx.get(town) }));
    S.villIdx = new Map(S.vills.map((v, i) => [v.code, i]));
    // TopoJSON 的幾何順序 → units 的村里索引
    S.topoToVill = Int32Array.from(S.villIndex.ids, id => S.villIdx.has(id) ? S.villIdx.get(id) : -1);
    S.areaPos = S.areaIndex ? new Map(S.areaIndex.ids.map((id, i) => [id, i])) : new Map();
    return S;
}

// =====================================================================
// 計算
// =====================================================================

/**
 * @param R     紀錄 { lat: Float64Array, lng: Float64Array, time: Float64Array（NaN＝不明），
 *              kind?: Uint8Array（3 手動紀錄、4 以範圍判定地點的手動紀錄）, ref?: Int32Array（手動紀錄編號，其他 -1）,
 *              targets?: string[]（手動紀錄編號 → 地點成就 id，kind 4 用）}
 *              kind 4 的座標只是代表點：不參與村里、半徑、保護區判定，只讓 targets 指定的地點成就解鎖
 * @param S     prepareStatic() 的結果
 * @param opts  { mode: 'photo' | 'visit', now: 未來時間上限（unix 秒，預設 現在 + 14 小時） }
 * @returns     { stats, ctx }：stats 為統計＋成就（格式同原專案 type=stats，去掉照片數）；ctx 供 detail() 使用
 */
export function compute(R, S, opts = {}) {
    const mode = opts.mode || 'visit';
    const now = opts.now ?? Math.floor(Date.now() / 1000) + 14 * 3600;
    const n = R.lat.length;
    const valid = t => t > 0 && t < now;   // NaN 也是 false
    const T = i => valid(R.time[i]) ? R.time[i] : null;

    // ---------- ① 所屬村里（同一座標只判定一次） ----------

    const K = R.kind || null, REF = R.ref || null;
    const inBounds = new Uint8Array(n);
    const vill = new Int32Array(n).fill(-1);
    const cache = new Map();
    const inside = [];
    const manualPlace = new Map();   // 地點成就 id → kind 4 的紀錄編號
    for (let i = 0; i < n; i++) {
        if (K && K[i] === 4) {
            const tg = R.targets && REF ? R.targets[REF[i]] : null;
            if (tg) { if (!manualPlace.has(tg)) manualPlace.set(tg, []); manualPlace.get(tg).push(i); }
            continue;
        }
        const la = R.lat[i], lo = R.lng[i];
        if (!(la >= BOUNDS.lat0 && la <= BOUNDS.lat1 && lo >= BOUNDS.lng0 && lo <= BOUNDS.lng1)) continue;
        inBounds[i] = 1;
        inside.push(i);
        const key = Math.round(la * 1e5) * 16777216 + Math.round(lo * 1e5);
        let v = cache.get(key);
        if (v === undefined) {
            const g = S.villIndex.find(lo, la);
            v = g < 0 ? -1 : S.topoToVill[g];
            cache.set(key, v);
        }
        vill[i] = v;
    }
    const pts = new PointIndex(R.lat, R.lng, Int32Array.from(inside));

    // ---------- 村里、鄉鎮彙總 ----------

    const nv = S.vills.length, nt = S.towns.length;
    const villN = new Int32Array(nv), villFirst = new Array(nv).fill(null);
    const townN = new Int32Array(nt), townFirst = new Array(nt).fill(null);
    for (let i = 0; i < n; i++) {
        const v = vill[i];
        if (v < 0) continue;
        const t = T(i), ti = S.vills[v].ti;
        villN[v]++; townN[ti]++;
        if (t !== null) { villFirst[v] = minNull(villFirst[v], t); townFirst[ti] = minNull(townFirst[ti], t); }
    }

    const villages = [];
    const villByTown = new Map();   // ti → [總數, 已解鎖, 總面積, 已解鎖面積]
    let villTotalArea = 0, villUnlockedArea = 0;
    S.vills.forEach((v, i) => {
        let b = villByTown.get(v.ti);
        if (!b) villByTown.set(v.ti, b = [0, 0, 0, 0]);
        b[0]++; b[2] += v.area; villTotalArea += v.area;
        if (villN[i] > 0) {
            b[1]++; b[3] += v.area; villUnlockedArea += v.area;
            villages.push({ code: v.code, town: v.town, name: v.name, area: v.area, first: villFirst[i] });
        }
    });

    const towns = [];
    const countyMap = new Map();
    let townTotalArea = 0, townUnlockedArea = 0, townsUnlocked = 0;
    S.towns.forEach((t, i) => {
        const unlocked = townN[i] > 0;
        const vb = villByTown.get(i) || [0, 0, 0, 0];
        towns.push({ code: t.code, county: t.county, name: t.name, area: t.area, first: townFirst[i], unlocked,
                     villages: vb[0], villages_unlocked: vb[1],
                     village_area: round(vb[2], 3), village_area_unlocked: round(vb[3], 3) });
        townTotalArea += t.area;
        if (unlocked) { townUnlockedArea += t.area; townsUnlocked++; }
        let c = countyMap.get(t.county);
        if (!c) countyMap.set(t.county, c = { code: t.county, name: t.countyName, area: 0, first: null, unlocked: false,
                                               towns: 0, towns_unlocked: 0, town_area_unlocked: 0,
                                               villages: 0, villages_unlocked: 0, village_area_unlocked: 0 });
        c.area += t.area; c.towns++; c.villages += vb[0]; c.villages_unlocked += vb[1]; c.village_area_unlocked += vb[3];
        if (unlocked) {
            c.unlocked = true; c.towns_unlocked++; c.town_area_unlocked += t.area;
            c.first = minNull(c.first, townFirst[i]);
        }
    });
    const counties = [...countyMap.values()];
    let countyTotalArea = 0, countyUnlockedArea = 0;
    for (const c of counties) {
        for (const k of ['area', 'town_area_unlocked', 'village_area_unlocked']) c[k] = round(c[k], 3);
        countyTotalArea += c.area;
        if (c.unlocked) countyUnlockedArea += c.area;
    }

    const summary = {
        county: { total: counties.length, unlocked: counties.filter(c => c.unlocked).length,
                  area: round(countyTotalArea, 1), area_unlocked: round(countyUnlockedArea, 1) },
        town: { total: towns.length, unlocked: townsUnlocked, area: round(townTotalArea, 1), area_unlocked: round(townUnlockedArea, 1) },
        village: { total: nv, unlocked: villages.length, area: round(villTotalArea, 1), area_unlocked: round(villUnlockedArea, 1) },
    };

    // ---------- 成就 ----------

    const cfg = S.achievements;
    const achievements = [];
    const add = (id, group, name, desc, icon, tier, progress, target, date, extra = {}) => {
        achievements.push({ id, group, name, desc, icon, tier, progress: Math.min(progress, target), target,
                            done: progress >= target, date: progress >= target ? date : null, ...extra });
    };
    const firstsOf = items => items.map(x => x.first).filter(v => v !== null).sort((a, b) => a - b);
    const nth = (f, k) => f.length >= k ? f[k - 1] : null;
    const townFirsts = firstsOf(towns), villFirsts = firstsOf(villages), countyFirsts = firstsOf(counties);

    // 里程碑
    add('first', 'milestone', '初次踏足', '第一筆落在台灣鄉鎮內的足跡', 'pin', 'bronze',
        townFirsts.length, 1, nth(townFirsts, 1), { section: '縣市' });
    const msDefs = {
        county: ['縣市', countyFirsts, counties.length, 'compass', '踏足 %s 個縣市', '全台足跡', '踏足全部 %s 個縣市'],
        town: ['鄉鎮', townFirsts, towns.length, 'flag', '解鎖 %s 個鄉鎮市區', '鄉鎮全制霸', '解鎖全部 %s 個鄉鎮市區'],
        village: ['村里', villFirsts, nv, 'home', '解鎖 %s 個村里', '村里全制霸', '解鎖全部 %s 個村里'],
    };
    for (const [k, [label, firsts, total, icon, descFmt, allName, allDescFmt]] of Object.entries(msDefs)) {
        for (const [m, tier] of cfg.milestones[k]) {
            if (m >= total) continue;
            add(`${k}_${m}`, 'milestone', `${label} ${fmtInt(m)}`, descFmt.replace('%s', fmtInt(m)), icon, tier,
                firsts.length, m, nth(firsts, m), { section: label });
        }
        add(`${k}_all`, 'milestone', allName, allDescFmt.replace('%s', fmtInt(total)), icon, 'legend',
            firsts.length, total, nth(firsts, total), { section: label });
    }

    // 制霸：縣市內所有鄉鎮都解鎖；日期＝最後一個鄉鎮的首次解鎖日
    const conquer = counties.map(c => {
        const done = c.towns_unlocked === c.towns;
        let date = null;
        if (done) date = maxOrNull(towns.filter(t => t.county === c.code).map(t => t.first));
        return { code: c.code, name: c.name, done, date, progress: c.towns_unlocked, target: c.towns };
    });
    const conquered = conquer.filter(x => x.done);
    const conquerDates = conquered.map(x => x.date).filter(v => v !== null).sort((a, b) => a - b);
    add('conquer', 'conquer', '縣市制霸', '縣市內所有鄉鎮市區都解鎖（集點卡）', 'crown', 'gold',
        conquered.length, conquer.length, conquerDates.length ? conquerDates[conquerDates.length - 1] : null, { cells: conquer });
    const sixC = counties.filter(c => SIX.includes(c.code));
    add('six_visit', 'conquer', '六都踏足', '六個直轄市都留下足跡', 'city', 'silver',
        sixC.filter(c => c.unlocked).length, 6, maxOrNull(sixC.map(c => c.first)));
    const sixConq = conquer.filter(x => SIX.includes(x.code));
    add('six_conquer', 'conquer', '六都制霸', '六都所有區都解鎖', 'city', 'legend',
        sixConq.filter(x => x.done).length, 6, maxOrNull(sixConq.map(x => x.date)));

    // 半徑判定：回傳 [筆數, 首次時間]
    const radiusStat = (points, r) => {
        let cnt = 0, first = null;
        const seen = points.length > 1 ? new Set() : null;
        for (const [la, lo] of points) {
            pts.around(la, lo, r, i => {
                if (seen) { if (seen.has(i)) return; seen.add(i); }
                cnt++;
                const t = T(i);
                if (t !== null) first = minNull(first, t);
            });
        }
        return [cnt, first];
    };

    // 登山：百岳、小百岳
    const peakCells = {};
    const peakR = S.peaks.radius;
    for (const l of S.peaks.lists) {
        const cells = l.peaks.map(([no, name, la, lo, ele]) => {
            const [c, first] = radiusStat([[la, lo]], peakR);
            return { code: no, name, done: c > 0, date: c > 0 ? first : null, progress: c > 0 ? 1 : 0, target: 1, ele, lat: la, lng: lo };
        });
        peakCells[l.id] = cells;
        const doneDates = cells.filter(c => c.done).map(c => c.date);
        add(l.id, 'peak', l.name, l.desc, 'mountain', l.tier, doneDates.length, cells.length, maxOrNull(doneDates),
            { cells, detail: true });
    }

    // 鐵道
    const railCells = {};
    const railR = S.rail.radius;
    const stationStat = S.rail.stations.map(s => radiusStat(s.pts, railR));
    for (const card of S.rail.cards) {
        const cells = card.cells.map((c, k) => {
            const s = S.rail.stations[c.s];
            const [cnt, first] = stationStat[c.s];
            const cell = { code: k + 1, name: s.name, done: cnt > 0, date: cnt > 0 ? first : null, progress: cnt > 0 ? 1 : 0, target: 1,
                           lat: s.lat, lng: s.lng, st: c.s };
            for (const key of ['grade', 'tier', 'lines', 'colors']) if (c[key] !== undefined) cell[key] = c[key];
            return cell;
        });
        for (const p of card.parts) {
            const lc = p.cells.map(k => cells[k]);
            railCells[p.id] = lc;
            const ld = lc.filter(c => c.done).map(c => c.date);
            add(p.id, card.group, p.name, `${lc.length} 站全部到過`, 'flag', '', ld.length, lc.length, maxOrNull(ld),
                { section: '路線制霸', detail: true });
        }
        railCells[card.id] = cells;
        const dd = cells.filter(c => c.done).map(c => c.date);
        add(card.id, card.group, card.name, card.desc, 'train', '', dd.length, cells.length, maxOrNull(dd),
            { section: card.section, cells, detail: true });
    }

    // 保護區：每筆紀錄落在哪些範圍
    const areaN = new Int32Array(S.areaIndex ? S.areaIndex.ids.length : 0);
    const areaFirst = new Array(areaN.length).fill(null);
    if (S.areaIndex) {
        for (const i of inside) {
            const t = T(i);
            S.areaIndex.each(R.lng[i], R.lat[i], a => { areaN[a]++; if (t !== null) areaFirst[a] = minNull(areaFirst[a], t); });
        }
    }

    // 地點類：極點、離島、景點、B 級景點、國家公園與保護區
    const placeStat = p => {
        const [cnt, first] = placeStatGeo(p);
        const m = manualPlace.get(p.id);
        if (!m) return [cnt, first];
        let f = first;
        for (const i of m) { const t = T(i); if (t !== null) f = minNull(f, t); }
        return [cnt + m.length, f];
    };
    const placeStatGeo = p => {
        if (p.points) return radiusStat(p.points, p.radius);
        let cnt = 0, first = null;
        if (p.villages) {
            for (const code of p.villages) {
                const v = S.villIdx.get(code);
                if (v === undefined) continue;
                cnt += villN[v]; first = minNull(first, villFirst[v]);
            }
        } else if (p.areas) {
            for (const code of p.areas) {
                const a = S.areaPos.get(code);
                if (a === undefined) continue;
                cnt += areaN[a]; first = minNull(first, areaFirst[a]);
            }
        }
        return [cnt, first];
    };
    const fourTotal = cfg.places.filter(p => p.four).length;
    const fourDates = [];
    for (const p of cfg.places) {
        const [cnt, first] = placeStat(p);
        if (p.four) fourDates.push(cnt > 0 ? first : null);
        add(p.id, p.group, p.name, p.desc, p.icon, p.tier, cnt > 0 ? 1 : 0, 1, first, { section: p.section, detail: true });
        if (p.four && fourDates.length === fourTotal) {
            add('pole_all', 'pole', '四極全制霸', '本島東西南北四個極點都去過', 'star', 'legend',
                fourDates.filter(v => v !== null).length, fourTotal, maxOrNull(fourDates), { section: p.section });
        }
    }

    // ---------- 旅行 ----------

    const tr = cfg.travel;
    // 每日：當地日期 → 最早時間、縣市、鄉鎮（只計時間正常、落在鄉鎮內的紀錄）
    const dayMap = new Map();
    for (let i = 0; i < n; i++) {
        const v = vill[i], t = T(i);
        if (v < 0 || t === null) continue;
        const d = Math.floor(t / DAY);
        let r = dayMap.get(d);
        if (!r) dayMap.set(d, r = { d, t, counties: new Set(), towns: new Set() });
        if (t < r.t) r.t = t;
        const ti = S.vills[v].ti;
        r.towns.add(ti); r.counties.add(S.towns[ti].county);
    }
    const dayRows = [...dayMap.values()].sort((a, b) => a.d - b.d);
    const dayBest = (k, target) => {
        let max = 0, date = null, bestDay = null, count = 0;
        for (const r of dayRows) {
            const v = r[k].size;
            if (v > max) { max = v; bestDay = r.t; }
            if (v >= target) { count++; if (date === null) date = r.t; }
        }
        return [max, date, bestDay, count];
    };
    const [maxC, dateC, dayC, cntC] = dayBest('counties', tr.road_trip_counties);
    add('road_trip', 'travel', '公路旅行', `單日跨 ${tr.road_trip_counties} 個縣市`, 'car', 'silver', maxC, tr.road_trip_counties, dateC,
        { detail: true, note: dayC !== null ? `共 ${cntC} 天達成；最多：${ymd(dayC)} 單日 ${maxC} 個縣市` : null });
    const [maxT, dateT, dayT, cntT] = dayBest('towns', tr.multi_town_towns);
    add('multi_town', 'travel', '一日多鄉', `單日走過 ${tr.multi_town_towns} 個鄉鎮市區`, 'car', 'bronze', maxT, tr.multi_town_towns, dateT,
        { detail: true, note: dayT !== null ? `共 ${cntT} 天達成；最多：${ymd(dayT)} 單日 ${maxT} 個鄉鎮` : null });

    // 單年新解鎖村里
    const annualN = tr.annual_villages;
    const byYear = new Map();
    for (const t of villFirsts) { const y = year(t); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(t); }
    let bestYearN = 0, yearDate = null, bestYear = null;
    for (const [y, ts] of [...byYear].sort((a, b) => a[0] - b[0])) {
        if (ts.length > bestYearN) { bestYearN = ts.length; bestYear = y; }
        if (yearDate === null && ts.length >= annualN) yearDate = ts[annualN - 1];
    }
    add('annual', 'travel', '年度探險家', `單一年度新解鎖 ${annualN} 個村里`, 'calendar', 'gold', bestYearN, annualN, yearDate,
        { detail: true, note: bestYear ? `最多：${bestYear} 年新解鎖 ${bestYearN} 個村里` : null });

    // 名稱
    const villName = v => {
        const x = S.vills[v], t = S.towns[x.ti];
        return `${t.countyName} ${t.name} ${x.name || '（無名稱）'}`;
    };

    // 老地方（只在照片模式）：同一村里累積 N 張；日期＝第 N 張（時間正常者）的時間
    let topVills = null;
    if (mode === 'photo') {
        const regularN = tr.regular_photos;
        topVills = [...villN.keys()].filter(v => villN[v] > 0).sort((a, b) => villN[b] - villN[a]);
        const top = topVills.length ? topVills[0] : null;
        const topN = top !== null ? villN[top] : 0;
        let regularDate = null;
        if (top !== null && topN >= regularN) {
            const ts = [];
            for (let i = 0; i < n; i++) if (vill[i] === top && T(i) !== null) ts.push(R.time[i]);
            ts.sort((a, b) => a - b);
            regularDate = ts.length >= regularN ? ts[regularN - 1] : null;
        }
        add('regular', 'travel', '老地方', `同一個村里累積 ${fmtInt(regularN)} 張照片`, 'heart', 'silver', topN, regularN, regularDate,
            { detail: true, note: top !== null ? `最多：${villName(top)} ${fmtInt(topN)} 張` : null });
    }

    const stats = { ok: true, mode, generated: Math.floor(Date.now() / 1000), summary, counties, towns, villages, achievements };
    const ctx = { R, S, mode, now, vill, inBounds, pts, T, valid, villN, villFirst, villages, peakCells, railCells, achievements,
                  villName, topVills, K, REF, manualPlace };
    return { stats, ctx };
}

// =====================================================================
// 成就明細（格式同原專案 type=detail，去掉照片數）
// =====================================================================

export function detail(ctx, id) {
    const { R, S, vill, T } = ctx;
    const a = ctx.achievements.find(x => x.id === id);
    if (!a || !a.detail) return { ok: false, error: '這個成就沒有明細' };
    const tr = S.achievements.travel;
    let rows = [], columns = [], note = null, geo = null, addInfo = null;

    if (id === 'road_trip' || id === 'multi_town') {
        const isTrip = id === 'road_trip';
        const target = isTrip ? tr.road_trip_counties : tr.multi_town_towns;
        // 每天每個鄉鎮的第一筆時間 → 依造訪順序列出鄉鎮
        const perDay = new Map();   // 日 → Map(ti → 最早時間)
        for (let i = 0; i < R.lat.length; i++) {
            const v = vill[i], t = T(i);
            if (v < 0 || t === null) continue;
            const d = Math.floor(t / DAY), ti = S.vills[v].ti;
            let m = perDay.get(d);
            if (!m) perDay.set(d, m = new Map());
            if (!m.has(ti) || t < m.get(ti)) m.set(ti, t);
        }
        columns = isTrip ? ['日期', '縣市數', '經過的縣市（依造訪順序）'] : ['日期', '鄉鎮數', '縣市'];
        for (const [d, m] of perDay) {
            const list = [...m].sort((x, y) => x[1] - y[1]);
            const cs = [...new Set(list.map(([ti]) => S.towns[ti].countyName))];
            const nc = new Set(list.map(([ti]) => S.towns[ti].county)).size, nt = list.length;
            if ((isTrip ? nc : nt) < target) continue;
            rows.push({ date: list[0][1], value: isTrip ? nc : nt, hit: true,
                        cells: [ymd(d * DAY), isTrip ? `${nc} 個縣市` : `${nt} 個鄉鎮`, cs.join('、')],
                        items: list.map(([ti]) => `${S.towns[ti].countyName} ${S.towns[ti].name}`), items_label: `走過的 ${nt} 個鄉鎮` });
        }
        note = `共 ${rows.length} 天；以當地日期切日，只計時間正常的紀錄；點一列可展開走過的鄉鎮`;
    } else if (id === 'annual') {
        const annualN = tr.annual_villages;
        columns = ['年份', '新解鎖村里', ''];
        const vs = ctx.villages.filter(v => v.first !== null).sort((x, y) => x.first - y.first);
        const years = new Map();
        for (const v of vs) { const y = year(v.first); if (!years.has(y)) years.set(y, []); years.get(y).push(v); }
        for (const [y, list] of years) {
            rows.push({ date: y, value: list.length, hit: list.length >= annualN,
                        cells: [`${y} 年`, `${list.length} 個村里`, list.length >= annualN ? '✓ 達成' : ''],
                        items: list.map(v => `${md(v.first)} ${ctx.villName(S.villIdx.get(v.code))}`), items_label: '依解鎖順序' });
        }
        note = `門檻：單一年度新解鎖 ${annualN} 個村里；點一列可展開該年解鎖的村里`;
    } else if (id === 'regular') {
        columns = ['村里', '照片數', '首次'];
        for (const v of (ctx.topVills || []).slice(0, 20)) {
            const n = ctx.villN[v], first = ctx.villFirst[v];
            rows.push({ date: first ?? 0, value: n, hit: n >= tr.regular_photos,
                        cells: [ctx.villName(v), `${fmtInt(n)} 張`, first ? ymd(first) : '—'] });
        }
        note = `照片最多的前 20 個村里；門檻 ${fmtInt(tr.regular_photos)} 張`;
    } else if (ctx.peakCells[id] || ctx.railCells[id]) {
        const isPeak = !!ctx.peakCells[id];
        const cells = isPeak ? ctx.peakCells[id] : ctx.railCells[id];
        const verb = isPeak ? '登頂' : '到站';
        columns = isPeak ? ['山名', '首次登頂'] : ['車站', '首次到站'];
        let done = 0;
        for (const c of cells) {
            const label = isPeak ? `#${c.code} ${c.name}（${fmtNum(c.ele)} m）` : c.name + (c.grade ? `（${c.grade}站）` : '');
            if (!c.done) {
                // 未到：可以手動加入（座標取山頂或車站的第一個點）
                const p0 = isPeak ? [c.lat, c.lng] : S.rail.stations[c.st].pts[0];
                rows.push({ date: -1, value: 0, hit: false, cells: [label, `尚未${verb}`],
                            add: { target: `${id}#${c.code}`, label: c.name, lat: p0[0], lng: p0[1], area: false } });
                continue;
            }
            done++;
            // 手動紀錄各列一行（可刪除）；其他紀錄合成一行
            const at = isPeak ? [[c.lat, c.lng]] : S.rail.stations[c.st].pts;
            const { manual, other } = splitManual(ctx, at, isPeak ? S.peaks.radius : S.rail.radius);
            if (other.length || !manual.length) {
                let f = null;
                for (const i of other) { const t = T(i); if (t !== null) f = minNull(f, t); }
                rows.push({ date: f ?? 0, value: 1, hit: true, cells: [label, f ? ymd(f) : '時間不明'] });
            }
            for (const i of manual) {
                const t = T(i);
                rows.push({ date: t ?? 0, value: 1, hit: true, cells: [label, `✋ ${t ? ymd(t) : '日期不明'}`], manual: ctx.REF[i] });
            }
        }
        note = isPeak ? `已登頂 ${done} / ${cells.length} 座；地圖紅點為已登頂、灰點為未登頂；未登頂的山可以手動加入`
                      : `已到站 ${done} / ${cells.length} 站；地圖紅點為已到站、灰點為未到站；未到的車站可以手動加入`;
        geo = { marks: cells.map(c => [c.lat, c.lng, isPeak ? `#${c.code} ${c.name}` : c.name, c.done]) };
    } else {
        // 地點：每次造訪（以天為單位）
        const p = S.achievements.places.find(x => x.id === id);
        const hits = placeRecords(ctx, p);
        columns = ['日期', '時間'];
        const days = new Map(), manualDays = new Set();
        let bad = 0;
        for (const i of hits) {
            const t = T(i);
            if (isManual(ctx, i)) {
                // 手動紀錄各列一行（可刪除），不併入當天
                rows.push({ date: t ?? 0, value: 1, hit: true, cells: [t ? ymd(t) : '日期不明', '✋ 手動加入'], manual: ctx.REF[i] });
                if (t !== null) manualDays.add(Math.floor(t / DAY));
                continue;
            }
            if (t === null) { bad++; continue; }
            const d = Math.floor(t / DAY);
            const r = days.get(d);
            if (!r) days.set(d, [t, t]);
            else { if (t < r[0]) r[0] = t; if (t > r[1]) r[1] = t; }
        }
        for (const [d, [t0, t1]] of days) {
            rows.push({ date: t0, value: 1, hit: true, cells: [ymd(d * DAY), t0 === t1 ? hm(t0) : `${hm(t0)} – ${hm(t1)}`] });
        }
        note = `共造訪 ${new Set([...days.keys(), ...manualDays]).size} 天` + (bad ? `；另有 ${bad} 筆紀錄時間不明` : '');
        // 小地圖：地點本身與在此的紀錄位置（最多 500 筆，新到舊；範圍類手動紀錄的代表點不畫）
        const recent = hits.filter(i => !(ctx.K && ctx.K[i] === 4))
            .sort((x, y) => (R.time[y] || 0) - (R.time[x] || 0)).slice(0, 500);
        geo = { photos: recent.map(i => [+R.lat[i].toFixed(5), +R.lng[i].toFixed(5)]) };
        if (p.points) { geo.points = p.points; geo.radius = p.radius; }
        else if (S.shapesTopo) geo.shape = toGeoJSON(S.shapesTopo, 'shapes', p.id);
        // 手動加入：有座標的用第一個點（kind 3，連帶解鎖所在村里）；以範圍判定的用代表點（kind 4，只算這個地點）
        const at = p.points ? p.points[0] : p.rep;
        if (at) addInfo = { target: p.id, label: p.name, lat: at[0], lng: at[1], area: !p.points };
    }

    const sort = id === 'regular' ? 'value' : 'date';
    rows.sort((x, y) => y[sort] - x[sort]);
    return { ok: true, id, name: a.name, desc: a.desc, sort, columns, rows, note, geo, add: addInfo };
}

/** 地點範圍內的紀錄編號 */
function placeRecords(ctx, p) {
    const { R, S, vill, pts } = ctx;
    const out = [];
    if (p.points) {
        const seen = new Set();
        for (const [la, lo] of p.points) pts.around(la, lo, p.radius, i => { if (!seen.has(i)) { seen.add(i); out.push(i); } });
    } else if (p.villages) {
        const want = new Set(p.villages.map(c => S.villIdx.get(c)));
        for (let i = 0; i < vill.length; i++) if (vill[i] >= 0 && want.has(vill[i])) out.push(i);
    } else if (p.areas && S.areaIndex) {
        const want = new Set(p.areas.map(c => S.areaPos.get(c)));
        for (let i = 0; i < R.lat.length; i++) {
            if (!ctx.inBounds[i]) continue;
            let hit = false;
            S.areaIndex.each(R.lng[i], R.lat[i], a => { if (want.has(a)) { hit = true; return true; } });
            if (hit) out.push(i);
        }
    }
    for (const i of ctx.manualPlace.get(p.id) || []) out.push(i);
    return out;
}

const isManual = (ctx, i) => !!ctx.K && (ctx.K[i] === 3 || ctx.K[i] === 4) && !!ctx.REF && ctx.REF[i] >= 0;

/** 一個或多個點半徑內的紀錄，分成手動紀錄與其他 */
function splitManual(ctx, points, r) {
    const seen = new Set(), manual = [], other = [];
    for (const [la, lo] of points) ctx.pts.around(la, lo, r, i => {
        if (seen.has(i)) return;
        seen.add(i);
        (isManual(ctx, i) ? manual : other).push(i);
    });
    return { manual, other };
}

/** 四捨五入到 d 位小數（先取 15 位有效數字，避免 58.0555 這類二進位誤差讓結果偏低；同 PHP round） */
function round(x, d) {
    const f = 10 ** d;
    return Math.round(+(x * f).toPrecision(15)) / f;
}
