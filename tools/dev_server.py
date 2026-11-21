"""開發用靜態伺服器：和 GitHub Pages 一樣只提供檔案（不執行 PHP），但完全不快取，改了 JS／CSS 重新整理就生效

用法（在 photo_fog_static 資料夾）：
    python tools/dev_server.py          # http://127.0.0.1:8765/
    python tools/dev_server.py 9000     # 指定埠號

- 只綁 127.0.0.1（本機才連得到）；127.0.0.1 算安全環境，資料夾選擇、module Worker 都能用
- 正式上線時 GitHub Pages 會快取 10 分鐘，改版仍要更新 index.html 的版本參數（?v=）
- POST /__save?path=img/xxx.webp：dev/sample.html 用來存首頁範例圖；只能寫 img/ 底下的 .webp／.png，正式網站沒有這個功能
"""
import http.server
import os
import re
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        rel = urllib.parse.parse_qs(u.query).get('path', [''])[0]
        if u.path != '/__save' or not re.fullmatch(r'img/[A-Za-z0-9_-]+\.(webp|png)', rel):
            self.send_error(403)
            return
        n = int(self.headers.get('Content-Length') or 0)
        if not 0 < n <= 20 * 1024 * 1024:
            self.send_error(400)
            return
        dest = os.path.join(ROOT, *rel.split('/'))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            f.write(self.rfile.read(n))
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # 只記錄錯誤，避免每個圖資請求都印一行
        if len(args) > 1 and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler) as httpd:
        print(f'開發伺服器：http://127.0.0.1:{port}/（不快取；Ctrl+C 停止）', flush=True)
        httpd.serve_forever()
