"""Start local server and open the map viewer in browser."""
import http.server
import webbrowser
import threading
import os

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_): pass  # suppress request log spam
    def end_headers(self):
        # Dev server: cache assets but ALWAYS revalidate before use. 'no-cache' keeps
        # the file in the browser cache (speed) yet forces an If-Modified-Since check
        # each load — the server answers a tiny 304 when unchanged, or sends the new
        # bytes when it changed. So edits never get masked by a stale copy (a cached
        # 8-bit footstep wav once made steps sound low-rate for hours), without losing
        # caching. SimpleHTTPRequestHandler already sends Last-Modified / honors 304.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

def open_browser():
    webbrowser.open(f"http://localhost:{PORT}/viewer.html")

print(f"Serving at http://localhost:{PORT}/viewer.html")
print("Press Ctrl+C to stop.\n")

threading.Timer(0.5, open_browser).start()
http.server.HTTPServer(("", PORT), Handler).serve_forever()
