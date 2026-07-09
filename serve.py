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

    def copyfile(self, source, outputfile):
        # The browser routinely aborts asset downloads it no longer needs (cancelled
        # audio fetches, range re-requests, reloads). On Windows that surfaces as
        # ConnectionAbortedError/Reset in shutil.copyfileobj — harmless, so swallow it
        # instead of dumping a scary traceback per cancelled request.
        try:
            super().copyfile(source, outputfile)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

def open_browser():
    webbrowser.open(f"http://localhost:{PORT}/viewer.html")

print(f"Serving at http://localhost:{PORT}/viewer.html")
print("Press Ctrl+C to stop.\n")

threading.Timer(0.5, open_browser).start()
# ThreadingHTTPServer: the browser opens many parallel requests for assets (sounds,
# textures, models). A single-threaded HTTPServer serialises them and drops connections
# under load, so sounds/assets fail to load ("no sounds"). Threaded = concurrent.
http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
