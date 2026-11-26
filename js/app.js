// 頁面主程式：匯入資料來源 → 存進 IndexedDB → 計算（Worker）→ 成就頁、成就目錄、計算模式切換
//
// 資料來源轉接器：照片資料夾（js/adapters/exif.js）；Google 時間軸、Google 相簿 Takeout 待第 5、6 階段
// 網址加 ?dev 會出現「載入原專案測試資料」（test/ 不會部署）

import { FogClient } from './core/client.js';
import { createExplore, GROUP_LABEL, HIDDEN_GROUPS } from './explore.js';
import { listSources, saveSource, removeSource, clearSources, newId } from './store.js';
import * as exif from './adapters/exif.js';
import * as gtl from './adapters/gtimeline.js';
import { exportBackup, parseBackup } from './backup.js';
import * as manual from './manual.js';
import { GROUP_COLOR } from './shared.js';
import { createReport } from './report.js';
import { TOUCH } from './device.js';
import { openGuide, guideSeen } from './guide.js';

const STEPS_KEY = 'fog-steps-done';    // 首頁三步驟：看過成就、匯出過卡片（localStorage，只是顯示用）
const PATH_KEY = 'fog-include-path';   // 「包含移動路徑」記在 localStorage（只是顯示偏好）
const readPathPref = () => { try { return localStorage.getItem(PATH_KEY) === '1'; } catch (e) { return false; } };

const DATA = new URL('../data/', import.meta.url).href;
const SOURCE_ICON = { exif: '📁', gphotos: '🖼️', gtimeline: '🗺️', manual: '✋' };
const PHOTO_TYPES = new Set(['exif', 'gphotos']);
// 手機照片（補點）：type 'exif'、id 固定 'phone'，每次選的照片追加進同一份（備份以 id 保留）
const PHONE_ID = 'phone';
const sourceIcon = s => s.id === PHONE_ID ? '📱' : (SOURCE_ICON[s.type] || '📄');

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = n => Number(n || 0).toLocaleString();
const pad = n => String(n).padStart(2, '0');
const ymd = t => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

// ---------- 狀態 ----------

const app = {
    fog: null,
    ready: null,       // 靜態資料載入（第一次計算時才開始）
    version: null,     // version.json 的檔案雜湊
    sources: [],       // 匯入的資料來源（見 js/store.js）
    mode: 'visit',
    modeTouched: false, // 使用者自己切過模式就不再自動改
    includePath: readPathPref(),   // 時間軸的移動途中也算（預設不算）
    explore: null,
    abort: null,       // 匯入中的取消控制
};

const hasPhotos = () => app.sources.some(s => PHOTO_TYPES.has(s.type));
const hasTimeline = () => app.sources.some(s => s.type === 'gtimeline');
const manualSource = () => app.sources.find(s => s.type === 'manual') || null;
const hasManual = () => !!manualSource()?.items.length;

// ---------- 靜態資料與 Worker ----------

function ensureReady() {
    if (!app.ready) {
        app.fog = new FogClient(DATA);
        app.fog.onprogress = p => {
            if (p.step !== 'load') return;
            const mb = b => (b / 1048576).toFixed(1);
            busy('下載圖資中…', p.totalBytes
                ? { ratio: Math.min(1, p.bytes / p.totalBytes), detail: `${mb(Math.min(p.bytes, p.totalBytes))} / ${mb(p.totalBytes)} MB` }
                : { detail: `已下載 ${mb(p.bytes)} MB` });
        };
        app.ready = Promise.all([
            app.fog.init(),
            fetch(DATA + 'version.json', { cache: 'no-cache' }).then(r => r.json()).then(v => { app.version = v; }),
        ]).catch(e => { app.ready = null; throw e; });
    }
    return app.ready;
}

function loadMap(level) {
    const name = `map_${level}.json`;
    return fetch(`${DATA}${name}?v=${app.version?.files?.[name] || ''}`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    });
}

// ---------- 計算 ----------

/**
 * 合併各來源的紀錄。照片模式只用照片來源（手動紀錄只在造訪模式計入）；「包含移動路徑」關閉時排除 kind 2
 * kind：0 照片、1 停留點、2 移動途中、3 手動紀錄、4 以範圍判定地點的手動紀錄
 * 手動紀錄另外帶 ref（items 的編號）與 targets（編號 → 地點成就 id），明細才知道哪一列是哪一筆
 */
function mergedRecords(mode) {
    const srcs = app.sources.filter(s => mode !== 'photo' || PHOTO_TYPES.has(s.type));
    const keep = k => app.includePath || k !== 2;
    let n = 0;
    for (const s of srcs) n += s.records.kind.length;
    const lat = new Float64Array(n), lng = new Float64Array(n), time = new Float64Array(n);
    const kind = new Uint8Array(n), ref = new Int32Array(n).fill(-1);
    // 去掉完全相同的紀錄（座標與時間都一樣）：同一張照片在不同來源、同一個資料夾匯入兩份時只算一次
    // 手動紀錄不去重複（加入時已擋掉同一地點同一天）
    const seen = new Set();
    let o = 0, dup = 0;
    for (const s of srcs) {
        const R = s.records, isManual = s.type === 'manual';
        for (let i = 0; i < R.kind.length; i++) {
            if (!keep(R.kind[i])) continue;
            if (!isManual) {
                const key = `${R.lat[i]},${R.lng[i]},${R.time[i]}`;
                if (seen.has(key)) { dup++; continue; }
                seen.add(key);
            }
            lat[o] = R.lat[i]; lng[o] = R.lng[i]; time[o] = R.time[i]; kind[o] = R.kind[i];
            if (isManual) ref[o] = i;
            o++;
        }
    }
    app.lastDup = dup;   // 開發測試用
    const m = mode !== 'photo' ? manualSource() : null;
    app.manualSnapshot = m ? m.items.slice() : [];   // 這次計算用的手動紀錄（ref → item）
    return { lat: lat.slice(0, o), lng: lng.slice(0, o), time: time.slice(0, o), kind: kind.slice(0, o), ref: ref.slice(0, o),
             targets: app.manualSnapshot.map(it => it.target) };
}

/** 有沒有「移動途中」的紀錄（決定要不要顯示開關） */
const hasPathRecords = () => app.sources.some(s => s.type === 'gtimeline' && s.records.kind.some(k => k === 2));

/** 依來源決定預設模式：有時間軸或手動紀錄用造訪模式，只有照片用照片模式 */
function defaultMode() {
    if (!hasPhotos()) return 'visit';
    if (app.modeTouched) return app.mode;
    return hasTimeline() || hasManual() ? 'visit' : 'photo';
}

/** 計算並顯示成就。沒有任何來源也照常計算（全部未解鎖），讓沒有資料的人也能看成就、手動加入 */
async function compute({ show = true } = {}) {
    app.mode = defaultMode();
    busy('準備中…');
    try {
        await ensureReady();
        busy('計算中…');
        const stats = await app.fog.compute(mergedRecords(app.mode), app.mode);
        if (!app.explore) {
            app.explore = createExplore($('explore'), {
                loadMap, loadDetail: id => app.fog.detail(id),
                manual: { add: addManual, remove: removeManual, item: ref => app.manualSnapshot[ref] || null },
            });
        }
        app.explore.setData(stats);
        renderModeSeg();
        renderToc();
        if (show) showExplore();
    } catch (e) {
        console.error(e);
        alert('計算失敗：' + e.message);
    } finally {
        busy(null);
    }
}

// ---------- 資料來源 ----------

/** 最後修改時間（舊資料沒有 updated 時用加入時間） */
const updatedOf = s => s.updated || s.added || 0;

/**
 * 加入新來源。已經有同類型、同名的來源（例如重新掃描同一個資料夾）時，問要不要取代：
 * 取代就沿用原本的 id 與加入時間（之後的備份才判斷得出新舊），否則另外新增一份
 */
async function addSource(src, { persist = true } = {}) {
    const now = Date.now();
    const old = app.sources.find(s => s.type === src.type && s.name === src.name);
    if (old && confirm(`已經有「${old.name}」（${ymdLocal(updatedOf(old))} 匯入）。\n\n要用這次的結果取代舊的嗎？\n・確定：取代舊的\n・取消：另外新增一份`)) {
        src.id = old.id;
        src.added = old.added;
        src.updated = now;
        app.sources[app.sources.indexOf(old)] = src;
    } else {
        src.id = newId();
        src.added = now;
        src.updated = now;
        app.sources.push(src);
    }
    if (persist) await saveSource(src);
    renderSources();
    await compute();
}

// ---------- 手動紀錄（js/manual.js） ----------

/**
 * 手動加入一筆（成就明細彈窗呼叫）。info：{ target, label, lat, lng, area }；date：'YYYY-MM-DD' 或空字串
 * 照片模式不計入手動紀錄，所以加入時自動切到造訪模式
 * @returns 錯誤訊息（給使用者看）或 null
 */
async function addManual(info, date) {
    let src = manualSource();
    const time = manual.dateToTime(date);
    if (src && manual.findSame(src, info.target, time)) return time ? `「${info.label}」在 ${date} 已經有手動紀錄了` : `「${info.label}」已經有一筆沒有日期的手動紀錄了`;
    if (!src) { src = manual.emptyManual(); app.sources.push(src); }
    src.items.push(manual.newItem(info, date));
    src.updated = Date.now();
    manual.refresh(src);
    await saveSource(src);
    renderSources();
    let switched = false;
    if (app.mode === 'photo') { app.mode = 'visit'; app.modeTouched = true; switched = true; }
    await compute({ show: false });
    if (switched) setTimeout(() => alert('已切換到「造訪模式」：手動紀錄只在造訪模式計入（照片模式只算照片）。'), 50);
    return null;
}

/** 刪除一筆手動紀錄（ref：計算時的編號） */
async function removeManual(ref) {
    const src = manualSource(), it = app.manualSnapshot[ref];
    if (!src || !it) return;
    src.items = src.items.filter(x => x.id !== it.id);
    src.updated = Date.now();
    manual.refresh(src);
    if (src.items.length) await saveSource(src);
    else { await removeSource(src.id); app.sources = app.sources.filter(s => s !== src); }
    renderSources();
    await compute({ show: false });   // 刪到沒有紀錄也留在成就頁（全部未解鎖）
}

/** 毫秒時間 → 本機日期時間（給使用者看的匯入時間） */
const ymdLocal = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * 手機照片：把這次讀到的照片追加進「手機照片」來源（座標與時間都相同的視為同一張，不重複加入）
 * @returns 新加入的筆數
 */
async function addPhone(src) {
    const now = Date.now();
    const old = app.sources.find(s => s.id === PHONE_ID);
    if (!old) {
        Object.assign(src, { id: PHONE_ID, name: '手機照片', added: now, updated: now });
        app.sources.push(src);
        await saveSource(src);
        renderSources();
        await compute();
        return { added: src.records.lat.length, dup: 0, total: src.records.lat.length };
    }
    const A = old.records, B = src.records;
    const seen = new Set();
    for (let i = 0; i < A.lat.length; i++) seen.add(`${A.lat[i]},${A.lng[i]},${A.time[i]}`);
    const lat = Array.from(A.lat), lng = Array.from(A.lng), time = Array.from(A.time);
    let dup = 0;
    for (let i = 0; i < B.lat.length; i++) {
        const key = `${B.lat[i]},${B.lng[i]},${B.time[i]}`;
        if (seen.has(key)) { dup++; continue; }
        seen.add(key);
        lat.push(B.lat[i]); lng.push(B.lng[i]); time.push(B.time[i]);
    }
    const added = lat.length - A.lat.length;
    if (!added) return { added: 0, dup, total: A.lat.length };
    // 統計：檔案數類的累加；時間範圍、台灣範圍內、沒有時間的張數依合併後重算
    const a = old.stats || {}, b = src.stats || {};
    const sum = k => (a[k] || 0) + (b[k] || 0);
    let from = null, to = null, noTime = 0, taiwan = 0;
    for (let i = 0; i < lat.length; i++) {
        const t = time[i];
        if (t > 0) { if (from === null || t < from) from = t; if (to === null || t > to) to = t; }
        if (Number.isNaN(t)) noTime++;
        if (lat[i] >= 10 && lat[i] <= 26.5 && lng[i] >= 114 && lng[i] <= 124.7) taiwan++;
    }
    old.stats = {
        files: sum('files'), photos: sum('photos'), noGps: sum('noGps'), failed: sum('failed'), videos: sum('videos'), other: sum('other'),
        duplicates: sum('duplicates') + dup, located: lat.length, noTime, taiwan, from, to,
    };
    old.records = { lat: Float64Array.from(lat), lng: Float64Array.from(lng), time: Float64Array.from(time), kind: new Uint8Array(lat.length) };
    old.updated = now;
    await saveSource(old);
    renderSources();
    await compute();
    return { added, dup, total: lat.length };
}

/** 照片資料夾：取得檔案清單 → 解析 EXIF → 加入來源；phone 為 true 時追加進「手機照片」 */
async function importFolder(getItems, name, { phone = false } = {}) {
    const ctrl = new AbortController();
    app.abort = ctrl;
    busy('尋找照片中…', { cancel: true });
    try {
        const got = await getItems(found => busy('尋找照片中…', { cancel: true, detail: `已找到 ${n0(found)} 個檔案` }), ctrl.signal);
        if (ctrl.signal.aborted) return;
        // getItems 可以回傳檔案陣列，或 { items, name }（拖曳時名稱要走訪後才知道）
        const items = Array.isArray(got) ? got : got.items;
        if (!Array.isArray(got) && got.name) name = got.name;
        if (!items.length) { busy(null); alert('這個資料夾裡沒有檔案。'); return; }
        const t0 = performance.now();
        const src = await exif.scanFiles(items, p => {
            const sec = (performance.now() - t0) / 1000;
            const eta = p.done > 50 ? Math.round(sec / p.done * (p.total - p.done)) : null;
            busy('讀取照片的位置與時間…', {
                cancel: true, ratio: p.total ? p.done / p.total : 0,
                detail: `${n0(p.done)} / ${n0(p.total)} 張・有座標 ${n0(p.located)} 張${eta !== null ? `・約剩 ${eta >= 60 ? Math.ceil(eta / 60) + ' 分' : eta + ' 秒'}` : ''}`,
            });
        }, ctrl.signal);
        src.name = name;
        busy(null);
        if (!src.records.lat.length) {
            alert(`讀完 ${n0(src.stats.photos)} 張照片，但都沒有 GPS 座標。\n（手機相機要開啟「位置」才會記錄拍攝地點）`);
            return;
        }
        if (phone) {
            const r = await addPhone(src);
            // 只說結果；略過原因等細節在「已匯入的資料」展開詳細資訊
            const msg = r.added ? `✅ 匯入成功：${n0(r.added)} 張照片的位置` : '這些照片之前都加入過了，沒有新增。';
            setTimeout(() => alert(msg), 50);
        } else await addSource(src);
    } catch (e) {
        busy(null);
        if (e.name === 'AbortError') return;
        console.error(e);
        alert('讀取失敗：' + e.message);
    } finally {
        app.abort = null;
    }
}

/** Google 時間軸：解析選到的 JSON 檔 → 加入來源 */
async function importTimeline(files, name) {
    files = gtl.jsonOnly(files);
    if (!files.length) { alert('沒有找到 .json 檔。請選 Google 時間軸匯出的檔案。'); return; }
    const ctrl = new AbortController();
    app.abort = ctrl;
    busy('讀取時間軸…', { cancel: true });
    try {
        const src = await gtl.parseTimeline(files, p => busy('讀取時間軸…', {
            cancel: true, ratio: p.total > 1 ? p.done / p.total : undefined,
            detail: p.total > 1 ? `${n0(p.done + 1)} / ${n0(p.total)} 個檔案：${p.name}` : p.name,
        }), ctrl.signal);
        src.name = name || (files.length === 1 ? files[0].name : `${files.length} 個時間軸檔案`);
        busy(null);
        await addSource(src);
    } catch (e) {
        busy(null);
        if (e.name === 'AbortError') return;
        console.error(e);
        alert('讀取時間軸失敗：' + e.message);
    } finally {
        app.abort = null;
    }
}

/**
 * 來源的說明：main 一行重點（點位、照片數），detail 是展開「詳細資訊」才看的（期間、略過原因、格式）
 */
function sourceSummary(s) {
    const st = s.stats || {};
    const range = st.from ? (st.to && st.to !== st.from ? `${ymd(st.from)} ～ ${ymd(st.to)}` : ymd(st.from)) : '時間不明';
    const upd = `最後更新 ${ymdLocal(updatedOf(s))}`;
    if (s.type === 'exif') {
        const skipped = [
            st.noGps ? `沒有 GPS ${n0(st.noGps)}` : '',
            st.duplicates ? `重複 ${n0(st.duplicates)}` : '',
            st.failed ? `無法讀取 ${n0(st.failed)}` : '',
            st.videos ? `影片 ${n0(st.videos)}` : '',
            st.other ? `其他檔案 ${n0(st.other)}` : '',
        ].filter(Boolean).join('、');
        return {
            main: `<b>${n0(s.records.lat.length)}</b> 張照片有位置`,
            detail: [`期間：${range}`, st.photos ? `讀取照片 ${n0(st.photos)} 張` : '',
                st.taiwan !== undefined && st.taiwan < s.records.lat.length ? `在台灣範圍內 ${n0(st.taiwan)} 張` : '',
                skipped ? `略過：${skipped}` : '', st.noTime ? `${n0(st.noTime)} 張沒有拍攝時間（仍算解鎖，不參與日期）` : '', upd],
        };
    }
    if (s.type === 'gtimeline') {
        const fmts = Object.keys(s.formats || {}).map(f => esc(gtl.formatLabel(f))).join('、');
        return {
            main: `<b>${n0(st.visits)}</b> 個停留點`,
            detail: [`期間：${range}`, `移動路徑 ${n0(st.path)} 點`, `在台灣範圍內 ${n0(st.taiwan)} 筆`,
                fmts ? `格式：${fmts}` : '', st.files > 1 ? `${n0(st.files)} 個檔案` : '',
                `略過：可信度太低的停留點 ${n0(st.lowProb)}、重複的路徑點 ${n0(st.pathDup)}${s.skipped?.length ? `、看不懂的檔案 ${n0(s.skipped.length)}` : ''}`, upd],
        };
    }
    if (s.type === 'manual') {
        const noDate = s.items.filter(it => !Number.isFinite(it.time)).length;
        return {
            main: `<b>${n0(s.items.length)}</b> 個手動加入的地點`,
            detail: [st.from ? `期間：${range}` : '都沒有日期', noDate && st.from ? `${n0(noDate)} 筆沒有日期` : '',
                '只在造訪模式計入；要刪除單筆請到該成就的明細', upd],
        };
    }
    return { main: `<b>${n0(s.records.lat.length)}</b> 個點位`, detail: [`期間：${range}`, upd] };
}

/** 已匯入的資料：每列一個來源，勾選後按「刪除所選」 */
function renderSources() {
    const box = $('imported');
    box.hidden = !app.sources.length;
    $('sourcesTitle').textContent = app.sources.length ? '再加入資料來源' : '選擇資料來源';
    renderSteps();
    $('sourceList').innerHTML = app.sources.map(s => `
        <li data-id="${esc(s.id)}">
            <input type="checkbox" aria-label="選取「${esc(s.name || '未命名')}」">
            <span class="icon">${sourceIcon(s)}</span>
            <div><div class="name">${esc(s.name || '未命名')}</div>${(sum => `<div class="meta">${sum.main}</div>
                <details class="src-more"><summary>詳細資訊</summary><div class="meta">${sum.detail.filter(Boolean).join('<br>')}</div></details>`)(sourceSummary(s))}</div>
        </li>`).join('');
    updateSelection();
}

/** 首頁三步驟：三步都可以按（沒有資料也能看成就、手動加入）；做過的步驟打勾、底色填滿（1 有資料、2 打開過成就、3 匯出或分享過卡片） */
function renderSteps() {
    const n = app.sources.length;
    let done = {};
    try { done = JSON.parse(localStorage.getItem(STEPS_KEY) || '{}'); } catch (e) { /* 讀不到就當沒做過 */ }
    const set = (step, cls, disabled, desc) => {
        const b = $('steps').querySelector(`[data-step="${step}"]`);
        b.classList.remove('is-done');
        if (cls) b.classList.add(cls);
        b.disabled = disabled;
        const d = b.querySelector('.app-step-desc');
        d.dataset.base ??= d.textContent;
        d.textContent = desc || d.dataset.base;
    };
    set('import', n ? 'is-done' : '', false, n ? `已匯入 ${n} 個來源，可以再加入` : '');
    set('view', done.view ? 'is-done' : '', false, '');
    set('share', done.share ? 'is-done' : '', false, '');
}

/** 記下某一步做過了（view：打開成就頁；share：成功匯出或分享卡片） */
function markStep(step) {
    try {
        const done = JSON.parse(localStorage.getItem(STEPS_KEY) || '{}');
        if (done[step]) return;
        done[step] = 1;
        localStorage.setItem(STEPS_KEY, JSON.stringify(done));
    } catch (e) { /* 存不了只影響打勾 */ }
    renderSteps();
}

/** 依勾選狀態更新：全選框、所選筆數、刪除按鈕、列的底色 */
function updateSelection() {
    const boxes = [...$('sourceList').querySelectorAll('input[type="checkbox"]')];
    const n = boxes.filter(b => b.checked).length;
    boxes.forEach(b => b.closest('li').classList.toggle('selected', b.checked));
    const all = $('selectAll');
    all.checked = n > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    $('sourceCount').textContent = n ? `已選 ${n} / ${boxes.length} 個` : `共 ${boxes.length} 個來源`;
    $('deleteBtn').disabled = !n;
    $('deleteBtn').textContent = n ? `🗑 刪除所選（${n}）` : '🗑 刪除所選';
    $('exportBtn').textContent = n ? `⬇ 匯出所選（${n}）` : '⬇ 匯出備份';
}

/** 勾選的來源 id */
const selectedIds = () => [...$('sourceList').querySelectorAll('li[data-id]')]
    .filter(li => li.querySelector('input').checked).map(li => li.dataset.id);

// ---------- 備份 ----------

/** 匯出備份：有勾選就匯出勾選的，否則全部。手機（觸控）有系統分享選單時用分享，其他直接下載 */
async function doExport() {
    const ids = selectedIds();
    const pick = ids.length ? app.sources.filter(s => ids.includes(s.id)) : app.sources;
    if (!pick.length) return;
    const total = pick.reduce((a, s) => a + s.records.lat.length, 0);
    if (!confirm(`匯出 ${pick.length} 個來源、共 ${n0(total)} 筆紀錄成備份檔（.json）。\n\n這個檔案含有你的位置紀錄（座標與時間），請自行保管，不要公開分享。`)) return;
    const { blob, filename, size } = exportBackup(pick, { includePath: app.includePath });
    const file = new File([blob], filename, { type: 'application/json' });
    if (TOUCH && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return; }
        catch (e) { if (e.name === 'AbortError') return; /* 分享失敗就改下載 */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    app.lastExport = { filename, size };   // 開發測試用
}

/**
 * 匯入備份。以來源 id 判斷是不是同一份資料，再比最後修改時間：
 *   這裡沒有 → 加入；備份比較新 → 問要不要取代；一樣或比較舊 → 略過
 * 手動紀錄例外：逐筆合併（docs/SPEC.md §15.2）
 */
async function importBackup(file) {
    busy('讀取備份檔…');
    try {
        const { sources, settings } = parseBackup(await file.text());
        busy(null);
        const added = [], replaced = [], same = [], older = [], declined = [];
        let manualAdded = 0, manualSrc = null;
        for (const s of sources) {
            // 手動紀錄：逐筆合併（以每筆的編號判斷；兩邊各自新增的都保留）
            if (s.type === 'manual') {
                const cur = manualSource();
                if (!cur) { s.id = manual.MANUAL_ID; manual.refresh(s); app.sources.push(s); manualSrc = s; manualAdded += s.items.length; }
                else { const k = manual.mergeItems(cur, s.items || []); if (k) { manualSrc = cur; manualAdded += k; } }
                continue;
            }
            const cur = app.sources.find(x => x.id === s.id);
            if (!cur) { app.sources.push(s); added.push(s); continue; }
            const tb = updatedOf(s), tc = updatedOf(cur);
            if (tb === tc) { same.push(s); continue; }
            if (tb < tc) { older.push(s); continue; }
            if (confirm(`「${cur.name}」在備份裡的版本比較新：\n・備份：${ymdLocal(tb)}\n・這裡：${ymdLocal(tc)}\n\n要用備份取代嗎？`)) {
                app.sources[app.sources.indexOf(cur)] = s;
                replaced.push(s);
            } else declined.push(s);
        }
        const changed = [...added, ...replaced];
        for (const s of changed) await saveSource(s);
        if (manualSrc) { await saveSource(manualSrc); changed.push(manualSrc); }
        if (typeof settings.includePath === 'boolean' && changed.some(s => s.type === 'gtimeline')) {
            app.includePath = settings.includePath;
            try { localStorage.setItem(PATH_KEY, app.includePath ? '1' : '0'); } catch (e) { /* 只影響這次 */ }
        }
        renderSources();
        // 只說結果（幾個點位），不列來源名稱與略過原因
        const points = [...added, ...replaced].reduce((a, s) => a + s.records.lat.length, 0) + manualAdded;
        const msg = points ? `✅ 匯入成功：${n0(points)} 個點位` : '沒有新增資料（這裡已經有相同或比較新的版本）。';
        if (changed.length) { await compute(); setTimeout(() => alert(msg), 50); }
        else alert(msg);
    } catch (e) {
        busy(null);
        alert('無法匯入備份：' + e.message);
    }
}

// ---------- 介面 ----------

/** 計算中遮罩；text 為 null 時關閉。opts：{ ratio, detail, cancel } */
function busy(text, opts = {}) {
    $('busy').hidden = !text;
    if (!text) return;
    $('busyText').textContent = text;
    $('busyBar').hidden = opts.ratio === undefined;
    if (opts.ratio !== undefined) $('busyBar').firstElementChild.style.width = (opts.ratio * 100).toFixed(1) + '%';
    $('busyDetail').textContent = opts.detail || '';
    $('busyCancel').hidden = !opts.cancel;
}

function showLanding() {
    $('explore').hidden = true;
    $('landing').hidden = false;
    renderSources();
    window.scrollTo(0, 0);
}

function showExplore() {
    const fromLanding = !$('landing').hidden;
    $('landing').hidden = true;
    $('explore').hidden = false;
    markStep('view');
    $('importBtn').hidden = false;
    $('reportBtn').hidden = false;
    if (fromLanding) window.scrollTo(0, 0);
}

// ---------- 成就報表（js/report.js） ----------

/** 報表標題列用：目前模式用到的來源的時間範圍、手動紀錄筆數 */
function reportMeta() {
    const srcs = app.sources.filter(s => app.mode !== 'photo' || PHOTO_TYPES.has(s.type));
    const from = srcs.map(s => s.stats?.from).filter(Number.isFinite);
    const to = srcs.map(s => s.stats?.to).filter(Number.isFinite);
    const m = app.mode !== 'photo' ? manualSource() : null;
    return { from: from.length ? Math.min(...from) : null, to: to.length ? Math.max(...to) : null, mode: app.mode, manual: m ? m.items.length : 0 };
}

async function openReport() {
    if (!app.explore || !app.explore.data()) await compute({ show: false });
    if (!app.explore || !app.explore.data()) return;
    if (!app.report) app.report = createReport({ getStats: () => app.explore.data(), loadMap, getMeta: reportMeta });
    app.report.open();
}

function renderModeSeg() {
    const seg = $('modeSeg');
    // 有照片才能選照片模式；只有時間軸時固定造訪模式
    seg.hidden = !hasPhotos();
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === app.mode));
}

/**
 * 側邊欄（成就目錄）：一直顯示、都可以點（沒有資料也能看成就）。
 * 還沒計算過（沒有匯入、剛打開網站）時進度顯示「—」，點了才下載圖資計算
 */
function renderToc() {
    const toc = $('toc');
    const ready = !!(app.explore && app.explore.data());
    const groups = ready ? app.explore.groups() : Object.keys(GROUP_LABEL).filter(g => !HIDDEN_GROUPS.has(g)).map(g => ({ g, label: GROUP_LABEL[g] }));
    const item = (href, label, attrs = '') => `<li><a href="${href}"${attrs}>${label}</a></li>`;
    toc.innerHTML = `
        <button type="button" class="app-btn primary toc-import" data-act="view">🏅 查看成就</button>
        <button type="button" class="app-btn toc-import" data-act="import">📂 匯入資料</button>
        <button type="button" class="app-btn toc-report" data-act="report">📤 分享成就</button>
        <a class="app-btn toc-report toc-help" href="help.html" target="_blank" rel="noopener">❓ 使用說明</a>
        ${ready && hasPathRecords() && app.mode !== 'photo' ? `<label class="app-check toc-path">
            <input type="checkbox" id="pathToggle"${app.includePath ? ' checked' : ''}> 包含移動路徑
            <button type="button" class="qtip" data-tip="打開後，移動時途經的點也算造訪過。探索率會變高，但可能會失真。" aria-label="說明：包含移動路徑">?</button></label>` : ''}
        <h2>總覽</h2>
        <ul>
            ${item('#ex-overview', '探索率', ' data-go="overview"')}
            ${item('#ex-mapcard', '迷霧小地圖')}
            ${item('#ex-yearly-card', '每年新解鎖')}
            ${item('#ex-detail-sec', '縣市・鄉鎮・村里明細', ' data-go="detail"')}
        </ul>
        <h2>成就</h2>
        <ul>
            ${item('#ex-badges-sec', '全部成就', ' data-go="badges"')}
            ${groups.map(x => `<li><a href="#ach-${x.g}" data-group="${x.g}" style="--g:${GROUP_COLOR[x.g] || ''}">
                <span>${esc(x.label)}</span><span class="n">${ready ? `${x.done} / ${x.total}${x.unit ? ' ' + x.unit : ''}` : '—'}</span>
                <span class="bar"><i style="width:${ready && x.total ? (x.done / x.total * 100).toFixed(1) : 0}%"></i></span></a></li>`).join('')}
        </ul>`;
    toc.hidden = false;
    $('tocBtn').hidden = false;
}

/** 還沒計算過（剛打開、沒有匯入）：頂列的模式、匯入、報表按鈕收起；側邊欄顯示未計算的目錄 */
function hideToc() {
    $('modeSeg').hidden = true;
    $('importBtn').hidden = true;
    $('reportBtn').hidden = true;
    openToc(false);
    renderToc();
}

function openToc(open) {
    $('toc').classList.toggle('open', open);
    $('tocBackdrop').classList.toggle('open', open);
    $('tocBackdrop').hidden = !open;
    $('tocBtn').setAttribute('aria-expanded', String(open));
}

/**
 * 「？」說明鈕：任何 [data-tip]（.qtip 說明鈕、觸控時的鄉鎮明細小方塊）點一下在旁邊顯示說明泡泡，再點一次、點別處、Esc 或捲動時關閉。
 * 手機沒有滑鼠移上，所以不用 title。
 */
function bindTips() {
    const pop = document.createElement('div');
    pop.className = 'qtip-pop';
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    document.body.appendChild(pop);
    let cur = null;
    const hide = () => {
        if (!cur) return;
        cur.setAttribute('aria-expanded', 'false');
        cur = null;
        pop.hidden = true;
    };
    document.addEventListener('click', e => {
        const b = e.target.closest('[data-tip]');
        if (!b) { if (!e.target.closest('.qtip-pop')) hide(); return; }
        e.preventDefault();   // 在 label 裡也不要切換勾選
        e.stopPropagation();
        if (cur === b) { hide(); return; }
        hide();
        cur = b;
        b.setAttribute('aria-expanded', 'true');
        pop.textContent = b.dataset.tip;
        pop.hidden = false;
        // 放在按鈕下方，超出畫面時往左、往上移
        const r = b.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
        const left = Math.max(12, Math.min(r.left + r.width / 2 - pw / 2, window.innerWidth - pw - 12));
        const top = r.bottom + 8 + ph > window.innerHeight - 8 ? Math.max(8, r.top - ph - 8) : r.bottom + 8;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && cur) { e.stopPropagation(); hide(); } }, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
}

function bindUi() {
    bindTips();
    $('modeSeg').addEventListener('click', e => {
        const m = e.target.closest('button')?.dataset.mode;
        if (!m || m === app.mode) return;
        app.mode = m;
        app.modeTouched = true;
        compute();
    });

    $('importBtn').addEventListener('click', showLanding);
    document.addEventListener('reportsaved', () => markStep('share'));
    $('reportBtn').addEventListener('click', openReport);
    $('viewBtn').addEventListener('click', () => compute());

    // 首頁三步驟：匯入 → 捲到資料來源；檢視成就；匯出卡片（先算好再開分享成就）
    $('steps').addEventListener('click', async e => {
        const step = e.target.closest('.app-step:not(:disabled)')?.dataset.step;
        if (step === 'import') {
            $('sourcesTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
            // 第一次按「匯入資料」：跳出時間軸圖文教學（之後從時間軸卡片的「看圖文教學」再打開）
            if (!guideSeen()) openGuide('timeline', () => $('timelineInput').click());
        }
        else if (step === 'view') compute();
        else if (step === 'share') {
            if (!app.explore || !app.explore.data()) await compute({ show: false });
            openReport();
        }
    });
    // 範例圖：另開分頁看完整圖，跟著目前的淺色／深色
    document.querySelector('.app-sample').addEventListener('click', e => {
        e.currentTarget.href = `img/sample-report-${document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}.webp`;
    });

    $('tocBtn').addEventListener('click', () => openToc(!$('toc').classList.contains('open')));
    $('tocBackdrop').addEventListener('click', () => openToc(false));
    $('toc').addEventListener('change', e => {
        if (e.target.id !== 'pathToggle') return;
        app.includePath = e.target.checked;
        try { localStorage.setItem(PATH_KEY, app.includePath ? '1' : '0'); } catch (err) { /* 存不了只影響這次 */ }
        compute({ show: false });
    });
    $('toc').addEventListener('click', async e => {
        if (e.target.closest('.toc-path')) return;
        if (e.target.closest('[data-act="import"]')) { openToc(false); showLanding(); return; }
        if (e.target.closest('[data-act="report"]')) { openToc(false); openReport(); return; }
        const view = e.target.closest('[data-act="view"]');
        const a = e.target.closest('a');
        if (!view && (!a || a.classList.contains('toc-help'))) return;   // 使用說明：照連結另開分頁
        openToc(false);
        // 還沒計算過（沒有匯入）：先算，再照原本的目標跳過去
        const lazy = !app.explore || !app.explore.data();
        if (lazy) {
            e.preventDefault();
            await compute({ show: false });
            if (!app.explore || !app.explore.data()) return;
        }
        if (view) { showExplore(); app.explore.showBadgeOverview(); return; }
        if ($('explore').hidden) showExplore();
        if (a.dataset.group) { e.preventDefault(); app.explore.jumpToGroup(a.dataset.group); return; }
        if (a.dataset.go === 'detail') $('ex-detail-sec').open = true;
        if (a.dataset.go === 'badges') $('ex-badges-sec').open = true;
        if (lazy) document.querySelector(a.getAttribute('href'))?.scrollIntoView();
    });

    // 已匯入的來源：點整列切換勾選、全選、刪除所選
    $('sourceList').addEventListener('click', e => {
        const li = e.target.closest('li[data-id]');
        if (!li || e.target.closest('.src-more')) return;   // 展開詳細資訊不切換勾選
        if (e.target.type !== 'checkbox') { const b = li.querySelector('input'); b.checked = !b.checked; }
        updateSelection();
    });
    $('selectAll').addEventListener('change', e => {
        $('sourceList').querySelectorAll('input[type="checkbox"]').forEach(b => { b.checked = e.target.checked; });
        updateSelection();
    });
    $('exportBtn').addEventListener('click', doExport);
    $('deleteBtn').addEventListener('click', async () => {
        const ids = selectedIds();
        const pick = app.sources.filter(s => ids.includes(s.id));
        if (!pick.length) return;
        const names = pick.map(s => `・${s.name || '未命名'}`).join('\n');
        if (!confirm(`刪除以下 ${pick.length} 個匯入的資料？\n${names}\n\n只會刪除這個瀏覽器裡的匯入結果，不會動到你的照片；刪除後需要重新匯入。`)) return;
        const all = pick.length === app.sources.length;
        if (all) await clearSources();
        else for (const s of pick) await removeSource(s.id);
        app.sources = app.sources.filter(s => !ids.includes(s.id));
        if (all) try { localStorage.removeItem(STEPS_KEY); } catch (err) { /* 只影響打勾 */ }   // 全部刪掉：三步驟從頭來
        renderSources();
        if (app.sources.length || app.explore?.data()) await compute({ show: false }); else hideToc();
    });

    // 取消匯入
    $('busyCancel').addEventListener('click', () => { if (app.abort) app.abort.abort(); busy(null); });

    // 照片資料夾：選擇（showDirectoryPicker；不支援時用 <input webkitdirectory>）或拖曳
    $('folderBtn').addEventListener('click', async () => {
        if (!exif.canPickFolder()) { $('folderInput').click(); return; }
        let dir;
        try { dir = await exif.pickFolder(); } catch (e) { alert('無法開啟資料夾：' + e.message); return; }
        if (dir) importFolder((onFound, signal) => exif.filesFromHandle(dir, onFound, signal), dir.name);
    });
    $('folderInput').addEventListener('change', e => {
        const files = e.target.files;
        if (!files || !files.length) return;
        const name = (files[0].webkitRelativePath || '').split('/')[0] || `${files.length} 個檔案`;
        const items = exif.filesFromInput(files);
        e.target.value = '';
        importFolder(async () => items, name);
    });
    const card = $('folderCard');
    card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('dragover'); });
    card.addEventListener('dragleave', () => card.classList.remove('dragover'));
    card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('dragover');
        const dt = e.dataTransfer;
        importFolder(onFound => exif.filesFromDrop(dt, onFound), '拖曳的資料夾');
    });

    // 手機照片（補點）：只在觸控裝置顯示；選取方式由系統選單決定（iOS 照片圖庫會把 HEIC 轉成 JPEG，選擇檔案拿到原檔）
    if (TOUCH) $('phoneCard').hidden = false;
    $('phoneBtn').addEventListener('click', () => $('phoneInput').click());
    $('phoneInput').addEventListener('change', e => {
        const files = e.target.files;
        if (!files || !files.length) return;
        const items = exif.filesFromInput(files);
        e.target.value = '';
        importFolder(async () => items, '手機照片', { phone: true });
    });

    // Google 時間軸：選檔（可多選）或拖曳檔案／資料夾
    $('timelineBtn').addEventListener('click', () => $('timelineInput').click());
    $('guideBtn').addEventListener('click', () => openGuide('timeline', () => $('timelineInput').click()));
    $('backupGuideBtn').addEventListener('click', () => openGuide('backup', () => $('backupInput').click()));
    $('timelineInput').addEventListener('change', e => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (files.length) importTimeline(files);
    });
    const tcard = $('timelineCard');
    tcard.addEventListener('dragover', e => { e.preventDefault(); tcard.classList.add('dragover'); });
    tcard.addEventListener('dragleave', () => tcard.classList.remove('dragover'));
    tcard.addEventListener('drop', async e => {
        e.preventDefault();
        tcard.classList.remove('dragover');
        const r = await exif.filesFromDrop(e.dataTransfer);   // 走訪拖進來的檔案或資料夾
        const files = await Promise.all(r.items.filter(it => /\.json$/i.test(it.path)).map(it => it.get()));
        importTimeline(files, r.items.length > 1 ? r.name : undefined);
    });

    // 匯入備份：選檔或拖曳
    $('backupBtn').addEventListener('click', () => $('backupInput').click());
    $('backupInput').addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) importBackup(f);
    });
    const bcard = $('backupCard');
    bcard.addEventListener('dragover', e => { e.preventDefault(); bcard.classList.add('dragover'); });
    bcard.addEventListener('dragleave', () => bcard.classList.remove('dragover'));
    bcard.addEventListener('drop', e => {
        e.preventDefault();
        bcard.classList.remove('dragover');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) importBackup(f);
    });

    // 開發用：載入原專案的測試資料（不存進 IndexedDB）
    if (new URLSearchParams(location.search).has('dev')) {
        $('devBox').hidden = false;
        window.__fogDev = { importFolder, importTimeline, importBackup, addSource, addPhone, app };   // 開發測試用（自動化測試匯入流程）
        $('devLegacy').addEventListener('click', async () => {
            busy('讀取測試資料…');
            try {
                const p = await fetch('test/legacy/photos.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
                await addSource({
                    type: 'exif', name: '原專案測試資料（開發用）', stats: { photos: p.lat.length },
                    records: {
                        lat: Float64Array.from(p.lat), lng: Float64Array.from(p.lng),
                        time: Float64Array.from(p.time, t => t === null ? NaN : t), kind: new Uint8Array(p.lat.length),
                    },
                }, { persist: false });
            } catch (e) {
                busy(null);
                alert('讀取測試資料失敗：' + e.message);
            }
        });
    }
}

// ---------- 啟動：有之前匯入的資料就直接計算 ----------

async function start() {
    bindUi();
    app.sources = await listSources();
    renderSources();
    if (app.sources.length) await compute();
    else hideToc();   // 還沒匯入：先不下載圖資，按「檢視成就」或目錄時才計算
}

start();
