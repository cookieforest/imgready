"""Throwaway static server + POST /__save endpoint.

Only reason it exists: the icon PNGs have to be rasterised in a browser
(Node here has no SVG rasteriser and no font stack), and shuttling ~40 KB
of base64 back through the agent transcript is both wasteful and easy to
corrupt. This lets the page POST the bytes straight to disk.

Writes are confined to ROOT and to a fixed allowlist of filenames.
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8801

ALLOWED = {
    "fonts/nunito-latin.woff2",
    "fonts/fredoka-latin.woff2",
    "favicon.ico",
    "favicon-16.png",
    "favicon-32.png",
    "favicon-48.png",
    "apple-touch-icon.png",
    "icon-192.png",
    "icon-512.png",
    "icon-192-maskable.png",
    "icon-512-maskable.png",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.path != "/__save":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length))
        written = []
        for name, b64 in payload.items():
            if name not in ALLOWED:
                self.send_error(400, "not allowed: %s" % name)
                return
            import base64
            dest = os.path.join(ROOT, name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(base64.b64decode(b64))
            written.append("%s (%d bytes)" % (name, os.path.getsize(dest)))
        body = json.dumps({"written": written}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
