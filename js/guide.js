// 匯入時間軸教學：翻頁式圖文卡片（<dialog>）
//   第一次按首頁「匯入資料」時自動跳出（app.js 判斷 GUIDE_KEY），之後可從「Google 時間軸」卡片的「看教學」再打開
//   截圖在 img/guide/，由 tools/make_guide_images.py 從 test/guide_src/ 加工（模糊隱私區域、加編號標記）
//   翻頁：手機左右滑（scroll-snap）、上一頁／下一頁按鈕、點頁碼圓點、鍵盤左右鍵

export const GUIDE_KEY = 'fog-guide-timeline-seen';

const n = k => `<span class="gd-n">${k}</span>`;   // 文字裡的編號，對應截圖上的橘色圓點（整份教學連續 1–9）

// 目前只有 iPhone 截圖，Android 也先看這份（步驟大致相同）；有 Android 截圖後再分兩套
// img：img/guide/ 的檔名；8 張同尺寸（720×1472，見 tools/make_guide_images.py），圖上的編號也在那裡
const PAGES = [
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
    { img: 'tl-ios-8', title: '回到這裡選檔案', pick: true,
      text: `按下面的「<b>選擇檔案</b>」，到剛剛存的資料夾，點 ${n(9)} <b>Timeline.json</b>。` },
];

let dlg = null, onPick = null;

function pageHtml(p, i, total) {
    const media = `<img class="gd-img" src="img/guide/${p.img}.webp?v=20261125c" width="720" height="1472" alt="" loading="lazy" decoding="async">`;
    return `<section class="gd-page" aria-roledescription="slide" aria-label="${i + 1} / ${total}">
        <div class="gd-media">${media}</div>
        <div class="gd-body">
            <div class="gd-step">第 ${i + 1} / ${total} 頁</div>
            <h3>${p.title}</h3>
            <p>${p.text}</p>
            ${p.pick ? `<button type="button" class="app-btn primary gd-pick">選擇檔案</button>
                <p class="gd-note">在電腦上用：先把檔案從手機傳到電腦（AirDrop、雲端硬碟都可以）再選檔。</p>` : ''}
        </div>
    </section>`;
}

function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'gd';
    dlg.setAttribute('aria-labelledby', 'gdTitle');
    dlg.innerHTML = `
        <div class="gd-head">
            <h2 id="gdTitle">怎麼匯入 Google 時間軸？</h2>
            <button type="button" class="gd-close" aria-label="關閉">✕</button>
        </div>
        <p class="gd-intro">時間軸存在手機上，要先從 Google 地圖 App 匯出成一個檔案，再回到這裡選擇它，大約 1 分鐘（Android 的步驟大致相同）。只用照片的話可以直接關掉。</p>
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
        if (i >= PAGES.length - 1) dlg.close(); else go(i + 1);
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
    i = Math.max(0, Math.min(PAGES.length - 1, i));
    track.scrollTo({ left: i * track.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// 依目前頁更新圓點、按鈕
function sync() {
    const i = current(), last = PAGES.length - 1;
    dlg.querySelectorAll('.gd-dots button').forEach((d, k) => d.setAttribute('aria-selected', k === i));
    dlg.querySelector('.gd-prev').disabled = i === 0;
    dlg.querySelector('.gd-next').textContent = i === last ? '完成' : '下一步 ›';
}

function render() {
    const pages = PAGES;
    dlg.querySelector('.gd-track').innerHTML = pages.map((p, i) => pageHtml(p, i, pages.length)).join('');
    dlg.querySelector('.gd-dots').innerHTML = pages.map((_, i) =>
        `<button type="button" role="tab" data-i="${i}" aria-label="第 ${i + 1} 步"></button>`).join('');
    dlg.querySelector('.gd-track').scrollLeft = 0;
    sync();
}

/**
 * 打開教學
 * @param pick  最後一頁「選擇檔案」按下時要做的事（打開時間軸的選檔）
 */
export function openGuide(pick) {
    onPick = pick;
    if (!dlg) build();
    render();
    dlg.showModal();
    // 關著的 dialog 設 scrollLeft 無效，打開後才回到第一頁
    dlg.querySelector('.gd-track').scrollLeft = 0;
    sync();
    dlg.querySelector('.gd-track').focus({ preventScroll: true });
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) { /* 存不了下次會再跳出，不影響使用 */ }
}

export function guideSeen() {
    try { return localStorage.getItem(GUIDE_KEY) === '1'; } catch (e) { return true; }
}
