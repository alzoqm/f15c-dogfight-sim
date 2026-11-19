"""시험 데이터 수신용 로컬 서버 (브라우저 → rl/data/<name>). 실행: python rl/recv.py [port]"""
import http.server, os, sys, re
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8616
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(OUT, exist_ok=True)
class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        name = re.sub(r'[^A-Za-z0-9_.-]', '_', self.path.split('?name=')[-1]) or 'out.json'
        n = int(self.headers.get('Content-Length', 0))
        with open(os.path.join(OUT, name), 'wb') as f: f.write(self.rfile.read(n))
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
