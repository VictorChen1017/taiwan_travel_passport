<?php
// 迷霧探索的成就定義（tools/export_static.php 讀取，匯出成 data/ 的靜態 JSON）
// 本檔 2026-11-20 複製自 photo_monitor_ver202611/config/，之後以本檔為準（改完重新執行 tools/export_static.php）
//
// 要新增成就：在對應的清單加一筆即可，不必改計算程式。
// - 里程碑門檻：數字陣列；最後一級「全制霸」由程式依實際總數自動加上
// - 地點類（極點、離島、景點、保護區）：每筆一個徽章，判定方式三選一
//     points + radius   座標（[緯度, 經度]，可多個，任一處符合即可）與半徑（公尺）內有照片
//     town / village    照片落在這些鄉鎮或村里代碼內（匯入時 ST_Intersects 判定）
//                       numbered：只算有編號的村里（排除代碼含 S、I、P 的無人小島或海域）
//                       exclude：排除這些村里代碼
//     area              照片落在 protected_areas 表的這些範圍內（bash sql/import_areas.sh 匯入）
//   id 一經使用就不要改（之後若要記錄達成狀態會用到）
// - 等級 tier：bronze 銅、silver 銀、gold 金、platinum 白金、legend 傳奇
// - 座標來源：Wikidata（P625）與 OpenStreetMap，2026-11 查證
// - 景點與島嶼重疊時以島嶼為主（島上的景點不另列）；大範圍景點以遊客中心為準

return [

    // ------------------------------------------------------------------
    // 里程碑門檻（每一項：[數量, 等級]）
    // ------------------------------------------------------------------
    'milestones' => [
        'county' => [[10, 'silver']],                                   // 全部縣市自動加上（傳奇）
        'town' => [[50, 'bronze'], [100, 'bronze'], [200, 'silver'], [250, 'gold'], [300, 'gold'], [350, 'platinum']],
        'village' => [[100, 'bronze'], [500, 'bronze'], [1000, 'silver'], [2000, 'silver'], [3000, 'gold'], [4000, 'gold'],
                      [5000, 'platinum'], [6000, 'platinum'], [7000, 'legend']],
    ],

    // ------------------------------------------------------------------
    // 旅行
    // ------------------------------------------------------------------
    'travel' => [
        'road_trip_counties' => 3,      // 單日跨幾個縣市
        'multi_town_towns' => 5,        // 單日走過幾個鄉鎮
        'annual_villages' => 100,       // 單年新解鎖幾個村里
        'regular_photos' => 1000,       // 同一村里累積幾張
    ],

    // ------------------------------------------------------------------
    // 極點：本島四極（四極全制霸只看這四個）＋特殊地理點
    // ------------------------------------------------------------------
    'poles' => [
        ['id' => 'pole_n', 'name' => '極北・富貴角', 'desc' => '新北市石門區富貴角燈塔', 'section' => '本島四極', 'tier' => 'silver',
         'icon' => 'lighthouse', 'points' => [[25.2977, 121.5361]], 'radius' => 2000, 'four' => true],
        ['id' => 'pole_s', 'name' => '極南・鵝鑾鼻', 'desc' => '屏東縣恆春鎮鵝鑾鼻燈塔', 'section' => '本島四極', 'tier' => 'silver',
         'icon' => 'lighthouse', 'points' => [[21.9020, 120.8527]], 'radius' => 2000, 'four' => true],
        ['id' => 'pole_e', 'name' => '極東・三貂角', 'desc' => '新北市貢寮區三貂角燈塔', 'section' => '本島四極', 'tier' => 'silver',
         'icon' => 'lighthouse', 'points' => [[25.0067, 121.9994]], 'radius' => 2000, 'four' => true],
        ['id' => 'pole_w', 'name' => '極西・國聖港', 'desc' => '臺南市七股區國聖港燈塔', 'section' => '本島四極', 'tier' => 'silver',
         'icon' => 'lighthouse', 'points' => [[23.1003, 120.0356]], 'radius' => 2000, 'four' => true],

        ['id' => 'peak_yushan', 'name' => '玉山主峰', 'desc' => '玉山主峰（台灣最高峰 3,952 m）', 'section' => '特殊地理點', 'tier' => 'legend',
         'icon' => 'mountain', 'points' => [[23.4700, 120.9573]], 'radius' => 500],
        ['id' => 'peak_wuling', 'name' => '合歡山武嶺', 'desc' => '合歡山武嶺（公路最高點 3,275 m）', 'section' => '特殊地理點', 'tier' => 'gold',
         'icon' => 'mountain', 'points' => [[24.1372, 121.2758]], 'radius' => 500],
        ['id' => 'geo_center', 'name' => '地理中心', 'desc' => '南投縣埔里鎮台灣地理中心碑', 'section' => '特殊地理點', 'tier' => 'bronze',
         'icon' => 'pin', 'points' => [[23.9741, 120.9799]], 'radius' => 500],
        // 北緯 23°30′38.65″、東經 120°49′0.99″（使用者提供，2026-11-20）
        ['id' => 'geo_inaccessibility', 'name' => '台灣難抵極', 'desc' => '本島離海最遠的點（嘉義縣阿里山鄉）', 'section' => '特殊地理點', 'tier' => 'gold',
         'icon' => 'pin', 'points' => [[23.510736, 120.816942]], 'radius' => 500],
        // 北回歸線標誌分開列（2026-11-20 拆分；tropic 沿用原 id 作為嘉義水上；豐濱、舞鶴、東石座標由使用者提供）
        ['id' => 'tropic', 'name' => '北回歸線・嘉義水上', 'desc' => '嘉義水上北回歸線太陽館', 'section' => '特殊地理點', 'tier' => 'bronze',
         'icon' => 'sun', 'points' => [[23.4534, 120.4165]], 'radius' => 500],
        ['id' => 'tropic_dongshi', 'name' => '北回歸線・嘉義東石', 'desc' => '嘉義東石北回歸線標誌', 'section' => '特殊地理點', 'tier' => 'bronze',
         'icon' => 'sun', 'points' => [[23.4482658, 120.1356592]], 'radius' => 500],
        ['id' => 'tropic_wuhe', 'name' => '北回歸線・花蓮舞鶴', 'desc' => '花蓮瑞穗舞鶴北回歸線標誌', 'section' => '特殊地理點', 'tier' => 'bronze',
         'icon' => 'sun', 'points' => [[23.465731, 121.3574028]], 'radius' => 500],
        ['id' => 'tropic_fengbin', 'name' => '北回歸線・花蓮豐濱', 'desc' => '花蓮豐濱北回歸線標誌', 'section' => '特殊地理點', 'tier' => 'bronze',
         'icon' => 'sun', 'points' => [[23.4513623, 121.4962333]], 'radius' => 500],
    ],

    // ------------------------------------------------------------------
    // 離島：有人居住的島用村里／鄉鎮代碼判定，無人或小島用座標＋半徑（約島的大小）
    // ------------------------------------------------------------------
    'islands' => [
        // 本島周邊
        ['id' => 'isl_heping', 'name' => '和平島', 'section' => '本島周邊', 'tier' => 'bronze', 'points' => [[25.1608, 121.7639]], 'radius' => 800],
        ['id' => 'isl_keelung', 'name' => '基隆嶼', 'section' => '本島周邊', 'tier' => 'gold', 'points' => [[25.1922, 121.7856]], 'radius' => 700],
        ['id' => 'isl_huaping', 'name' => '花瓶嶼', 'section' => '本島周邊', 'tier' => 'legend', 'points' => [[25.4242, 121.9464]], 'radius' => 400],
        ['id' => 'isl_mianhua', 'name' => '棉花嶼', 'section' => '本島周邊', 'tier' => 'legend', 'points' => [[25.4850, 122.1064]], 'radius' => 800],
        ['id' => 'isl_pengjia', 'name' => '彭佳嶼', 'section' => '本島周邊', 'tier' => 'legend', 'points' => [[25.6294, 122.0714]], 'radius' => 1200],
        ['id' => 'isl_guishan', 'name' => '龜山島', 'section' => '本島周邊', 'tier' => 'gold', 'points' => [[24.8419, 121.9517]], 'radius' => 1500],
        ['id' => 'isl_liuqiu', 'name' => '小琉球', 'section' => '本島周邊', 'tier' => 'silver', 'town' => ['10013220']],
        ['id' => 'isl_green', 'name' => '綠島', 'section' => '本島周邊', 'tier' => 'gold', 'town' => ['10014110']],
        ['id' => 'isl_orchid', 'name' => '蘭嶼', 'section' => '本島周邊', 'tier' => 'gold', 'town' => ['10014160']],
        ['id' => 'isl_xiaolan', 'name' => '小蘭嶼', 'section' => '本島周邊', 'tier' => 'legend', 'points' => [[21.9500, 121.6102]], 'radius' => 1000],

        // 澎湖
        ['id' => 'isl_penghu', 'name' => '澎湖本島', 'desc' => '含跨海大橋相連的白沙島、西嶼', 'section' => '澎湖', 'tier' => 'bronze',
         'town' => ['10016010', '10016020', '10016030', '10016040'], 'numbered' => true,
         'exclude' => ['10016010033', '10016010034', '10016030012', '10016030013', '10016030014', '10016030015']],
        ['id' => 'isl_jibei', 'name' => '吉貝嶼', 'section' => '澎湖', 'tier' => 'silver', 'village' => ['10016030012']],
        ['id' => 'isl_niao', 'name' => '鳥嶼', 'section' => '澎湖', 'tier' => 'gold', 'village' => ['10016030013']],
        ['id' => 'isl_yuanbei', 'name' => '員貝嶼', 'section' => '澎湖', 'tier' => 'gold', 'village' => ['10016030014']],
        ['id' => 'isl_dacang', 'name' => '大倉嶼', 'section' => '澎湖', 'tier' => 'gold', 'village' => ['10016030015']],
        ['id' => 'isl_mudou', 'name' => '目斗嶼', 'section' => '澎湖', 'tier' => 'legend', 'points' => [[23.7860, 119.6000]], 'radius' => 800],
        ['id' => 'isl_hujing', 'name' => '虎井嶼', 'section' => '澎湖', 'tier' => 'silver', 'village' => ['10016010033']],
        ['id' => 'isl_tongpan', 'name' => '桶盤嶼', 'section' => '澎湖', 'tier' => 'silver', 'village' => ['10016010034']],
        ['id' => 'isl_wangan', 'name' => '望安島', 'section' => '澎湖', 'tier' => 'silver',
         'village' => ['10016050001', '10016050002', '10016050003', '10016050004']],
        ['id' => 'isl_jiangjun', 'name' => '將軍澳嶼', 'section' => '澎湖', 'tier' => 'gold', 'village' => ['10016050005']],
        ['id' => 'isl_dongyuping', 'name' => '東嶼坪', 'section' => '澎湖', 'tier' => 'platinum', 'village' => ['10016050006']],
        ['id' => 'isl_xiyuping', 'name' => '西嶼坪', 'section' => '澎湖', 'tier' => 'platinum', 'village' => ['10016050007']],
        ['id' => 'isl_dongji', 'name' => '東吉嶼', 'section' => '澎湖', 'tier' => 'gold', 'village' => ['10016050008']],
        ['id' => 'isl_xiji', 'name' => '西吉嶼', 'section' => '澎湖', 'tier' => 'legend', 'points' => [[23.2487, 119.6156]], 'radius' => 800],
        ['id' => 'isl_hua', 'name' => '花嶼', 'section' => '澎湖', 'tier' => 'platinum', 'village' => ['10016050009']],
        ['id' => 'isl_qimei', 'name' => '七美嶼', 'section' => '澎湖', 'tier' => 'silver', 'town' => ['10016060']],

        // 金門
        ['id' => 'isl_kinmen', 'name' => '大金門', 'section' => '金門', 'tier' => 'bronze',
         'town' => ['09020010', '09020020', '09020030', '09020040'], 'numbered' => true],
        ['id' => 'isl_lieyu', 'name' => '小金門（烈嶼）', 'section' => '金門', 'tier' => 'silver', 'town' => ['09020050'], 'numbered' => true],
        ['id' => 'isl_jiangong', 'name' => '建功嶼', 'section' => '金門', 'tier' => 'silver', 'points' => [[24.4274, 118.3000]], 'radius' => 300],
        ['id' => 'isl_dadan', 'name' => '大膽島', 'section' => '金門', 'tier' => 'gold', 'points' => [[24.3903, 118.1656]], 'radius' => 700],
        ['id' => 'isl_erdan', 'name' => '二膽島', 'section' => '金門', 'tier' => 'platinum', 'points' => [[24.3800, 118.1572]], 'radius' => 400],
        ['id' => 'isl_wuqiu', 'name' => '烏坵', 'section' => '金門', 'tier' => 'legend', 'town' => ['09020060']],

        // 馬祖
        ['id' => 'isl_nangan', 'name' => '南竿', 'section' => '馬祖', 'tier' => 'silver', 'town' => ['09007010'], 'numbered' => true],
        ['id' => 'isl_beigan', 'name' => '北竿', 'section' => '馬祖', 'tier' => 'silver', 'town' => ['09007020'], 'numbered' => true],
        ['id' => 'isl_daqiu', 'name' => '大坵島', 'section' => '馬祖', 'tier' => 'gold', 'points' => [[26.2474, 120.0013]], 'radius' => 700],
        ['id' => 'isl_gaodeng', 'name' => '高登島', 'section' => '馬祖', 'tier' => 'legend', 'points' => [[26.2732, 119.9861]], 'radius' => 800],
        ['id' => 'isl_liang', 'name' => '亮島', 'section' => '馬祖', 'tier' => 'legend', 'points' => [[26.3389, 120.2200]], 'radius' => 600],
        ['id' => 'isl_dongju', 'name' => '東莒', 'section' => '馬祖', 'tier' => 'gold', 'village' => ['09007030004', '09007030005']],
        ['id' => 'isl_xiju', 'name' => '西莒', 'section' => '馬祖', 'tier' => 'gold', 'village' => ['09007030001', '09007030002', '09007030003']],
        ['id' => 'isl_dongyin', 'name' => '東引', 'desc' => '含相連的西引島', 'section' => '馬祖', 'tier' => 'gold', 'town' => ['09007040'], 'numbered' => true],

        // 南海
        ['id' => 'isl_dongsha', 'name' => '東沙島', 'section' => '南海', 'tier' => 'legend', 'points' => [[20.7036, 116.7275]], 'radius' => 2000],
        ['id' => 'isl_taiping', 'name' => '太平島', 'section' => '南海', 'tier' => 'legend', 'points' => [[10.3772, 114.3664]], 'radius' => 1000],
    ],

    // ------------------------------------------------------------------
    // 國家公園與保護區
    // - 國家公園逐一列出：有範圍圖的用 area（code 對應 sql/import_areas.sh），沒有的用座標（金門、東沙、壽山）
    // - 成就說明（灰字）只寫判定條件：範圍內拍照／「desc + 距離」內拍照，desc 不重複公園名稱
    // - 其他保護區由 protected_areas 表自動產生（每個範圍一個徽章），等級依 kinds；個別調整寫在 overrides
    // ------------------------------------------------------------------
    'nature' => [
        'national_parks' => [
            ['id' => 'np_kenting', 'name' => '墾丁國家公園', 'tier' => 'silver', 'area' => ['np_kenting']],
            ['id' => 'np_yushan', 'name' => '玉山國家公園', 'tier' => 'gold', 'area' => ['np_yushan']],
            ['id' => 'np_yangmingshan', 'name' => '陽明山國家公園', 'tier' => 'bronze', 'area' => ['np_yangmingshan']],
            ['id' => 'np_taroko', 'name' => '太魯閣國家公園', 'tier' => 'silver', 'area' => ['np_taroko']],
            ['id' => 'np_sheipa', 'name' => '雪霸國家公園', 'tier' => 'silver', 'area' => ['np_sheipa']],
            // 金門、東沙環礁沒有範圍圖，以座標判定
            ['id' => 'np_kinmen', 'name' => '金門國家公園', 'desc' => '管理處', 'tier' => 'gold',
             'points' => [[24.4433, 118.3515]], 'radius' => 500],
            ['id' => 'np_dongsha', 'name' => '東沙環礁國家公園', 'desc' => '東沙島', 'tier' => 'legend',
             'points' => [[20.7036, 116.7275]], 'radius' => 2000],
            ['id' => 'np_taijiang', 'name' => '台江國家公園', 'tier' => 'bronze', 'area' => ['np_taijiang']],
            ['id' => 'np_south_penghu', 'name' => '澎湖南方四島國家公園', 'tier' => 'platinum', 'area' => ['np_south_penghu']],
            // 壽山不在國家公園圖資內；找不到遊客中心座標，暫用公園中心點並放寬半徑
            ['id' => 'np_shoushan', 'name' => '壽山國家自然公園', 'desc' => '公園中心', 'tier' => 'bronze',
             'points' => [[22.6496, 120.2636]], 'radius' => 1500],
        ],
        // 自動產生的類別：kind => [分區名稱, 等級, 符號]
        'kinds' => [
            'nature_protected' => ['自然保護區', 'gold', 'leaf'],
            'wildlife_refuge' => ['野生動物保護區', 'silver', 'leaf'],
            'wildlife_habitat' => ['野生動物重要棲息環境', 'silver', 'leaf'],
        ],
        // 名稱去掉的後綴（分區標題已說明類別）；由長到短比對，只去掉第一個符合的
        'strip_suffix' => ['野生動物重要棲息環境', '重要棲息環境', '野生動物保護區', '動物保護區', '水鳥保護區',
                           '魚類保護區', '自然保護區', '保護區'],
        // 個別範圍的調整：code => ['tier' => …, 'name' => …]
        'overrides' => [],
        // 不列成就的範圍代碼（手動指定）。
        // 另外，重要棲息環境與某個保護區範圍幾乎相同（重疊 ≥ 99%）時會自動略過、只留保護區（explore_stats.php），
        // 2026-11（1141／1151 版）共 12 筆，例如 WIH39 馬祖列島雌光螢重要棲息環境 = WR21 馬祖列島雌光螢野生動物保護區
        // 下面兩筆面積相同、只是界線數化略有偏移（重疊 93%、97%），自動判定抓不到，手動略過
        'skip' => [
            'WIH06',   // 台北市中興橋永福橋重要棲息環境 = WR04 臺北市野雁保護區（169.87 公頃）
            'WIH32',   // 臺南市四草重要棲息環境 = WR05 臺南市四草野生動物保護區（523.848 公頃）
        ],
    ],

    // ------------------------------------------------------------------
    // 景點（座標 300 公尺內有照片即算造訪；大範圍景點以遊客中心為準）
    // ------------------------------------------------------------------
    'landmark_radius' => 300,
    'landmarks' => [
        // 北部
        ['id' => 'lm_taipei101', 'name' => '台北101', 'section' => '北部', 'points' => [[25.0336, 121.5645]]],
        ['id' => 'lm_cks', 'name' => '中正紀念堂', 'section' => '北部', 'points' => [[25.0344, 121.5217]]],
        ['id' => 'lm_presidential', 'name' => '總統府', 'section' => '北部', 'points' => [[25.0400, 121.5120]]],
        ['id' => 'lm_longshan', 'name' => '艋舺龍山寺', 'section' => '北部', 'points' => [[25.0373, 121.4999]]],
        ['id' => 'lm_palace', 'name' => '故宮博物院', 'section' => '北部', 'points' => [[25.1022, 121.5486]]],
        ['id' => 'lm_beitou', 'name' => '北投地熱谷', 'section' => '北部', 'points' => [[25.1379, 121.5119]]],
        ['id' => 'lm_qingtiangang', 'name' => '陽明山擎天崗', 'section' => '北部', 'points' => [[25.1664, 121.5743]]],
        ['id' => 'lm_tamsui', 'name' => '淡水漁人碼頭', 'section' => '北部', 'points' => [[25.1830, 121.4110]]],
        ['id' => 'lm_yehliu', 'name' => '野柳地質公園', 'section' => '北部', 'points' => [[25.2043, 121.6911]]],
        ['id' => 'lm_jiufen', 'name' => '九份', 'section' => '北部', 'points' => [[25.1070, 121.8430]]],
        ['id' => 'lm_shifen', 'name' => '平溪十分', 'section' => '北部', 'points' => [[25.0411, 121.7750]]],
        ['id' => 'lm_daxi', 'name' => '大溪老街', 'section' => '北部', 'points' => [[24.8851, 121.2880]]],
        ['id' => 'lm_hsinchu_temple', 'name' => '新竹都城隍廟', 'section' => '北部', 'points' => [[24.8040, 120.9659]]],
        ['id' => 'lm_ncfta', 'name' => '宜蘭傳統藝術中心', 'section' => '北部', 'points' => [[24.6960, 121.8240]]],

        // 中部
        ['id' => 'lm_shengxing', 'name' => '勝興車站', 'section' => '中部', 'points' => [[24.3882, 120.7820]]],
        ['id' => 'lm_opera', 'name' => '台中國家歌劇院', 'section' => '中部', 'points' => [[24.1628, 120.6410]]],
        ['id' => 'lm_rainbow', 'name' => '彩虹眷村', 'section' => '中部', 'points' => [[24.1333, 120.6094]]],
        ['id' => 'lm_gaomei', 'name' => '高美濕地', 'section' => '中部', 'points' => [[24.3121, 120.5500]]],
        ['id' => 'lm_lukang', 'name' => '鹿港老街', 'section' => '中部', 'points' => [[24.0563, 120.4326]]],
        ['id' => 'lm_sunmoon', 'name' => '日月潭', 'desc' => '向山遊客中心', 'section' => '中部', 'points' => [[23.8521, 120.9021]]],
        ['id' => 'lm_cingjing', 'name' => '清境農場', 'section' => '中部', 'points' => [[24.0586, 121.1639]]],
        ['id' => 'lm_xitou', 'name' => '溪頭', 'section' => '中部', 'points' => [[23.6748, 120.7968]]],
        ['id' => 'lm_alishan', 'name' => '阿里山', 'desc' => '阿里山國家森林遊樂區遊客中心', 'section' => '中部', 'points' => [[23.5114, 120.8036]]],

        // 南部
        ['id' => 'lm_hinoki', 'name' => '嘉義檜意森活村', 'section' => '南部', 'points' => [[23.4862, 120.4541]]],
        ['id' => 'lm_anping', 'name' => '安平古堡', 'section' => '南部', 'points' => [[23.0015, 120.1606]]],
        ['id' => 'lm_chihkan', 'name' => '赤崁樓', 'section' => '南部', 'points' => [[22.9975, 120.2028]]],
        ['id' => 'lm_chimei', 'name' => '奇美博物館', 'section' => '南部', 'points' => [[22.9350453, 120.2214688]]],   // 2026-11-20 使用者更正
        ['id' => 'lm_saltmountain', 'name' => '七股鹽山', 'section' => '南部', 'points' => [[23.1553, 120.1054]]],
        ['id' => 'lm_pier2', 'name' => '駁二藝術特區', 'section' => '南部', 'points' => [[22.6199, 120.2820]]],
        ['id' => 'lm_cijin', 'name' => '旗後燈塔', 'section' => '南部', 'points' => [[22.6154, 120.2650]]],
        ['id' => 'lm_lotus', 'name' => '蓮池潭', 'section' => '南部', 'points' => [[22.6851, 120.2974]]],
        ['id' => 'lm_foguangshan', 'name' => '佛光山', 'section' => '南部', 'points' => [[22.7474, 120.4462]]],
        ['id' => 'lm_buddha_museum', 'name' => '佛陀紀念館', 'section' => '南部', 'points' => [[22.7548198, 120.4465764]]],   // 2026-11-20 使用者提供
        ['id' => 'lm_kenting', 'name' => '墾丁大街', 'section' => '南部', 'points' => [[21.9451, 120.7990]]],

        // 東部
        ['id' => 'lm_taroko', 'name' => '太魯閣', 'desc' => '太魯閣遊客中心', 'section' => '東部', 'points' => [[24.1577, 121.6222]]],
        ['id' => 'lm_qingshui', 'name' => '清水斷崖', 'section' => '東部', 'points' => [[24.2104, 121.6792]]],
        ['id' => 'lm_qixingtan', 'name' => '七星潭', 'section' => '東部', 'points' => [[24.0329, 121.6280]]],
        ['id' => 'lm_sanxiantai', 'name' => '三仙台', 'section' => '東部', 'points' => [[23.1248, 121.4165]]],
        ['id' => 'lm_brown', 'name' => '池上伯朗大道', 'section' => '東部', 'points' => [[23.0989, 121.2133]]],
        ['id' => 'lm_luye', 'name' => '鹿野高台', 'section' => '東部', 'points' => [[22.9129, 121.1195]]],
        ['id' => 'lm_duoliang', 'name' => '多良車站', 'section' => '東部', 'points' => [[22.5075, 120.9589]]],
    ],

    // ------------------------------------------------------------------
    // B 級景點（沒落樂園、廢墟、怪奇廟宇、怪建築與奇特地景；座標 250 公尺內有照片即算造訪）
    // 座標來源：OpenStreetMap（Nominatim／Overpass）、英文維基百科、使用者提供的 Google 地圖連結，2026-11-20 查證
    // 已拆除的地點用原址座標（舊照片仍可解鎖）
    // ------------------------------------------------------------------
    'bspot_radius' => 250,
    'bspots' => [
        // 北部
        ['id' => 'bs_yunxian', 'name' => '雲仙樂園', 'section' => '北部', 'points' => [[24.843619, 121.555924]]],
        ['id' => 'bs_guaiguai', 'name' => '龍潭怪怪屋', 'section' => '北部', 'points' => [[24.869843, 121.213605]]],
        ['id' => 'bs_tangcheng', 'name' => '湯城', 'desc' => '三重湯城園區', 'section' => '北部', 'points' => [[25.045235, 121.468533]]],
        ['id' => 'bs_cihu', 'name' => '慈湖紀念雕塑公園', 'section' => '北部', 'points' => [[24.841531, 121.294136]]],
        ['id' => 'bs_sanzhi_ufo', 'name' => '三芝飛碟屋', 'desc' => '原址（已拆除）', 'section' => '北部', 'points' => [[25.260833, 121.477778]]],
        ['id' => 'bs_wanli_ufo', 'name' => '萬里飛碟屋', 'desc' => '翡翠灣聽濤路', 'section' => '北部', 'points' => [[25.186975, 121.686276]]],
        ['id' => 'bs_18kings', 'name' => '十八王公廟', 'desc' => '石門乾華十八王公廟', 'section' => '北部', 'points' => [[25.291914, 121.586341]]],
        ['id' => 'bs_agenna', 'name' => '阿根納造船廠遺構', 'section' => '北部', 'points' => [[25.153973, 121.769698]]],
        ['id' => 'bs_13levels', 'name' => '十三層遺址', 'desc' => '水湳洞選煉廠遺址', 'section' => '北部', 'points' => [[25.120334, 121.863749]]],
        ['id' => 'bs_houtong', 'name' => '猴硐整煤廠', 'desc' => '瑞三整煤廠', 'section' => '北部', 'points' => [[25.086432, 121.827589]]],
        ['id' => 'bs_doraemon', 'name' => '小叮噹科學主題樂園', 'section' => '北部', 'points' => [[24.870290, 120.978657]]],
        ['id' => 'bs_nantian', 'name' => '南天宮金媽祖', 'desc' => '南方澳南天宮', 'section' => '北部', 'points' => [[24.581693, 121.864935]]],

        // 中部
        ['id' => 'bs_shangrila', 'name' => '香格里拉樂園', 'section' => '中部', 'points' => [[24.624672, 120.841388]]],
        ['id' => 'bs_westlake', 'name' => '西湖渡假村', 'section' => '中部', 'points' => [[24.390055, 120.762348]]],
        ['id' => 'bs_ago', 'name' => '亞哥花園', 'desc' => '亞哥花園入口（公車站）', 'section' => '中部', 'points' => [[24.175275, 120.756900]]],
        ['id' => 'bs_xinshe_castle', 'name' => '新社古堡', 'section' => '中部', 'points' => [[24.186966, 120.812394]]],
        ['id' => 'bs_baojue', 'name' => '寶覺寺彌勒大佛', 'desc' => '寶覺禪寺', 'section' => '中部', 'points' => [[24.159488, 120.687903]]],
        ['id' => 'bs_yokai', 'name' => '溪頭妖怪村', 'desc' => '松林町妖怪村', 'section' => '中部', 'points' => [[23.674012, 120.795833]]],
        ['id' => 'bs_paper_church', 'name' => '紙教堂', 'desc' => '埔里桃米紙教堂', 'section' => '中部', 'points' => [[23.941410, 120.927057]]],
        ['id' => 'bs_chungtai', 'name' => '中台禪寺', 'section' => '中部', 'points' => [[24.009083, 120.944434]]],
        ['id' => 'bs_wude', 'name' => '北港武德宮', 'section' => '中部', 'points' => [[23.581016, 120.299695]]],

        // 南部
        ['id' => 'bs_minxiong', 'name' => '民雄鬼屋', 'desc' => '民雄劉宅', 'section' => '南部', 'points' => [[23.530506, 120.426616]]],
        ['id' => 'bs_heel_church', 'name' => '高跟鞋教堂', 'section' => '南部', 'points' => [[23.377783, 120.148773]]],
        ['id' => 'bs_madou', 'name' => '麻豆代天府', 'desc' => '麻豆代天府（天堂地獄）', 'section' => '南部', 'points' => [[23.190143, 120.260030]]],
        ['id' => 'bs_treehouse', 'name' => '安平樹屋', 'section' => '南部', 'points' => [[23.004033, 120.159740]]],
        ['id' => 'bs_nanzi_bridge', 'name' => '楠梓百慕達', 'desc' => '楠梓陸橋', 'section' => '南部', 'points' => [[22.724870, 120.323989]]],
    ],
];
