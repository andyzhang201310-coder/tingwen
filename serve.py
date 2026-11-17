"""听文 TingWen · 本地预览服务器

Windows 上 Python 自带的 http.server 会把 .js 当成 text/plain，
导致 ES Module 加载失败。这个脚本显式声明 MIME，避免踩坑。

用法：
    python serve.py            # 默认 http://127.0.0.1:8778
    python serve.py 9000       # 指定端口
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8778


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".css": "text/css",
        ".html": "text/html",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


# 用多线程版本：单线程 server 在浏览器并行请求时会把连接堆在 backlog 里，
# 表现为部分 JS 请求 ERR_CONNECTION_REFUSED。
http.server.ThreadingHTTPServer.allow_reuse_address = True
with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"听文 TingWen 原型已启动: http://127.0.0.1:{PORT}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
