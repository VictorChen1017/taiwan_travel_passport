// 主題切換（淺色／深色）；改寫自原專案 common/theme.js（拿掉 Plotly 相關）
//
// - 放在 <head>，在 CSS 之後同步載入：畫面出現前就套用，避免先閃白
// - 使用者選過就記在 localStorage（fog-theme）；沒選過就跟作業系統的深色設定
// - 切換時在 document 發出 themechange 事件（detail = 'light' | 'dark'），JS 繪圖（SVG、Leaflet 標記）監聽後重繪
// - photoTheme.color('--c-text') 取目前主題的顏色值（顏色定義在 css/theme.css）
// - 頁面上的 [data-theme-toggle] 按鈕以事件委派處理

(function () {
    'use strict';

    const KEY = 'fog-theme';
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const root = document.documentElement;

    function stored() {
        try { return localStorage.getItem(KEY); } catch (e) { return null; }
    }

    function apply(theme) {
        root.dataset.theme = theme;
    }

    function emit() {
        document.dispatchEvent(new CustomEvent('themechange', { detail: root.dataset.theme }));
    }

    apply(stored() || (media && media.matches ? 'dark' : 'light'));

    window.photoTheme = {
        get: () => root.dataset.theme,
        set(theme) {
            apply(theme);
            try { localStorage.setItem(KEY, theme); } catch (e) { /* 無痕模式等情況存不了，只影響這次 */ }
            emit();
        },
        toggle() {
            this.set(this.get() === 'dark' ? 'light' : 'dark');
        },
        /** 取 CSS 變數目前的值，例如 photoTheme.color('--c-text') */
        color(name) {
            return getComputedStyle(root).getPropertyValue(name).trim();
        },
    };

    // 使用者沒選過時，作業系統切換深淺色也跟著換
    if (media && media.addEventListener) {
        media.addEventListener('change', e => {
            if (stored()) return;
            apply(e.matches ? 'dark' : 'light');
            emit();
        });
    }

    document.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('[data-theme-toggle]')) window.photoTheme.toggle();
    });
})();
