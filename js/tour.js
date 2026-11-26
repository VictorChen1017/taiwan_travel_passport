// 新手導覽：遮罩挖洞框住一個區塊＋說明泡泡，依序帶過三大步驟（分兩段，各自記住看過沒有）
//   landing  首頁：三步驟總覽 → 選資料來源（第一次打開、還沒匯入時自動開始）
//   explore  成就頁：迷霧小地圖 → 探索率 → 成就徽章 → 分享成就（匯入資料後第一次進成就頁時自動開始）
// 前進：泡泡的「下一步」，或直接點框住的地方（照常執行那個功能）：
//   act 'next'  點了照常執行，導覽接著下一步（例：點成就徽章標題＝展開）
//   act 'end'   點了照常執行，這段導覽結束（例：選資料來源會開選檔視窗、分享成就會開報表）
//   act 'modal' 點了照常執行（開放大地圖），導覽先收起，等地圖關掉（body 不再有 ex-modal-open）再接下一步
//   其他        點了照常執行，導覽不動
// 遮罩：蓋滿整頁的一層用 clip-path 挖洞（調暗＋擋住框外點擊），框框只畫一圈強調色外框（不擋點擊）
// 過場：遮罩、框框、泡泡都放在整頁座標上（跟內容一起原生捲動，捲動時不用 JS 重算）；換步驟時洞與框框用 CSS 補間滑過去，
//       泡泡先淡出、等捲動停了再在新位置淡入；開始、結束整層淡入淡出；系統設定「減少動態效果」時全部直接跳
// 重看：側邊欄「▶ 導覽」、首頁說明旁的連結（js/app.js 呼叫 startTour）

const SEEN_KEY = 'fog-tour-seen';     // localStorage：{ landing: 1, explore: 1 }

const $ = id => document.getElementById(id);

export const TOURS = {
    landing: [
        { el: () => $('steps'), title: '三個步驟',
          text: '① 匯入足跡資料 → ② 查看解鎖的成就 → ③ 把成就做成卡片分享。先從匯入資料開始。', act: 'end' },
        { el: () => document.querySelector('.app-sources'), title: '① 匯入資料',
          text: '選一種來源：<b>Google 時間軸</b>（最完整）、<b>照片資料夾</b>，或在別台裝置匯出的<b>備份檔</b>。'
              + '檔案只在你的瀏覽器裡計算，不會上傳。匯入完成後會接著帶你看成就。', act: 'end' },
    ],
    explore: [
        { el: () => $('ex-mapcard'), title: '② 迷霧地圖',
          text: '去過的地方會撥開迷霧。<b>點地圖</b>可以放大、縮放拖曳，點一個區域還能手動補上去過的地方。', act: 'modal' },
        { el: () => document.querySelector('#explore .ex-progress'), title: '探索率',
          text: '走過的縣市、鄉鎮、村里占全台的比例。上方可以切換<b>縣市／鄉鎮／村里</b>、<b>個數／面積</b>。' },
        { el: () => document.querySelector('#ex-badges-sec > summary'), title: '成就徽章',
          text: '百岳、車站、離島、景點……各類成就都在這裡。<b>點這一列</b>展開，再點任一徽章看明細與地圖。', act: 'next',
          // 展開後框住整個徽章區
          after: () => { const d = $('ex-badges-sec'); if (d && !d.open) d.open = true; } },
        { el: () => $('reportBtn'), title: '③ 分享成就',
          text: '把成就做成一張圖片（PNG）分享：只有地名與日期，不含座標；日期與常去的地點也可以隱藏。', act: 'end' },
    ],
};

let cur = null;   // { name, i, nodes, fixed, mo, ro, idle, token }

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 看過了沒（每段分開記） */
export function tourSeen(name) {
    try { return !!JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')[name]; } catch (e) { return true; }   // 存取失敗就不自動跳
}
function markSeen(name) {
    try {
        const s = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
        s[name] = 1;
        localStorage.setItem(SEEN_KEY, JSON.stringify(s));
    } catch (e) { /* 存不了下次會再跳一次 */ }
}

export const tourActive = () => !!cur;

/** 開始一段導覽；已在進行就先結束舊的 */
export function startTour(name) {
    if (!TOURS[name]) return;
    endTour();
    cur = { name, i: 0, nodes: build(), token: 0 };
    markSeen(name);   // 一開始就記：中途關掉、重新整理也不會再自動跳
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true });
    // 頁面長高（徽章展開、圖片載入）：遮罩跟著蓋滿、框框跟著目標
    cur.ro = new ResizeObserver(onResize);
    cur.ro.observe(document.body);
    show(0);
    requestAnimationFrame(() => cur && cur.nodes.root.classList.add('on'));   // 整層淡入
}

/** 結束：整層淡出後移除（狀態立刻清掉，馬上開新的一段也不會互相干擾） */
export function endTour() {
    if (!cur) return;
    const { root } = cur.nodes;
    cur.mo && cur.mo.disconnect();
    cur.ro && cur.ro.disconnect();
    clearTimeout(cur.idle);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll);
    cur = null;
    root.detach();   // 不再攔點擊
    if (reduced() || root.hidden) { root.remove(); return; }
    root.classList.remove('on');
    setTimeout(() => root.remove(), 220);
}

function build() {
    const root = document.createElement('div');
    root.className = 'tour';
    root.innerHTML = `
        <div class="tour-mask"></div>
        <div class="tour-hole"></div>
        <div class="tour-pop" role="dialog" aria-live="polite" aria-labelledby="tour-title">
            <div class="tour-count"></div>
            <div class="tour-title" id="tour-title"></div>
            <div class="tour-text"></div>
            <div class="tour-btns">
                <button type="button" class="tour-skip" data-act="skip">略過導覽</button>
                <span class="tour-gap"></span>
                <button type="button" class="app-btn" data-act="prev">上一步</button>
                <button type="button" class="app-btn primary" data-act="next">下一步</button>
            </div>
        </div>`;
    document.body.appendChild(root);
    root.querySelector('.tour-pop').addEventListener('click', e => {
        if (!cur) return;
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'skip') endTour();
        else if (act === 'prev') show(cur.i - 1);
        else if (act === 'next') next();
    });
    // 點框住的地方：讓原本的功能照常執行，之後依 act 決定導覽怎麼走（capture：比頁面上的處理先看到，但不攔下）
    const onTarget = e => {
        if (!cur || root.hidden) return;
        const step = TOURS[cur.name][cur.i];
        const el = step.el();
        if (!el || !el.contains(e.target)) return;
        if (step.act === 'end') setTimeout(endTour);
        else if (step.act === 'next') setTimeout(next);
        else if (step.act === 'modal') setTimeout(waitModal);
    };
    document.addEventListener('click', onTarget, true);
    root.detach = () => document.removeEventListener('click', onTarget, true);
    return {
        root, mask: root.querySelector('.tour-mask'), hole: root.querySelector('.tour-hole'),
        pop: root.querySelector('.tour-pop'), count: root.querySelector('.tour-count'),
        title: root.querySelector('.tour-title'), text: root.querySelector('.tour-text'),
        prev: root.querySelector('[data-act="prev"]'), next: root.querySelector('[data-act="next"]'),
    };
}

function next() {
    if (!cur) return;
    const step = TOURS[cur.name][cur.i];
    step.after && step.after();
    if (cur.i + 1 >= TOURS[cur.name].length) endTour();
    else show(cur.i + 1);
}

/** 放大地圖開著時收起導覽，關掉後接下一步 */
function waitModal() {
    if (!cur || !document.body.classList.contains('ex-modal-open')) return;
    cur.nodes.root.hidden = true;
    cur.mo = new MutationObserver(() => {
        if (document.body.classList.contains('ex-modal-open')) return;
        cur.mo.disconnect();
        cur.mo = null;
        cur.nodes.root.hidden = false;
        next();
    });
    cur.mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/**
 * 換到第 i 步：泡泡先淡出 → 捲到目標（洞與框框同時滑過去）→ 捲動停了泡泡才在新位置淡入。
 * 遮罩、框框、泡泡都放在整頁座標上，跟內容一起由瀏覽器原生捲動，捲動時 JS 不用重算
 */
function show(i) {
    const steps = TOURS[cur.name];
    // 找不到或看不到的目標（例如手機上收起來的按鈕）就跳過
    while (i < steps.length && !visible(steps[i].el())) i++;
    if (i >= steps.length) { endTour(); return; }
    const first = !cur.nodes.pop.classList.contains('show') && !cur.nodes.title.textContent;
    cur.i = i;
    const token = ++cur.token;
    const s = steps[i], n = cur.nodes, el = s.el();
    n.pop.classList.remove('show');
    // 頁首（固定在上方）裡的目標：捲動時要跟著重算，也不用捲
    const head = document.querySelector('.app-head');
    cur.fixed = !!(head && head.contains(el));
    let goal = null;   // 要捲到的位置（泡泡等捲到了才出現）
    if (!cur.fixed) {
        const de = document.documentElement;
        const r = el.getBoundingClientRect(), hh = head ? head.offsetHeight : 0, avail = de.clientHeight - hh;
        // 太高就對齊上緣（留空間給泡泡），否則置中
        const dy = r.height > avail * 0.6 ? r.top - hh - 12 : r.top - hh - (avail - r.height) / 2;
        goal = Math.round(Math.min(Math.max(0, scrollY + dy), de.scrollHeight - de.clientHeight));
        if (Math.abs(goal - scrollY) > 2) window.scrollTo({ top: goal, behavior: reduced() ? 'auto' : 'smooth' });
    }
    placeHole(first);
    // 泡泡淡出（約 0.15 秒）後換內容，等捲動停了再擺位置、淡入
    setTimeout(() => {
        if (!cur || cur.token !== token) return;
        n.count.textContent = `${i + 1} / ${steps.length}`;
        n.title.textContent = s.title;
        n.text.innerHTML = s.text;
        n.prev.hidden = i === 0;
        n.next.textContent = i === steps.length - 1 ? '完成' : '下一步';
        whenScrollIdle(() => {
            if (!cur || cur.token !== token) return;
            placeHole();
            placePop();
            n.pop.classList.add('show');
            n.next.focus({ preventScroll: true });
        }, goal);
    },first || reduced() ? 0 : 150);
}

const visible = el => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]');

/**
 * 捲動停下來再執行：約 0.12 秒沒有捲動事件，而且已經捲到目標位置 goal（平滑捲動有時晚一點才開始）；最多等 1.5 秒。
 * scrollend 事件舊版 Safari 沒有，所以自己判斷
 */
function whenScrollIdle(fn, goal) {
    let t = 0;
    const t0 = performance.now();
    const check = () => {
        if (goal != null && Math.abs(scrollY - goal) > 2 && performance.now() - t0 < 1500) { t = setTimeout(check, 120); return; }
        window.removeEventListener('scroll', bump);
        fn();
    };
    const bump = () => { clearTimeout(t); t = setTimeout(check, 120); };
    window.addEventListener('scroll', bump, { passive: true });
    bump();
}

function onScroll() {
    // 整頁座標的元素會跟著捲；只有頁首（固定）裡的目標要跟著重算
    if (cur && cur.fixed) { placeHole(); placePop(); }
}

function onResize() {
    if (!cur || cur.nodes.root.hidden) return;
    clearTimeout(cur.idle);
    cur.idle = setTimeout(() => { if (cur) { placeHole(true); placePop(); } }, 80);
}

function onKey(e) {
    if (!cur || cur.nodes.root.hidden) return;
    if (e.key === 'Escape') endTour();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft' && cur.i > 0) show(cur.i - 1);
}

/** 目標的整頁座標（含外留白） */
function targetBox() {
    const el = TOURS[cur.name][cur.i].el();
    if (!visible(el)) return null;
    const b = el.getBoundingClientRect(), PAD = 6;
    return { x0: b.left + scrollX - PAD, y0: b.top + scrollY - PAD, x1: b.right + scrollX + PAD, y1: b.bottom + scrollY + PAD };
}

/**
 * 遮罩與框框：遮罩是蓋滿整頁的一層，用 clip-path（evenodd）挖洞；點數固定，換步驟時 CSS 直接補間（只重繪不重排）。
 * 被挖掉的洞點得到底下的內容，其他地方的點擊被遮罩擋住。
 * instant：直接到位不補間（第一步、視窗大小改變；否則框框會從左上角 0×0 的初始位置滑過來）
 */
function placeHole(instant = false) {
    const n = cur.nodes;
    if (instant) {
        n.mask.style.transition = n.hole.style.transition = 'none';
        setHole();
        n.hole.offsetWidth;   // 先套用位置，再恢復補間
        n.mask.style.transition = n.hole.style.transition = '';
    } else setHole();
}

function setHole() {
    const b = targetBox();
    if (!b) return;
    const n = cur.nodes, de = document.documentElement;
    // 先縮回 0 再量整頁大小，免得導覽層自己撐大頁面
    n.root.style.width = n.root.style.height = '0px';
    // clientWidth／Height：不含捲軸（用 innerWidth 會多出捲軸寬，冒出橫向捲軸）
    const W = Math.max(de.scrollWidth, de.clientWidth), H = Math.max(de.scrollHeight, de.clientHeight);
    n.root.style.width = `${W}px`;
    n.root.style.height = `${H}px`;
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), x1 = Math.min(W, b.x1), y1 = Math.min(H, b.y1);
    const p = (x, y) => `${x.toFixed(1)}px ${y.toFixed(1)}px`;
    n.mask.style.clipPath = `polygon(evenodd, ${[p(0, 0), p(W, 0), p(W, H), p(0, H), p(0, 0),
        p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)].join(', ')})`;
    n.hole.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px)`;
    n.hole.style.width = `${Math.max(0, x1 - x0)}px`;
    n.hole.style.height = `${Math.max(0, y1 - y0)}px`;
}

/** 泡泡：依目前的畫面，目標下方放得下就放下方，否則上方，都不行就壓在畫面底部；換成整頁座標擺放 */
function placePop() {
    const b = targetBox();
    if (!b) return;
    const de = document.documentElement;
    const p = cur.nodes.pop, M = 12, W = de.clientWidth, H = de.clientHeight;
    const pw = Math.min(360, W - M * 2);
    p.style.width = `${pw}px`;
    const ph = p.offsetHeight;
    const y0 = b.y0 - scrollY, y1 = b.y1 - scrollY;   // 換回畫面座標
    let top;
    if (y1 + M + ph <= H - M) top = y1 + M;
    else if (y0 - M - ph >= M) top = y0 - M - ph;
    else top = H - M - ph;
    const left = Math.min(Math.max(M, (b.x0 + b.x1) / 2 - scrollX - pw / 2), W - M - pw);
    p.style.left = `${left + scrollX}px`;
    p.style.top = `${Math.max(M, top) + scrollY}px`;
}
