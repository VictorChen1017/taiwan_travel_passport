// 地圖圖磚設定（成就明細的小地圖）：要換供應商只改這裡，並同步更新 help.html 的「對外連線」與頁尾的圖磚標示
//
// 目前：OpenStreetMap 官方圖磚（2026-11-21 決定）
// - 只在打開成就明細時載入，用量小；依 OSM 圖磚使用政策（https://operations.osmfoundation.org/policies/tiles/）：
//   標示「© OpenStreetMap contributors」並連到版權頁、瀏覽器會送 Referer、不預先下載或離線快取
// - 政策沒有明確的「大量使用」門檻；使用者變多時改用其他供應商，候選見 docs/SPEC.md §11
//   （OpenFreeMap：不用 key、無用量限制，但需 MapLibre GL；CARTO：非商業每月 500 萬次，需 API key）
// - className 'tiles-osm'：深色模式由 CSS 反相成深色地圖（css/explore.css）

export const TILE = {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        className: 'tiles-osm',
        referrerPolicy: 'strict-origin-when-cross-origin',   // 只送網站來源（不含路徑與查詢字串）
    },
    name: 'OpenStreetMap',
    policy: 'https://operations.osmfoundation.org/policies/tiles/',
};
