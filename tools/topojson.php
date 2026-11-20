<?php
// 簡易 TopoJSON 編碼器（共用界線只存一次、座標量化成整數差值）
//
// 用法：topo_encode(['id1' => GeoJSON 幾何, ...], 'villages', 1e5)
//   → TopoJSON 陣列（type Topology、transform、arcs、objects.<名稱> 為 GeometryCollection，每個幾何帶 id）
//
// 演算法（同 topojson 的 join／cut／dedup）：
// 1. 先量化座標（scale 1e5 ≈ 1.1 公尺），移除連續重複點；量化後不足 3 個不同點的環丟掉
// 2. 統計每個點的相鄰點；相鄰點超過 2 個的點是「接點」（界線在這裡分岔）
// 3. 每個環在接點處切成弧；沒有接點的環整圈當一條弧
// 4. 相同的弧（正向或反向）只存一次，反向引用以 ~i 表示
// 解碼後的每個環與量化後的原始環逐點相同（topo_verify 檢查）

function topo_quantize_rings(array $geom, float $scale, float $x0, float $y0): array
{
    // 回傳 [多邊形 => [環 => [[x, y], ...]]]（環不重複首尾點）
    $polys = $geom['type'] === 'Polygon' ? [$geom['coordinates']] : ($geom['type'] === 'MultiPolygon' ? $geom['coordinates'] : []);
    $out = [];
    foreach ($polys as $poly) {
        $rings = [];
        foreach ($poly as $ri => $ring) {
            $pts = [];
            foreach ($ring as [$x, $y]) {
                $p = [(int)round(($x - $x0) * $scale), (int)round(($y - $y0) * $scale)];
                if ($pts && end($pts) === $p) continue;
                $pts[] = $p;
            }
            if (count($pts) > 1 && $pts[0] === end($pts)) array_pop($pts);
            if (count(array_unique(array_map(fn($p) => "$p[0],$p[1]", $pts))) < 3) {
                if ($ri === 0) { $rings = []; break; }   // 外環太小：整個多邊形丟掉
                continue;
            }
            $rings[] = $pts;
        }
        if ($rings) $out[] = $rings;
    }
    return $out;
}

function topo_encode(array $geoms, string $objectName, float $scale = 1e5): array
{
    // 範圍與平移量（取到量化格點，解碼時 x = q / scale + x0）
    $x0 = INF; $y0 = INF; $x1 = -INF; $y1 = -INF;
    foreach ($geoms as $g) {
        foreach (($g['type'] === 'Polygon' ? [$g['coordinates']] : $g['coordinates']) as $poly) {
            foreach ($poly as $ring) foreach ($ring as [$x, $y]) {
                $x0 = min($x0, $x); $y0 = min($y0, $y); $x1 = max($x1, $x); $y1 = max($y1, $y);
            }
        }
    }
    $x0 = floor($x0 * $scale) / $scale;
    $y0 = floor($y0 * $scale) / $scale;

    // 1. 量化
    $q = [];
    foreach ($geoms as $id => $g) $q[$id] = topo_quantize_rings($g, $scale, $x0, $y0);

    // 2. 相鄰點統計：key => [相鄰點 key => true]（只需知道是否超過 2 個）
    $nb = [];
    foreach ($q as $polys) foreach ($polys as $rings) foreach ($rings as $pts) {
        $n = count($pts);
        for ($i = 0; $i < $n; $i++) {
            $k = $pts[$i][0] . ',' . $pts[$i][1];
            $a = $pts[($i - 1 + $n) % $n]; $b = $pts[($i + 1) % $n];
            $s = &$nb[$k];
            $s ??= [];
            if (count($s) <= 2) { $s[$a[0] . ',' . $a[1]] = true; $s[$b[0] . ',' . $b[1]] = true; }
            unset($s);
        }
    }
    $isJunction = fn(array $p) => count($nb[$p[0] . ',' . $p[1]]) > 2;

    // 3、4. 切弧、去重複
    $arcs = []; $index = [];   // 弧的 key（點序列）=> 弧編號
    $keyOf = fn(array $pts) => implode(';', array_map(fn($p) => "$p[0],$p[1]", $pts));
    $addArc = function (array $pts) use (&$arcs, &$index, $keyOf): int {
        $k = $keyOf($pts);
        if (isset($index[$k])) return $index[$k];
        $rk = $keyOf(array_reverse($pts));
        if (isset($index[$rk])) return ~$index[$rk];
        $index[$k] = count($arcs);
        $arcs[] = $pts;
        return count($arcs) - 1;
    };
    // 整圈的弧：旋轉到最小點開始，正反兩向都試
    $rotateMin = function (array $pts): array {
        $mi = 0;
        foreach ($pts as $i => $p) if ($p[0] < $pts[$mi][0] || ($p[0] === $pts[$mi][0] && $p[1] < $pts[$mi][1])) $mi = $i;
        $r = array_merge(array_slice($pts, $mi), array_slice($pts, 0, $mi));
        $r[] = $r[0];
        return $r;
    };

    $geometries = [];
    foreach ($q as $id => $polys) {
        $topoPolys = [];
        foreach ($polys as $rings) {
            $topoRings = [];
            foreach ($rings as $pts) {
                $n = count($pts);
                $junctions = [];
                for ($i = 0; $i < $n; $i++) if ($isJunction($pts[$i])) $junctions[] = $i;
                if (!$junctions) {
                    $fwd = $rotateMin($pts);
                    $rev = $rotateMin(array_reverse($pts));
                    $kf = $keyOf($fwd); $kr = $keyOf($rev);
                    if (isset($index[$kf])) $topoRings[] = [$index[$kf]];
                    elseif (isset($index[$kr])) $topoRings[] = [~$index[$kr]];
                    else $topoRings[] = [$addArc($fwd)];
                    continue;
                }
                // 從第一個接點開始，依接點切段（每段含兩端接點）
                $refs = [];
                $m = count($junctions);
                for ($j = 0; $j < $m; $j++) {
                    $a = $junctions[$j];
                    $b = $j + 1 < $m ? $junctions[$j + 1] : $junctions[0] + $n;
                    $seg = [];
                    for ($i = $a; $i <= $b; $i++) $seg[] = $pts[$i % $n];
                    $refs[] = $addArc($seg);
                }
                $topoRings[] = $refs;
            }
            if ($topoRings) $topoPolys[] = $topoRings;
        }
        if (!$topoPolys) continue;
        $geometries[] = count($topoPolys) === 1
            ? ['type' => 'Polygon', 'id' => (string)$id, 'arcs' => $topoPolys[0]]
            : ['type' => 'MultiPolygon', 'id' => (string)$id, 'arcs' => $topoPolys];
    }

    // 差值編碼
    $encoded = [];
    foreach ($arcs as $pts) {
        $e = []; $px = 0; $py = 0;
        foreach ($pts as [$x, $y]) { $e[] = [$x - $px, $y - $py]; $px = $x; $py = $y; }
        $encoded[] = $e;
    }

    return [
        'type' => 'Topology',
        'transform' => ['scale' => [1 / $scale, 1 / $scale], 'translate' => [$x0, $y0]],
        'bbox' => [$x0, $y0, $x1, $y1],
        'objects' => [$objectName => ['type' => 'GeometryCollection', 'geometries' => $geometries]],
        'arcs' => $encoded,
        '_q' => $q,   // 驗證用，輸出前移除
    ];
}

/** 解碼後逐環比對量化座標；回傳不一致的幾何 id 清單 */
function topo_verify(array $topo, string $objectName): array
{
    // 解差值
    $arcs = [];
    foreach ($topo['arcs'] as $e) {
        $x = 0; $y = 0; $pts = [];
        foreach ($e as [$dx, $dy]) { $x += $dx; $y += $dy; $pts[] = [$x, $y]; }
        $arcs[] = $pts;
    }
    $ring = function (array $refs) use ($arcs): array {
        $out = [];
        foreach ($refs as $r) {
            $pts = $r >= 0 ? $arcs[$r] : array_reverse($arcs[~$r]);
            if ($out) array_shift($pts);
            $out = array_merge($out, $pts);
        }
        array_pop($out);   // 去掉閉合點
        return $out;
    };
    // 環以「循環序列」比對：旋轉到相同起點
    $same = function (array $a, array $b): bool {
        if (count($a) !== count($b)) return false;
        $k = array_search($b[0], $a, true);
        if ($k === false) return false;
        $r = array_merge(array_slice($a, $k), array_slice($a, 0, $k));
        return $r === $b;
    };
    $bad = [];
    foreach ($topo['objects'][$objectName]['geometries'] as $g) {
        $polys = $g['type'] === 'Polygon' ? [$g['arcs']] : $g['arcs'];
        $orig = $topo['_q'][$g['id']];
        if (count($polys) !== count($orig)) { $bad[] = $g['id']; continue; }
        foreach ($polys as $pi => $rings) {
            if (count($rings) !== count($orig[$pi])) { $bad[] = $g['id']; continue 2; }
            foreach ($rings as $ri => $refs) {
                if (!$same($ring($refs), $orig[$pi][$ri])) { $bad[] = $g['id']; continue 3; }
            }
        }
    }
    return $bad;
}
