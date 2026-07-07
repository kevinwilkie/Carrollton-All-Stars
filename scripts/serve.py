#!/usr/bin/env python3
"""Static file server with no-cache headers (handy for local preview/testing).
Usage: python3 scripts/serve.py [port]   — serves the project root:
  http://localhost:8000/        season app
  http://localhost:8000/draft/  draft board
For real hosting use Netlify (see SETUP.md)."""
import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Serving on http://localhost:{PORT}")
    httpd.serve_forever()
