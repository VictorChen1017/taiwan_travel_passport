// 頁面主程式：匯入資料 → 計算（Worker）→ 成就頁、成就目錄、計算模式切換
//
// 資料來源轉接器（第 4～6 階段）完成前，只有開發用的「原專案測試資料」（網址加 ?dev）

import { FogClient } from './core/client.js';
import { createExplore } from './explore.js';

const DATA = new URL('../data/', import.meta.url).href;
// 分類標題色（資料色，同 css/explore.css 的 .ex-badge-group-title.g-*）
const GROUP_COLOR = { milestone: '#ff4d1a', conquer: '#e0a526', pole: '#3fa7c2', island: '#14b8a6', landmark: '#ec4899', bspot: '#7c3aed', peak: '#0f766e', rail: '#0284c7', metro: '#d90023', lrt: '#7cbd52', nature: '#16a34a', travel: '#8b5cf6' };

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 狀態 ----------

const app = {
    fog: null,
    ready: null,       // 靜態資料載入（第一次計算時才開始）
    version: null,     // version.json 的檔案雜湊
    records: null,     // { lat, lng, time, kind }（kind：0 照片、1 停留點、2 移動途中）
    hasPhotos: false,
    hasTimeline: false,
    mode: 'visit',
    explore: null,
};

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

/** 依模式挑出紀錄（照片模式只用照片），複製一份交給 Worker（Worker 會接手陣列） */
function recordsFor(mode) {
    const R = app.records;
    if (mode !== 'photo') return { lat: R.lat.slice(), lng: R.lng.slice(), time: R.time.slice() };
    const idx = [];
    for (let i = 0; i < R.kind.length; i++) if (R.kind[i] === 0) idx.push(i);
    return {
        lat: Float64Array.from(idx, i => R.lat[i]),
        lng: Float64Array.from(idx, i => R.lng[i]),
        time: Float64Array.from(idx, i => R.time[i]),
    };
}

async function compute() {
    busy('準備中…');
    try {
        await ensureReady();
        busy('計算中…');
        const stats = await app.fog.compute(recordsFor(app.mode), app.mode);
        if (!app.explore) {
            app.explore = createExplore($('explore'), { loadMap, loadDetail: id => app.fog.detail(id) });
        }
        const fromLanding = !$('landing').hidden;
        $('landing').hidden = true;
        $('explore').hidden = false;
        $('importBtn').hidden = false;
        app.explore.setData(stats);
        if (fromLanding) window.scrollTo(0, 0);
        renderModeSeg();
        renderToc();
    } catch (e) {
        console.error(e);
        alert('計算失敗：' + e.message);
    } finally {
        busy(null);
    }
}

/** 放入新的紀錄並計算；sources：{ photos: bool, timeline: bool } */
function setRecords(records, sources) {
    app.records = records;
    app.hasPhotos = !!sources.photos;
    app.hasTimeline = !!sources.timeline;
    // 有時間軸就預設造訪模式；只有照片時用照片模式
    app.mode = app.hasTimeline || !app.hasPhotos ? 'visit' : 'photo';
    return compute();
}

// ---------- 介面 ----------

function busy(text) {
    $('busy').hidden = !text;
    if (text) $('busyText').textContent = text;
}

function renderModeSeg() {
    const seg = $('modeSeg');
    // 有照片才能選照片模式；只有時間軸時固定造訪模式
    seg.hidden = !app.hasPhotos;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === app.mode));
}

function renderToc() {
    const toc = $('toc');
    const groups = app.explore.groups();
    toc.innerHTML = `
        <button type="button" class="app-btn toc-import" data-act="import">📂 匯入資料</button>
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
        compute();
    });

    const showImport = () => {
        $('explore').hidden = true;
        $('landing').hidden = false;
        window.scrollTo(0, 0);
    };
    $('importBtn').addEventListener('click', showImport);

    $('privacyBtn').addEventListener('click', () => {
        // 回到說明區塊（成就頁時先切回匯入畫面）
        if ($('landing').hidden) { $('explore').hidden = true; $('landing').hidden = false; }
        const box = $('privacyBox');
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
    });

    $('tocBtn').addEventListener('click', () => openToc(!$('toc').classList.contains('open')));
    $('tocBackdrop').addEventListener('click', () => openToc(false));
    $('toc').addEventListener('click', e => {
        if (e.target.closest('[data-act="import"]')) { openToc(false); showImport(); return; }
        const a = e.target.closest('a');
        if (!a) return;
        openToc(false);
        if ($('explore').hidden) { $('landing').hidden = true; $('explore').hidden = false; }
        if (a.dataset.group) { e.preventDefault(); app.explore.jumpToGroup(a.dataset.group); return; }
        if (a.dataset.go === 'detail') $('ex-detail-sec').open = true;
        if (a.dataset.go === 'badges') $('ex-badges-sec').open = true;
    });

    // 開發用：載入原專案的測試資料（test/ 不會部署）
    if (new URLSearchParams(location.search).has('dev')) {
        $('devBox').hidden = false;
        $('devLegacy').addEventListener('click', async () => {
            busy('讀取測試資料…');
            try {
                const p = await fetch('test/legacy/photos.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
                await setRecords({
                    lat: Float64Array.from(p.lat), lng: Float64Array.from(p.lng),
                    time: Float64Array.from(p.time, t => t === null ? NaN : t),
                    kind: new Uint8Array(p.lat.length),   // 全部是照片
                }, { photos: true });
            } catch (e) {
                busy(null);
                alert('讀取測試資料失敗：' + e.message);
            }
        });
    }
}

bindUi();
