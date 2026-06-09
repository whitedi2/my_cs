"""Start local server and open the map viewer in browser."""
import http.server
import webbrowser
import threading
import os

PORT = 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_): pass  # suppress request log spam

def open_browser():
    webbrowser.open(f"http://localhost:{PORT}/viewer.html")

print(f"Serving at http://localhost:{PORT}/viewer.html")
print("Press Ctrl+C to stop.\n")

threading.Timer(0.5, open_browser).start()
http.server.HTTPServer(("", PORT), Handler).serve_forever()
