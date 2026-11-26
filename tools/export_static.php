<?php
// 匯出靜態資料到 data/（給前端在瀏覽器內計算用）
//
// 用法（在專案根目錄）：
//   C:/xampp/php/php.exe tools/export_static.php            全部匯出
//   C:/xampp/php/php.exe tools/export_static.php units rail 只匯出指定項目
// 項目：units、maps、villages、areas、achievements、peaks、rail（每次都會更新 version.json）
//
// 來源：
//   - 界線、保護區、車站：PostGIS photo_monitor 資料庫（只讀；連線設定見 tools/lib.php）
//   - 成就、百岳、鐵道路線：tools/config/*.php（本專案的設定，以這裡為準）
//
// 規則沿用原專案 dashboard/explore_stats.php；差異：
//   - 以 town／village 代碼定義的地點，在這裡就展開成村里代碼清單（鄉鎮一律由村里代碼前 8 碼推得）
//   - 保護區的重複範圍（重要棲息環境 ≈ 保護區）在這裡就排除
//   - 鐵道卡片在這裡就組好（含「其他車站」卡與路線制霸）
//   - 判定條件文字改用「有足跡」（資料來源不只照片）

require __DIR__ . '/lib.php';
require __DIR__ . '/topojson.php';

ini_set('memory_limit', '2G');
ini_set('serialize_precision', '-1');   // 浮點數輸出最短表示
mb_internal_encoding('UTF-8');

const OUT = __DIR__ . '/../data';
const CFG = __DIR__ . '/config';
// 迷霧小地圖：台澎金馬範圍、經度縮放、各層簡化容許值（與原專案相同）
const MAP_ENV = 'ST_MakeEnvelope(118.1, 21.85, 122.2, 26.45, 4326)';
const MAP_KX = 0.9135;
const MAP_TOLERANCE = ['county' => 0.004, 'town' => 0.002, 'village' => 0.0018];
const VILLAGE_SCALE = 1e5;    // 村里界線量化：1e-5 度 ≈ 1.1 公尺（不做幾何簡化）
const AREA_SIMPLIFY = 0.00001; // 保護區簡化容許值 ≈ 1 公尺（5 公尺時有 2 個範圍的判定和原專案不同）
const AREA_SCALE = 1e5;

$only = array_slice($argv, 1);
$want = fn(string $k) => !$only || in_array($k, $only, true);

$pg = fog_pg();
if (!is_dir(OUT)) mkdir(OUT, 0775, true);

function write_json(string $name, $data): void
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    $file = OUT . "/$name";
    file_put_contents("$file.tmp", $json);
    rename("$file.tmp", $file);
    printf("  %-24s %8.1f KB（gzip 約 %.1f KB）\n", $name, strlen($json) / 1024, strlen(gzencode($json, 6)) / 1024);
}

function warn(string $msg): void
{
    fwrite(STDERR, "  ⚠ $msg\n");
}

$dist = fn(float $m) => $m >= 1000 ? rtrim(rtrim(number_format($m / 1000, 1), '0'), '.') . ' 公里' : (int)$m . ' 公尺';

// 村里清單（多個項目共用）
$villsByTown = [];
$allVills = [];
foreach ($pg->query('SELECT villcode, towncode FROM villages ORDER BY villcode') as $r) {
    $villsByTown[$r['towncode']][] = $r['villcode'];
    $allVills[$r['villcode']] = true;
}

// ======================================================================
// units.json：鄉鎮、村里代碼、名稱、面積（km²）
// ======================================================================

if ($want('units')) {
    echo "units\n";
    $towns = [];
    foreach ($pg->query("SELECT towncode, countycode, countyname, townname, ST_Area(geom::geography) / 1e6 AS km2 FROM towns ORDER BY towncode") as $r) {
        $towns[] = [$r['towncode'], $r['countycode'], $r['countyname'], $r['townname'], round((float)$r['km2'], 3)];
    }
    $villages = [];
    foreach ($pg->query("SELECT villcode, towncode, COALESCE(villname, '') AS villname, ST_Area(geom::geography) / 1e6 AS km2 FROM villages ORDER BY villcode") as $r) {
        $villages[] = [$r['villcode'], $r['towncode'], $r['villname'], round((float)$r['km2'], 4)];
    }
    write_json('units.json', [
        '_format' => ['towns' => '[towncode, countycode, countyname, townname, km2]', 'villages' => '[villcode, towncode, villname, km2]'],
        'towns' => $towns, 'villages' => $villages,
    ]);
}

// ======================================================================
// map_{county,town,village}.json：迷霧小地圖 SVG 路徑（與原專案相同）
// ======================================================================

if ($want('maps')) {
    echo "maps\n";
    $hasCounties = $pg->query("SELECT to_regclass('public.counties') IS NOT NULL")->fetchColumn();
    foreach (MAP_TOLERANCE as $level => $tol) {
        $src = [
            // 縣市優先用縣市界；縣市界缺少的（金門、連江）由鄉鎮合併
            'county' => $hasCounties
                ? "SELECT countycode AS code, countyname AS name, geom FROM counties
                   UNION ALL
                   SELECT countycode, MIN(countyname), ST_Union(geom) FROM towns
                   WHERE countycode NOT IN (SELECT countycode FROM counties) GROUP BY countycode"
                : "SELECT countycode AS code, MIN(countyname) AS name, ST_Union(geom) AS geom FROM towns GROUP BY countycode",
            'town' => "SELECT towncode AS code, countyname || ' ' || townname AS name, geom FROM towns",
            'village' => "SELECT villcode AS code, countyname || ' ' || townname || ' ' || COALESCE(villname, '') AS name, geom FROM villages",
        ][$level];
        $sql = "WITH src AS ($src),
                g AS (SELECT code, name, ST_SimplifyPreserveTopology(ST_ClipByBox2D(geom, " . MAP_ENV . "), $tol) AS geom FROM src),
                p AS (SELECT code, name, (ST_Dump(geom)).geom AS part FROM g),
                r AS (SELECT code, name, part, ROW_NUMBER() OVER (PARTITION BY code ORDER BY ST_Area(part) DESC) AS rn
                      FROM p WHERE ST_GeometryType(part) = 'ST_Polygon')
                SELECT code, name, ST_AsSVG(ST_Scale(ST_Collect(part), " . MAP_KX . ", 1), 1, 3) AS d
                FROM r WHERE rn = 1 OR ST_Area(part) > 2e-6
                GROUP BY code, name ORDER BY code";
        $paths = [];
        foreach ($pg->query($sql) as $r) {
            if ($r['d'] === '' || $r['d'] === null) continue;
            $paths[] = ['code' => $r['code'], 'name' => $r['name'], 'd' => $r['d']];
        }
        $ext = $pg->query("SELECT ST_XMin(e) x0, ST_XMax(e) x1, ST_YMin(e) y0, ST_YMax(e) y1
                           FROM (SELECT ST_Extent(ST_ClipByBox2D(geom, " . MAP_ENV . ")) e FROM towns) t")->fetch();
        $pad = 0.05;
        $viewBox = sprintf('%.3f %.3f %.3f %.3f',
            ($ext['x0'] - $pad) * MAP_KX, -($ext['y1'] + $pad),
            ($ext['x1'] - $ext['x0'] + 2 * $pad) * MAP_KX, $ext['y1'] - $ext['y0'] + 2 * $pad);
        write_json("map_$level.json", ['level' => $level, 'viewBox' => $viewBox, 'paths' => $paths]);
    }
}

// ======================================================================
// villages.topo.json：村里界線（判定照片所屬村里用；只量化、不簡化）
// ======================================================================

if ($want('villages')) {
    echo "villages\n";
    $geoms = [];
    foreach ($pg->query('SELECT villcode, ST_AsGeoJSON(geom, 7) AS g FROM villages ORDER BY villcode') as $r) {
        $geoms[$r['villcode']] = json_decode($r['g'], true);
    }
    $topo = topo_encode($geoms, 'villages', VILLAGE_SCALE);
    $bad = topo_verify($topo, 'villages');
    if ($bad) warn('解碼後與原始座標不一致：' . implode(', ', array_slice($bad, 0, 10)));
    $missing = array_diff(array_keys($geoms), array_column($topo['objects']['villages']['geometries'], 'id'));
    if ($missing) warn('量化後太小而略過的村里：' . implode(', ', $missing));
    printf("  村里 %d、弧 %d、驗證 %s\n", count($topo['objects']['villages']['geometries']), count($topo['arcs']), $bad ? '失敗' : '通過');
    unset($topo['_q']);
    write_json('villages.topo.json', $topo);
}

// ======================================================================
// 保護區：要列成就的範圍（排除手動 skip 與重複範圍）
// ======================================================================

$cfg = require CFG . '/achievements.php';
$nat = $cfg['nature'];

$areaRows = [];
if ($want('areas') || $want('achievements')) {
    $kinds = array_keys($nat['kinds']);
    $in = implode(',', array_map([$pg, 'quote'], $kinds));
    $rows = $pg->query("SELECT code, kind, name FROM protected_areas WHERE kind IN ($in) ORDER BY code")->fetchAll();
    // 重要棲息環境與某個保護區範圍幾乎相同（面積差 ≤ 1%、重疊 ≥ 99%）：只留保護區
    $dups = $pg->query("
        SELECT DISTINCT a.code FROM protected_areas a
        JOIN protected_areas b ON b.kind <> 'wildlife_habitat' AND a.geom && b.geom
             AND abs(ST_Area(a.geom) - ST_Area(b.geom)) <= 0.01 * GREATEST(ST_Area(a.geom), ST_Area(b.geom))
        WHERE a.kind = 'wildlife_habitat'
          AND ST_Area(ST_Intersection(a.geom, b.geom)) >= 0.99 * ST_Area(ST_Union(a.geom, b.geom))
        ORDER BY a.code")->fetchAll(PDO::FETCH_COLUMN);
    $skip = array_flip(array_merge($nat['skip'] ?? [], $dups));
    $areaRows = array_values(array_filter($rows, fn($r) => !isset($skip[$r['code']])));
    usort($areaRows, fn($a, $b) => array_search($a['kind'], $kinds) <=> array_search($b['kind'], $kinds));
    printf("areas：%d 個範圍，排除重複 %d、手動略過 %d\n", count($areaRows), count($dups), count($nat['skip'] ?? []));
}

// 用到的範圍代碼：國家公園的 area ＋ 自動產生的保護區
$usedAreas = [];
foreach ($nat['national_parks'] as $p) foreach ($p['area'] ?? [] as $c) $usedAreas[$c] = true;
foreach ($areaRows as $r) $usedAreas[$r['code']] = true;

if ($want('areas')) {
    $in = implode(',', array_map([$pg, 'quote'], array_keys($usedAreas)));
    $geoms = [];
    foreach ($pg->query("SELECT code, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, " . AREA_SIMPLIFY . "), 7) AS g
                         FROM protected_areas WHERE code IN ($in) ORDER BY code") as $r) {
        $geoms[$r['code']] = json_decode($r['g'], true);
    }
    $missing = array_diff(array_keys($usedAreas), array_keys($geoms));
    if ($missing) warn('設定檔用到、資料庫沒有的範圍：' . implode(', ', $missing));
    $topo = topo_encode($geoms, 'areas', AREA_SCALE);
    $bad = topo_verify($topo, 'areas');
    if ($bad) warn('解碼後與原始座標不一致：' . implode(', ', $bad));
    printf("  範圍 %d、弧 %d、驗證 %s\n", count($topo['objects']['areas']['geometries']), count($topo['arcs']), $bad ? '失敗' : '通過');
    unset($topo['_q']);
    write_json('areas.topo.json', $topo);
}

// ======================================================================
// achievements.json：里程碑、旅行門檻、地點類成就（極點、離島、景點、B 級景點、國家公園與保護區）、節慶活動
// ======================================================================

if ($want('achievements')) {
    echo "achievements\n";
    $defaultIcon = ['pole' => 'lighthouse', 'island' => 'island', 'landmark' => 'camera', 'bspot' => 'ghost', 'nature' => 'leaf'];
    $raw = [];   // 原始定義（補上 group 等）
    foreach (['pole' => 'poles', 'island' => 'islands', 'landmark' => 'landmarks', 'bspot' => 'bspots'] as $group => $key) {
        $defRadius = $group === 'bspot' ? ($cfg['bspot_radius'] ?? 250) : $cfg['landmark_radius'];
        foreach ($cfg[$key] ?? [] as $p) {
            $p['group'] = $group;
            if (isset($p['points'])) $p['radius'] = (float)($p['radius'] ?? $defRadius);
            $raw[] = $p;
        }
    }
    foreach ($nat['national_parks'] as $p) {
        $p += ['group' => 'nature', 'section' => '國家公園', 'icon' => 'mountain'];
        if (isset($p['points'])) $p['radius'] = (float)($p['radius'] ?? $cfg['landmark_radius']);
        $raw[] = $p;
    }
    foreach ($areaRows as $r) {
        [$section, $tier, $icon] = $nat['kinds'][$r['kind']];
        $name = $r['name'];
        foreach ($nat['strip_suffix'] ?? [] as $suf) {
            if (str_ends_with($name, $suf) && $name !== $suf) { $name = mb_substr($name, 0, mb_strlen($name) - mb_strlen($suf)); break; }
        }
        $raw[] = array_merge(['id' => 'area_' . $r['code'], 'name' => $name, 'group' => 'nature', 'section' => $section,
                              'tier' => $tier, 'icon' => $icon, 'area' => [$r['code']]], $nat['overrides'][$r['code']] ?? []);
    }

    $places = [];
    $ids = [];
    foreach ($raw as $p) {
        if (isset($ids[$p['id']])) warn("成就 id 重複：{$p['id']}");
        $ids[$p['id']] = true;
        $out = ['id' => $p['id'], 'group' => $p['group'], 'name' => $p['name'], 'section' => $p['section'] ?? null,
                'tier' => $p['tier'] ?? 'bronze', 'icon' => $p['icon'] ?? $defaultIcon[$p['group']]];
        $extra = $p['desc'] ?? null;
        if (isset($p['points'])) {
            $out['points'] = $p['points'];
            $out['radius'] = $p['radius'];
        } elseif (isset($p['area'])) {
            $out['areas'] = $p['area'];
        } else {
            // town／village → 村里代碼清單（numbered：只算有編號的村里；exclude：排除）
            $codes = $p['village'] ?? [];
            foreach ($p['town'] ?? [] as $t) {
                if (!isset($villsByTown[$t])) warn("{$p['id']}：找不到鄉鎮 $t");
                foreach ($villsByTown[$t] ?? [] as $c) {
                    if (!empty($p['numbered']) && !ctype_digit(substr($c, 8))) continue;
                    if (in_array($c, $p['exclude'] ?? [], true)) continue;
                    $codes[] = $c;
                }
            }
            foreach ($codes as $c) if (!isset($allVills[$c])) warn("{$p['id']}：找不到村里 $c");
            if (!$codes) warn("{$p['id']}：沒有任何村里");
            $out['villages'] = array_values(array_unique($codes));
        }
        // 判定條件文字（名稱已在標題，不重複）
        if ($p['group'] === 'island') {
            $rule = isset($p['points']) ? "島上有足跡（距中心 {$dist($p['radius'])}內）" : '島上有足跡';
            $out['desc'] = $extra ? "{$rule}；{$extra}" : $rule;
        } elseif (isset($p['area'])) {
            $out['desc'] = $extra ?? '範圍內有足跡';
        } else {
            $out['desc'] = ($extra ?? $p['name']) . " {$dist($p['radius'])}內有足跡";
        }
        if (!empty($p['four'])) $out['four'] = true;
        // 代表點（手動紀錄用）：以範圍判定的地點取最大一塊面的 ST_PointOnSurface（保證在面內）
        if (isset($out['villages']) || isset($out['areas'])) {
            $src = isset($out['villages'])
                ? 'SELECT geom FROM villages WHERE villcode IN (' . implode(',', array_map([$pg, 'quote'], $out['villages'])) . ')'
                : 'SELECT geom FROM protected_areas WHERE code IN (' . implode(',', array_map([$pg, 'quote'], $out['areas'])) . ')';
            $rep = $pg->query("SELECT ST_Y(p) AS lat, ST_X(p) AS lng FROM (
                SELECT ST_PointOnSurface(d.geom) AS p FROM (SELECT (ST_Dump(geom)).geom FROM ($src) s) d
                ORDER BY ST_Area(d.geom) DESC LIMIT 1) r")->fetch();
            if ($rep) $out['rep'] = [round((float)$rep['lat'], 6), round((float)$rep['lng'], 6)];
            else warn("{$p['id']}：無法產生代表點");
        }
        $places[] = $out;
    }
    $counts = array_count_values(array_column($places, 'group'));
    echo '  ' . implode('、', array_map(fn($g, $n) => "$g $n", array_keys($counts), $counts)) . "\n";

    // 節慶活動：年份表補齊（第一屆到最後一筆，沒列的年份用預設值）；之後的年份由前端用預設值推算
    $festivals = [];
    foreach ($cfg['festivals'] ?? [] as $f) {
        if (isset($ids[$f['id']])) warn("成就 id 重複：{$f['id']}");
        $ids[$f['id']] = true;
        [$d0, $d1] = $f['default'];
        $last = max(array_keys($f['seasons']) ?: [$f['first']]);
        $seasons = [];
        for ($y = $f['first']; $y <= $last; $y++) {
            $seasons[] = [$y, ...($f['seasons'][$y] ?? ["$y-$d0", ($y + 1) . "-$d1"])];
        }
        $festivals[] = ['id' => $f['id'], 'group' => 'festival', 'name' => $f['name'], 'desc' => $f['desc'],
                        'tier' => $f['tier'] ?? 'gold', 'icon' => $f['icon'] ?? 'star',
                        'scene' => $f['scene'] ?? 'xmas', 'stamp' => $f['stamp'] ?? [$f['name'], ''],
                        'points' => $f['points'], 'radius' => (float)$f['radius'], 'hours' => $f['hours'],
                        'default' => $f['default'], 'seasons' => $seasons];
    }
    echo '  festival ' . count($festivals) . "
";

    write_json('achievements.json', [
        '_format' => [
            'milestones' => '各層門檻 [數量, 等級]；全制霸一級由前端依實際總數加上',
            'travel' => '旅行成就門檻；regular_photos 只在照片模式使用',
            'places' => '地點類成就，判定三選一：points+radius（公尺）／villages（村里代碼）／areas（areas.topo.json 的 id）；four＝本島四極；rep＝以範圍判定者的代表點 [緯度, 經度]（手動紀錄用，ST_PointOnSurface）',
            'festivals' => '節慶活動（年份集點卡）：points+radius 內、hours [起, 迄] 點之間、seasons [[年份, 開城日, 閉城日（含）]] 期間有足跡；seasons 之後的年份用 default [月-日, 隔年月-日]；scene＝像素場景、stamp＝戳章上的字 [上, 下]',
        ],
        'milestones' => $cfg['milestones'],
        'travel' => $cfg['travel'],
        'places' => $places,
        'festivals' => $festivals,
    ]);

    // 明細小地圖的範圍外框（以村里或保護區判定的地點）：合併後依大小簡化（約 1/800 寬度），同原專案
    // 只給畫圖用，判定仍用 villages.topo.json／areas.topo.json
    $shapes = [];
    foreach ($places as $p) {
        if (isset($p['villages'])) {
            $src = 'SELECT geom FROM villages WHERE villcode IN (' . implode(',', array_map([$pg, 'quote'], $p['villages'])) . ')';
        } elseif (isset($p['areas'])) {
            $src = 'SELECT geom FROM protected_areas WHERE code IN (' . implode(',', array_map([$pg, 'quote'], $p['areas'])) . ')';
        } else continue;
        // 村里界線彼此有細縫，聯集後會留下細長的內洞；以村里判定的是島嶼，沒有真正的內洞，只留各塊的外環
        $union = isset($p['villages'])
            ? "SELECT ST_Collect(ST_MakePolygon(ST_ExteriorRing(d.geom))) AS g
               FROM ST_Dump((SELECT ST_Union(geom) FROM ($src) s0)) d"
            : "SELECT ST_Union(geom) AS g FROM ($src) s";
        $g = $pg->query("WITH u AS ($union)
            SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(g, GREATEST(ST_XMax(g) - ST_XMin(g), ST_YMax(g) - ST_YMin(g)) / 800), 6)
            FROM u")->fetchColumn();
        if ($g) $shapes[$p['id']] = json_decode($g, true);
    }
    $topo = topo_encode($shapes, 'shapes', 1e5);
    $bad = topo_verify($topo, 'shapes');
    if ($bad) warn('範圍外框驗證失敗：' . implode(', ', $bad));
    printf("  範圍外框 %d 個\n", count($topo['objects']['shapes']['geometries']));
    unset($topo['_q']);
    write_json('shapes.topo.json', $topo);
}

// ======================================================================
// peaks.json：百岳、小百岳
// ======================================================================

if ($want('peaks')) {
    echo "peaks\n";
    $peakCfg = require CFG . '/peaks.php';
    $radius = (float)($cfg['peak_radius'] ?? 300);
    $lists = [];
    foreach (['peaks_baiyue' => ['baiyue', '百岳', 'legend'], 'peaks_xiao' => ['xiaobaiyue', '小百岳', 'platinum']] as $id => [$key, $label, $tier]) {
        $lists[] = ['id' => $id, 'name' => $label, 'tier' => $tier,
                    'desc' => "{$label}山頂 " . (int)$radius . ' 公尺內有足跡即算登頂（集點卡）',
                    'peaks' => $peakCfg[$key]];
        printf("  %s %d 座\n", $label, count($peakCfg[$key]));
    }
    write_json('peaks.json', ['_format' => ['peaks' => '[編號, 山名, 緯度, 經度, 標高 m]'], 'radius' => $radius, 'lists' => $lists]);
}

// ======================================================================
// rail.json：車站與集點卡（臺鐵各線、阿里山林業鐵路、高鐵、捷運、輕軌）
// ======================================================================

if ($want('rail')) {
    echo "rail\n";
    $railCfg = require CFG . '/rail_lines.php';
    $radius = (float)($railCfg['radius'] ?? 250);

    // 車站：代表座標（多點取中心）＋全部點位（判定時任一點符合即可）
    $stations = [];   // 輸出陣列
    $idx = [];        // system → name → 車站索引
    foreach ($pg->query("SELECT system, name, code, ST_Y(ST_Centroid(geom)) AS lat, ST_X(ST_Centroid(geom)) AS lng,
                                ST_AsGeoJSON(geom, 6) AS g
                         FROM rail_stations ORDER BY system, name") as $r) {
        $g = json_decode($r['g'], true);
        $coords = $g['type'] === 'Point' ? [$g['coordinates']] : $g['coordinates'];
        $idx[$r['system']][$r['name']] = count($stations);
        $stations[] = ['system' => $r['system'], 'name' => $r['name'], 'code' => $r['code'],
                       'lat' => round((float)$r['lat'], 6), 'lng' => round((float)$r['lng'], 6),
                       'pts' => array_map(fn($c) => [$c[1], $c[0]], $coords)];
    }

    // 沒列在任何一張卡（也不在 skip）的站 → 「其他車站」卡
    $listed = [];
    foreach ($railCfg['cards'] as $c) {
        if (!isset($c['stations'])) { $listed[$c['system']] = true; continue; }
        foreach ($c['stations'] as $s) $listed[$c['system']][$s] = true;
    }
    $cards = $railCfg['cards'];
    $metroLines = $railCfg['metro_lines'] ?? [];
    $traGrade = [];
    foreach ($railCfg['tra_grades'] ?? [] as $grade => $list) foreach ($list as $s) $traGrade[$s] = $grade;
    $others = [];
    foreach ($idx as $sys => $list) {
        if (($listed[$sys] ?? null) === true) continue;
        foreach ($list as $name => $_) {
            if (!isset($listed[$sys][$name]) && !in_array($name, $railCfg['skip'][$sys] ?? [], true)) $others[] = [$sys, $name];
        }
    }
    if ($others) {
        warn('沒歸入路線的車站（會出現「其他車站」卡）：' . implode('、', array_map(fn($o) => "$o[0]:$o[1]", $others)));
        $cards[] = ['id' => 'rail_others', 'name' => '其他車站', 'desc' => '尚未歸入路線', 'section' => '臺鐵', 'items' => $others];
    }

    $outCards = [];
    foreach ($cards as $card) {
        if (isset($card['items'])) $items = $card['items'];
        elseif (isset($card['stations'])) $items = array_map(fn($s) => [$card['system'], $s], $card['stations']);
        else {
            // 整個系統：有路線站序的依路線順序（轉乘站放在第一條線），其餘有站碼的依站碼、否則依緯度由北到南
            $sys = $card['system'];
            $items = [];
            foreach ($metroLines[$sys] ?? [] as $line) foreach ($line['stations'] ?? [] as $s) $items[$s] = [$sys, $s];
            $rest = array_diff_key($idx[$sys] ?? [], $items);
            uksort($rest, function ($a, $b) use ($rest, $stations) {
                $sa = $stations[$rest[$a]]; $sb = $stations[$rest[$b]];
                return $sa['code'] !== null && $sb['code'] !== null ? strnatcmp($sa['code'], $sb['code']) : $sb['lat'] <=> $sa['lat'];
            });
            foreach (array_keys($rest) as $s) $items[$s] = [$sys, $s];
            $items = array_values($items);
        }
        $cells = [];
        foreach ($items as [$sys, $name]) {
            if (!isset($idx[$sys][$name])) { warn("{$card['id']}：圖資沒有 $sys:$name，略過"); continue; }
            $cell = ['s' => $idx[$sys][$name]];
            if ($sys === 'tra' && isset($traGrade[$name])) {
                $cell += ['grade' => $traGrade[$name], 'tier' => $railCfg['grade_tier'][$traGrade[$name]]];
            } elseif (isset($metroLines[$sys])) {
                $ls = count($metroLines[$sys]) === 1 ? $metroLines[$sys]
                    : array_filter($metroLines[$sys], fn($l) => in_array($name, $l['stations'] ?? [], true));
                if ($ls) $cell += ['lines' => array_values(array_column($ls, 'name')), 'colors' => array_values(array_column($ls, 'color'))];
            }
            $cells[] = $cell;
        }
        if (!$cells) continue;
        $sys = $card['system'] ?? '';
        $group = str_starts_with($sys, 'lrt_') ? 'lrt' : (isset($metroLines[$sys]) ? 'metro' : 'rail');

        // 路線制霸：多線的捷運系統依路線拆開（轉乘站算進每條線），其他一張卡就是一條線
        $parts = [];
        if ($card['id'] !== 'rail_others') {
            $sysLines = $metroLines[$sys] ?? [];
            if (count($sysLines) > 1) {
                foreach ($sysLines as $lid => $l) {
                    $ci = [];
                    foreach ($cells as $i => $c) if (in_array($stations[$c['s']]['name'], $l['stations'], true)) $ci[] = $i;
                    if (!$ci) continue;
                    $parts[] = ['id' => $card['id'] . '_' . strtolower($lid),
                                'name' => '制霸' . (mb_strlen($l['name']) <= 2 ? $card['name'] . $l['name'] : $l['name']),
                                'cells' => $ci];
                }
            } else {
                $parts[] = ['id' => $card['id'] . '_all', 'name' => '制霸' . $card['name'], 'cells' => array_keys($cells)];
            }
        }
        $outCards[] = ['id' => $card['id'], 'name' => $card['name'], 'group' => $group,
                       'section' => $group === 'rail' ? ($card['section'] ?? null) : null,
                       'desc' => (isset($card['desc']) ? "{$card['desc']}；" : '') . '車站 ' . (int)$radius . ' 公尺內有足跡',
                       'cells' => $cells, 'parts' => $parts];
    }
    printf("  車站 %d、卡片 %d、路線制霸 %d\n", count($stations), count($outCards), array_sum(array_map(fn($c) => count($c['parts']), $outCards)));
    write_json('rail.json', [
        '_format' => [
            'stations' => 'pts 為判定用點位 [緯度, 經度]（任一點符合即到站）；lat／lng 為顯示用中心',
            'cards' => 'cells[].s 為 stations 索引；parts 為路線制霸，cells 為本卡 cells 的索引',
        ],
        'radius' => $radius, 'stations' => $stations, 'cards' => $outCards,
    ]);
}

// ======================================================================
// version.json：資料版本（前端版本不同時重新下載並重算）
// ======================================================================

$verFile = OUT . '/version.json';
$prev = is_file($verFile) ? json_decode(file_get_contents($verFile), true) : [];
$files = [];
$sizes = [];   // 位元組數：前端下載時顯示「已下載 / 總大小」
foreach (glob(OUT . '/*.json') as $f) {
    if (basename($f) === 'version.json') continue;
    $files[basename($f)] = substr(md5_file($f), 0, 8);
    $sizes[basename($f)] = filesize($f);
}
$changed = ($prev['files'] ?? null) !== $files;
write_json('version.json', [
    'version' => $changed ? date('YmdHis') : ($prev['version'] ?? date('YmdHis')),
    'files' => $files,
    'sizes' => $sizes,
]);
echo $changed ? "資料有變動，版本更新\n" : "資料沒有變動\n";
