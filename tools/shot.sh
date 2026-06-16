#!/bin/bash
# Headless screenshot of the game for visual verification.
# Usage: bash tools/shot.sh "test=1&team=ct&wpn=m4&fire" m4fire
#   arg1 = viewer.html query string (autotest flags), arg2 = output name (default "shot")
# Output: /d/Code/my_cs/_<name>.png  (readable with the Read tool)
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
Q="$1"; OUT="${2:-shot}"
"$CHROME" --headless=new --hide-scrollbars --window-size=1100,620 \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist \
  --screenshot="/tmp/_$OUT.png" --virtual-time-budget=20000 \
  "http://localhost:8080/viewer.html?$Q" 2>/dev/null
cp "/tmp/_$OUT.png" "/d/Code/my_cs/_$OUT.png" 2>/dev/null && echo "d:/Code/my_cs/_$OUT.png"
