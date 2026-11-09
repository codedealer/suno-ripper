#!/usr/bin/env python3
"""Persistent local receiver: POST body -> file in browser-downloads/. Keeps running for repeated captures."""
import http.server, os, sys
from urllib.parse import unquote

OUT_DIR = "/home/msi/projects/suno-ripper/.orca/browser-downloads"

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        # Client percent-encodes the name (headers must stay latin-1).
        name = unquote(self.headers.get("X-Filename", "capture.bin"))
        # sanitize
        name = os.path.basename(name)
        body = self.rfile.read(length)
        path = os.path.join(OUT_DIR, name)
        with open(path, "wb") as f:
            f.write(body)
        resp = ("OK " + str(len(body)) + " " + name).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
        print(f"saved {len(body)} bytes -> {path}", flush=True)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-Filename, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def log_message(self, *a):
        pass

srv = http.server.HTTPServer(("127.0.0.1", 8765), H)
print("listening on 127.0.0.1:8765", flush=True)
srv.serve_forever()
print("done", flush=True)