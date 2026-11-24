// 圖文教學：翻頁式卡片（<dialog>），共用一個視窗，目前兩份：
//   timeline  匯入 Google 時間軸：第一次按首頁「匯入資料」時自動跳出（app.js 判斷 guideSeen），之後從時間軸卡片再打開
//   backup    足跡資料的匯出與匯入（跨裝置）：從「匯入備份」卡片打開
//   截圖在 img/guide/，由 tools/make_guide_images.py 從 test/ 的原圖加工（遮蓋個資、加編號標記）
//   翻頁：手機左右滑（scroll-snap）、上一頁／下一頁按鈕、點頁碼圓點、鍵盤左右鍵

export const GUIDE_KEY = 'fog-guide-timeline-seen';

const n = k => `<span class="gd-n">${k}</span>`;   // 文字裡的編號，對應截圖上的橘色圓點（每份教學內連續）

// 目前只有 iPhone 截圖，Android 也先看這份（步驟大致相同）；有 Android 截圖後再分兩套
// img：img/guide/ 的檔名；全部同尺寸（720×1472，見 tools/make_guide_images.py），圖上的編號也在那裡
const GUIDES = {
    timeline: {
        title: '怎麼匯入 Google 時間軸？',
        intro: '從 Google 地圖匯出時間軸檔案，大約 1 分鐘。本專案不會儲存任何資料。',
        pick: '選擇檔案',
        note: '在電腦上用：先把檔案從手機傳到電腦（AirDrop、雲端硬碟都可以）再選檔。',
        help: ['help.html#timeline', '更多說明（舊版 Google Takeout、計算方式）→'],
        pages: [
            { img: 'tl-ios-1', title: '打開 Google 地圖 App',
              text: `點右上角的 ${n(1)} <b>大頭貼</b>。` },
            { img: 'tl-ios-2', title: '你的時間軸',
              text: `點 ${n(2)}「<b>你的時間軸</b>」。` },
            { img: 'tl-ios-3', title: '打開選單',
              text: `點右上角的 ${n(3)}「<b>⋯</b>」。` },
            { img: 'tl-ios-4', title: '位置和隱私權設定',
              text: `點 ${n(4)}「<b>位置和隱私權設定</b>」。` },
            { img: 'tl-ios-5', title: '匯出時間軸資料',
              text: `往下找到 ${n(5)}「<b>匯出時間軸資料</b>」，點進去。` },
            { img: 'tl-ios-6', title: '儲存到檔案',
              text: `跳出分享選單後，點 ${n(6)}「<b>儲存到檔案</b>」。` },
            { img: 'tl-ios-7', title: '選資料夾，按儲存',
              text: `${n(7)} 選一個你找得到的資料夾（點資料夾名稱可以換，例如「我的 iPhone」），再按 ${n(8)}「<b>儲存</b>」。檔名不用改。` },
            { img: 'tl-ios-8', title: '回到這裡選檔案',
              text: `按下面的「<b>選擇檔案</b>」，到剛剛存的資料夾，點 ${n(9)} <b>Timeline.json</b>。` },
        ],
    },
    backup: {
        title: '足跡資料的匯出與匯入',
        intro: '跨設備累積足跡時使用：在原本的裝置匯出備份檔，到另一台裝置匯入。本專案不會儲存任何資料。',
        pick: '選擇備份檔',
        note: '在電腦上匯出時，備份檔會直接下載到「下載」資料夾。備份檔含有你的位置紀錄，請自行保管、不要公開分享。',
        help: ['help.html#backup', '更多說明（合併規則、手動紀錄）→'],
        pages: [
            { img: 'bk-ios-1', title: '在原本的裝置匯出',
              text: `在首頁「已匯入的資料」，點 ${n(1)}「<b>匯出備份</b>」。想只匯出部分資料，可以先勾選。` },
            { img: 'bk-ios-2', title: '確認匯出',
              text: `看完提醒後按 ${n(2)}「<b>好</b>」。` },
            { img: 'bk-ios-3', title: '存起來或傳過去',
              text: `點 ${n(3)}「<b>儲存到檔案</b>」存在手機；要給另一台裝置，也可以用 AirDrop、LINE、雲端硬碟傳給自己。` },
            { img: 'bk-ios-4', title: '在另一台裝置匯入',
              text: `打開本網站的「<b>匯入備份</b>」，按下面的「<b>選擇備份檔</b>」，點 ${n(4)} <b>台灣旅遊護照備份-日期.json</b>。已經有的同一份資料不會重複加入。` },
        ],
    },
};

let dlg = null, guide = GUIDES.timeline, onPick = null;

// 最後一頁放「選擇檔案」按鈕、補充說明、說明頁連結
function pageHtml(p, i, total) {
    const media = `<img class="gd-img" src="img/guide/${p.img}.webp?v=20261125d" width="720" height="1472" alt="" loading="lazy" decoding="async">`;
    const last = i === total - 1;
    return `<section class="gd-page" aria-roledescription="slide" aria-label="${i + 1} / ${total}">
        <div class="gd-media">${media}</div>
        <div class="gd-body">
            <div class="gd-step">第 ${i + 1} / ${total} 頁</div>
            <h3>${p.title}</h3>
            <p>${p.text}</p>
            ${last ? `<button type="button" class="app-btn primary gd-pick">${guide.pick}</button>
                <p class="gd-note">${guide.note}</p>
                <p class="gd-note"><a href="${guide.help[0]}" target="_blank" rel="noopener">${guide.help[1]}</a></p>` : ''}
        </div>
    </section>`;
}

function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'gd';
    dlg.setAttribute('aria-labelledby', 'gdTitle');
    dlg.innerHTML = `
        <div class="gd-head">
            <h2 id="gdTitle"></h2>
            <button type="button" class="gd-close" aria-label="關閉">✕</button>
        </div>
        <p class="gd-intro"></p>
        <div class="gd-track" tabindex="0" aria-live="polite"></div>
        <div class="gd-nav">
            <button type="button" class="app-btn gd-prev">‹ 上一步</button>
            <div class="gd-dots" role="tablist"></div>
            <button type="button" class="app-btn primary gd-next">下一步 ›</button>
        </div>`;
    document.body.appendChild(dlg);

    const track = dlg.querySelector('.gd-track');
    dlg.querySelector('.gd-close').addEventListener('click', () => dlg.close());
    // 點遮罩（dialog 本身，不是內容）關閉
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.querySelector('.gd-prev').addEventListener('click', () => go(current() - 1));
    dlg.querySelector('.gd-next').addEventListener('click', () => {
        const i = current();
        if (i >= guide.pages.length - 1) dlg.close(); else go(i + 1);
    });
    dlg.querySelector('.gd-dots').addEventListener('click', e => {
        const d = e.target.closest('[data-i]');
        if (d) go(+d.dataset.i);
    });
    track.addEventListener('click', e => {
        if (!e.target.closest('.gd-pick')) return;
        dlg.close();
        if (onPick) onPick();
    });
    let t = 0;
    track.addEventListener('scroll', () => { cancelAnimationFrame(t); t = requestAnimationFrame(sync); }, { passive: true });
    dlg.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') { go(current() + 1); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { go(current() - 1); e.preventDefault(); }
    });
}

const current = () => {
    const track = dlg.querySelector('.gd-track');
    return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
};

function go(i) {
    const track = dlg.querySelector('.gd-track');
    i = Math.max(0, Math.min(guide.pages.length - 1, i));
    track.scrollTo({ left: i * track.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// 依目前頁更新圓點、按鈕
function sync() {
    const i = current(), last = guide.pages.length - 1;
    dlg.querySelectorAll('.gd-dots button').forEach((d, k) => d.setAttribute('aria-selected', k === i));
    dlg.querySelector('.gd-prev').disabled = i === 0;
    dlg.querySelector('.gd-next').textContent = i === last ? '完成' : '下一步 ›';
}

function render() {
    const pages = guide.pages;
    dlg.querySelector('#gdTitle').textContent = guide.title;
    dlg.querySelector('.gd-intro').textContent = guide.intro;
    dlg.querySelector('.gd-track').innerHTML = pages.map((p, i) => pageHtml(p, i, pages.length)).join('');
    dlg.querySelector('.gd-dots').innerHTML = pages.map((_, i) =>
        `<button type="button" role="tab" data-i="${i}" aria-label="第 ${i + 1} 步"></button>`).join('');
    dlg.querySelector('.gd-track').scrollLeft = 0;
    sync();
}

/**
 * 打開教學
 * @param name  'timeline' | 'backup'
 * @param pick  最後一頁「選擇檔案」按下時要做的事（打開對應的選檔）
 */
export function openGuide(name, pick) {
    guide = GUIDES[name];
    onPick = pick;
    if (!dlg) build();
    render();
    dlg.showModal();
    // 關著的 dialog 設 scrollLeft 無效，打開後才回到第一頁
    dlg.querySelector('.gd-track').scrollLeft = 0;
    sync();
    dlg.querySelector('.gd-track').focus({ preventScroll: true });
    if (name === 'timeline') {
        try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) { /* 存不了下次會再跳出，不影響使用 */ }
    }
}

/** 時間軸教學看過沒（第一次按「匯入資料」才自動跳出） */
export function guideSeen() {
    try { return localStorage.getItem(GUIDE_KEY) === '1'; } catch (e) { return true; }
}
