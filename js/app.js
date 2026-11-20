// 頁面主程式：匯入資料來源 → 存進 IndexedDB → 計算（Worker）→ 成就頁、成就目錄、計算模式切換
//
// 資料來源轉接器：照片資料夾（js/adapters/exif.js）；Google 時間軸、Google 相簿 Takeout 待第 5、6 階段
// 網址加 ?dev 會出現「載入原專案測試資料」（test/ 不會部署）

import { FogClient } from './core/client.js';
import { createExplore } from './explore.js';
import { listSources, saveSource, removeSource, clearSources, newId } from './store.js';
import * as exif from './adapters/exif.js';
import * as gtl from './adapters/gtimeline.js';

const PATH_KEY = 'fog-include-path';   // 「包含移動途中」記在 localStorage（只是顯示偏好）
const readPathPref = () => { try { return localStorage.getItem(PATH_KEY) === '1'; } catch (e) { return false; } };

const DATA = new URL('../data/', import.meta.url).href;
// 分類標題色（資料色，同 css/explore.css 的 .ex-badge-group-title.g-*）
const GROUP_COLOR = { milestone: '#ff4d1a', conquer: '#e0a526', pole: '#3fa7c2', island: '#14b8a6', landmark: '#ec4899', bspot: '#7c3aed', peak: '#0f766e', rail: '#0284c7', metro: '#d90023', lrt: '#7cbd52', nature: '#16a34a', travel: '#8b5cf6' };
const SOURCE_ICON = { exif: '📁', gphotos: '🖼️', gtimeline: '🗺️' };
const PHOTO_TYPES = new Set(['exif', 'gphotos']);

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

// ---------- 靜態資料與 Worker ----------

function ensureReady() {
    if (!app.ready) {
        app.fog = new FogClient(DATA);
        app.fog.onprogress = p => { if (p.step === 'load') busy(`下載圖資中…（${p.done} / ${p.total}）`); };
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

/** 合併各來源的紀錄；照片模式只用照片來源 */
/**
 * 合併各來源的紀錄。照片模式只用照片來源；「包含移動途中」關閉時排除 kind 2（時間軸的移動起訖與路徑點）
 * kind：0 照片、1 停留點、2 移動途中、3 手動紀錄
 */
function mergedRecords(mode) {
    const srcs = app.sources.filter(s => mode !== 'photo' || PHOTO_TYPES.has(s.type));
    const keep = k => app.includePath || k !== 2;
    let n = 0;
    for (const s of srcs) for (let i = 0; i < s.records.kind.length; i++) if (keep(s.records.kind[i])) n++;
    const lat = new Float64Array(n), lng = new Float64Array(n), time = new Float64Array(n);
    let o = 0;
    for (const s of srcs) {
        const R = s.records;
        for (let i = 0; i < R.kind.length; i++) {
            if (!keep(R.kind[i])) continue;
            lat[o] = R.lat[i]; lng[o] = R.lng[i]; time[o] = R.time[i]; o++;
        }
    }
    return { lat, lng, time };
}

/** 有沒有「移動途中」的紀錄（決定要不要顯示開關） */
const hasPathRecords = () => app.sources.some(s => s.type === 'gtimeline' && s.records.kind.some(k => k === 2));

/** 依來源決定預設模式：有時間軸用造訪模式，只有照片用照片模式 */
function defaultMode() {
    if (!hasPhotos()) return 'visit';
    if (app.modeTouched) return app.mode;
    return hasTimeline() ? 'visit' : 'photo';
}

async function compute({ show = true } = {}) {
    if (!app.sources.length) { showLanding(); return; }
    app.mode = defaultMode();
    busy('準備中…');
    try {
        await ensureReady();
        busy('計算中…');
        const stats = await app.fog.compute(mergedRecords(app.mode), app.mode);
        if (!app.explore) {
            app.explore = createExplore($('explore'), { loadMap, loadDetail: id => app.fog.detail(id) });
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

async function addSource(src, { persist = true } = {}) {
    src.id = newId();
    src.added = Date.now();
    app.sources.push(src);
    if (persist) await saveSource(src);
    renderSources();
    await compute();
}

/** 照片資料夾：取得檔案清單 → 解析 EXIF → 加入來源 */
async function importFolder(getItems, name) {
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
        await addSource(src);
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

function sourceSummary(s) {
    const st = s.stats || {};
    const range = st.from ? (st.to && st.to !== st.from ? `${ymd(st.from)} ～ ${ymd(st.to)}` : ymd(st.from)) : '時間不明';
    if (s.type === 'exif') {
        const skipped = [
            st.noGps ? `沒有 GPS ${n0(st.noGps)}` : '',
            st.duplicates ? `重複 ${n0(st.duplicates)}` : '',
            st.failed ? `無法讀取 ${n0(st.failed)}` : '',
            st.videos ? `影片 ${n0(st.videos)}` : '',
            st.other ? `其他檔案 ${n0(st.other)}` : '',
        ].filter(Boolean).join('、');
        const tw = st.taiwan !== undefined && st.taiwan < s.records.lat.length ? `，台灣範圍內 ${n0(st.taiwan)} 筆` : '';
        return `<b>${n0(s.records.lat.length)}</b> 筆有座標（照片 ${n0(st.photos)} 張${tw}）・${range}` +
            (skipped ? `<br>略過：${skipped}` : '') + (st.noTime ? `<br>其中 ${n0(st.noTime)} 張沒有拍攝時間（仍算解鎖，不參與日期）` : '');
    }
    if (s.type === 'gtimeline') {
        const fmts = Object.keys(s.formats || {}).map(gtl.formatLabel).join('、');
        return `停留點 <b>${n0(st.visits)}</b>、移動途中 ${n0(st.path)} 點（台灣範圍內 ${n0(st.taiwan)} 筆）・${range}` +
            `<br>${fmts ? fmts + '・' : ''}${st.files > 1 ? `${n0(st.files)} 個檔案・` : ''}略過：可信度太低的停留點 ${n0(st.lowProb)}、重複的路徑點 ${n0(st.pathDup)}` +
            (s.skipped?.length ? `、看不懂的檔案 ${n0(s.skipped.length)}` : '');
    }
    return `<b>${n0(s.records.lat.length)}</b> 筆足跡・${range}`;
}

/** 已匯入的資料：每列一個來源，勾選後按「刪除所選」 */
function renderSources() {
    const box = $('imported');
    box.hidden = !app.sources.length;
    $('sourcesTitle').textContent = app.sources.length ? '再加入資料來源' : '選擇資料來源';
    $('sourceList').innerHTML = app.sources.map(s => `
        <li data-id="${esc(s.id)}">
            <input type="checkbox" aria-label="選取「${esc(s.name || '未命名')}」">
            <span class="icon">${SOURCE_ICON[s.type] || '📄'}</span>
            <div><div class="name">${esc(s.name || '未命名')}</div><div class="meta">${sourceSummary(s)}</div></div>
        </li>`).join('');
    updateSelection();
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
    $('importBtn').hidden = false;
    if (fromLanding) window.scrollTo(0, 0);
}

function renderModeSeg() {
    const seg = $('modeSeg');
    // 有照片才能選照片模式；只有時間軸時固定造訪模式
    seg.hidden = !hasPhotos();
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === app.mode));
}

function renderToc() {
    const toc = $('toc');
    const groups = app.explore.groups();
    toc.innerHTML = `
        <button type="button" class="app-btn toc-import" data-act="import">📂 匯入資料</button>
        ${hasPathRecords() && app.mode !== 'photo' ? `<label class="app-check toc-path" title="時間軸裡移動時經過的點（例如坐車經過的鄉鎮）也算解鎖">
            <input type="checkbox" id="pathToggle"${app.includePath ? ' checked' : ''}> 包含移動途中</label>` : ''}
        <h2>總覽</h2>
        <ul>
            <li><a href="#ex-overview" data-go="overview">探索率</a></li>
            <li><a href="#ex-mapcard">迷霧小地圖</a></li>
            <li><a href="#ex-yearly-card">每年新解鎖</a></li>
            <li><a href="#ex-detail-sec" data-go="detail">縣市・鄉鎮・村里明細</a></li>
        </ul>
        <h2>成就</h2>
        <ul>
            <li><a href="#ex-badges-sec" data-go="badges">全部成就</a></li>
            ${groups.map(x => `<li><a href="#ach-${x.g}" data-group="${x.g}" style="--g:${GROUP_COLOR[x.g] || ''}">
                <span>${esc(x.label)}</span><span class="n">${x.done} / ${x.total}${x.unit ? ' ' + x.unit : ''}</span>
                <span class="bar"><i style="width:${x.total ? (x.done / x.total * 100).toFixed(1) : 0}%"></i></span></a></li>`).join('')}
        </ul>`;
    toc.hidden = false;
    $('tocBtn').hidden = false;
}

function hideToc() {
    $('toc').hidden = true;
    $('tocBtn').hidden = true;
    $('modeSeg').hidden = true;
    $('importBtn').hidden = true;
}

function openToc(open) {
    $('toc').classList.toggle('open', open);
    $('tocBackdrop').classList.toggle('open', open);
    $('tocBackdrop').hidden = !open;
    $('tocBtn').setAttribute('aria-expanded', String(open));
}

function bindUi() {
    $('modeSeg').addEventListener('click', e => {
        const m = e.target.closest('button')?.dataset.mode;
        if (!m || m === app.mode) return;
        app.mode = m;
        app.modeTouched = true;
        compute();
    });

    $('importBtn').addEventListener('click', showLanding);
    $('viewBtn').addEventListener('click', () => compute());

    $('privacyBtn').addEventListener('click', () => {
        if ($('landing').hidden) showLanding();
        const box = $('privacyBox');
        box.open = true;   // 頂列的 🔒 會展開說明
        box.scrollIntoView({ block: 'start' });
        box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
    });

    $('tocBtn').addEventListener('click', () => openToc(!$('toc').classList.contains('open')));
    $('tocBackdrop').addEventListener('click', () => openToc(false));
    $('toc').addEventListener('change', e => {
        if (e.target.id !== 'pathToggle') return;
        app.includePath = e.target.checked;
        try { localStorage.setItem(PATH_KEY, app.includePath ? '1' : '0'); } catch (err) { /* 存不了只影響這次 */ }
        compute({ show: false });
    });
    $('toc').addEventListener('click', e => {
        if (e.target.closest('.toc-path')) return;
        if (e.target.closest('[data-act="import"]')) { openToc(false); showLanding(); return; }
        const a = e.target.closest('a');
        if (!a) return;
        openToc(false);
        if ($('explore').hidden) showExplore();
        if (a.dataset.group) { e.preventDefault(); app.explore.jumpToGroup(a.dataset.group); return; }
        if (a.dataset.go === 'detail') $('ex-detail-sec').open = true;
        if (a.dataset.go === 'badges') $('ex-badges-sec').open = true;
    });

    // 已匯入的來源：點整列切換勾選、全選、刪除所選
    $('sourceList').addEventListener('click', e => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        if (e.target.type !== 'checkbox') { const b = li.querySelector('input'); b.checked = !b.checked; }
        updateSelection();
    });
    $('selectAll').addEventListener('change', e => {
        $('sourceList').querySelectorAll('input[type="checkbox"]').forEach(b => { b.checked = e.target.checked; });
        updateSelection();
    });
    $('deleteBtn').addEventListener('click', async () => {
        const ids = [...$('sourceList').querySelectorAll('li[data-id]')].filter(li => li.querySelector('input').checked).map(li => li.dataset.id);
        const pick = app.sources.filter(s => ids.includes(s.id));
        if (!pick.length) return;
        const names = pick.map(s => `・${s.name || '未命名'}`).join('\n');
        if (!confirm(`刪除以下 ${pick.length} 個匯入的資料？\n${names}\n\n只會刪除這個瀏覽器裡的匯入結果，不會動到你的照片；刪除後需要重新匯入。`)) return;
        if (pick.length === app.sources.length) await clearSources();
        else for (const s of pick) await removeSource(s.id);
        app.sources = app.sources.filter(s => !ids.includes(s.id));
        renderSources();
        if (app.sources.length) await compute({ show: false }); else hideToc();
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

    // Google 時間軸：選檔（可多選）或拖曳檔案／資料夾
    $('timelineBtn').addEventListener('click', () => $('timelineInput').click());
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

    // 開發用：載入原專案的測試資料（不存進 IndexedDB）
    if (new URLSearchParams(location.search).has('dev')) {
        $('devBox').hidden = false;
        window.__fogDev = { importFolder, importTimeline, addSource, app };   // 開發測試用（自動化測試匯入流程）
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
}

start();
