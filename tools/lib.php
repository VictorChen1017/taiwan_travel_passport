<?php
// 匯出工具共用：讀 .env（只取 PG_*）、連線 PostGIS（唯讀）
// .env 位置：環境變數 FOG_ENV，預設為舊專案的 .env

function fog_env(): array
{
    $path = getenv('FOG_ENV') ?: __DIR__ . '/../../photo_monitor_ver202611/.env';
    if (!is_file($path)) throw new RuntimeException("找不到 .env：$path（可用環境變數 FOG_ENV 指定）");
    $env = [];
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (preg_match('/^\s*(PG_[A-Z_]+)\s*=\s*(.*)$/', $line, $m)) $env[$m[1]] = trim($m[2], " \t\"'");
    }
    return $env;
}

function fog_pg(): PDO
{
    $e = fog_env();
    $pdo = new PDO(sprintf('pgsql:host=%s;port=%s;dbname=%s', $e['PG_HOST'] ?? 'localhost', $e['PG_PORT'] ?? '5432', $e['PG_NAME'] ?? 'photo_monitor'),
                   $e['PG_USER'] ?? 'postgres', $e['PG_PASS'] ?? '',
                   [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec('SET default_transaction_read_only = on');   // 匯出只讀，不寫入資料庫
    return $pdo;
}
