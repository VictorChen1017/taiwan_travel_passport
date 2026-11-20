<?php
// 開發用：從原專案取測試資料，供 dev/compare.html 比對計算結果（第 2 階段驗收）
//
//   C:/xampp/php/php.exe tools/dev/export_legacy_test.php
//
// 輸出到 test/legacy/（test/ 已被 git 忽略，內含個人位置資料，不可提交）：
//   photos.json        原專案 Postgres photos 的座標與時間（只讀）
//   stats.json         原專案 explore_stats.php?type=stats
//   detail/<id>.json   原專案每個有明細的成就的 type=detail
// 原專案網址可用環境變數 FOG_LEGACY_URL 指定（預設 http://localhost/repo/photo_monitor_ver202611/）

require __DIR__ . '/../lib.php';
ini_set('serialize_precision', '-1');

$out = __DIR__ . '/../../test/legacy';
@mkdir("$out/detail", 0775, true);
$base = getenv('FOG_LEGACY_URL') ?: 'http://localhost/repo/photo_monitor_ver202611/';

$pg = fog_pg();
$lat = []; $lng = []; $time = [];
foreach ($pg->query('SELECT ST_Y(geom) AS lat, ST_X(geom) AS lng, time FROM photos WHERE geom IS NOT NULL ORDER BY id') as $r) {
    $lat[] = (float)$r['lat']; $lng[] = (float)$r['lng'];
    $time[] = $r['time'] === null ? null : (int)$r['time'];
}
file_put_contents("$out/photos.json", json_encode(['lat' => $lat, 'lng' => $lng, 'time' => $time]));
echo '照片 ' . count($lat) . " 筆\n";

$t = time();
$stats = file_get_contents($base . 'dashboard/explore_stats.php?type=stats');
$s = json_decode($stats, true);
if (!$s || empty($s['ok'])) exit("無法取得原專案 stats（Apache 有開嗎？）\n");
file_put_contents("$out/stats.json", json_encode($s + ['_now' => $t + 14 * 3600], JSON_UNESCAPED_UNICODE));
$n = 0;
foreach ($s['achievements'] as $a) {
    if (empty($a['detail'])) continue;
    $d = file_get_contents($base . 'dashboard/explore_stats.php?type=detail&id=' . urlencode($a['id']));
    file_put_contents("$out/detail/{$a['id']}.json", $d);
    $n++;
}
echo "成就 " . count($s['achievements']) . "、明細 $n\n";
