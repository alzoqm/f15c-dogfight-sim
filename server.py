"""F-15 시뮬레이터 로컬 개발 서버 (캐시 비활성화). 실행: python server.py [port]"""
import http.server
import socketserver
import sys
import os
import re

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8615
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    # 대결 기록 저장 (src/recorder.js → rl/data/human/<이름>.json). 로컬 전용
    def do_POST(self):
        if not self.path.startswith('/rec?name='):
            self.send_response(404); self.end_headers(); return
        name = re.sub(r'[^A-Za-z0-9_.-]', '_', self.path.split('name=', 1)[1])[:120]
        if not name.endswith('.json'):
            name += '.json'
        n = int(self.headers.get('Content-Length', 0))
        if n <= 0 or n > 50_000_000:
            self.send_response(413); self.end_headers(); return
        out = os.path.join('rl', 'data', 'human')
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, name), 'wb') as f:
            f.write(self.rfile.read(n))
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')


socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), NoCacheHandler) as httpd:
    print(f'F-15 sim: http://localhost:{PORT}/', flush=True)
    httpd.serve_forever()
