"""Extract CS 1.6 kill-feed weapon icons (the `d_<weapon>` death notices) to PNG.

The icons live as rectangles inside the HUD sprite sheets `sprites/640hud*.spr`; the
rects are listed in `sprites/hud.txt` as:  d_<name>  640  640hud<N>  x  y  w  h
This crops each 640-res rect and writes sprites/kill/<name>.png (white-on-transparent,
the killfeed tints them per team in CSS). Run from the project root: python tools/extract_kill_icons.py
"""
import struct, zlib, os, sys
from pathlib import Path

try:
    from config import CSTRIKE_PATH
except Exception:
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from config import CSTRIKE_PATH

SPR_DIR = Path(CSTRIKE_PATH) / "sprites"
OUT_DIR = Path(__file__).parent.parent / "sprites" / "kill"

def write_png(path, w, h, rgba_rows):
    def chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', c)
    raw = b''.join(b'\x00' + row for row in rgba_rows)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))

# Decode the FIRST frame of a .spr to (width, height, [r,g,b,a] per pixel as a flat list).
_spr_cache = {}
def load_spr(name):
    if name in _spr_cache:
        return _spr_cache[name]
    path = SPR_DIR / (name + ".spr")
    data = path.read_bytes()
    pos = 0
    assert data[pos:pos+4] == b'IDSP', f"{path} not a SPR"
    pos += 4
    pos += 4                                   # version
    pos += 4                                   # type
    texfmt = struct.unpack_from('<i', data, pos)[0]; pos += 4   # 0 normal,1 add,2 indexalpha,3 alphatest
    pos += 4 + 4 + 4                           # radius, maxw, maxh
    pos += 4                                   # num_frames
    pos += 4 + 4                               # beam length, sync
    ncolors = struct.unpack_from('<H', data, pos)[0]; pos += 2
    palette = [(data[pos+i*3], data[pos+i*3+1], data[pos+i*3+2]) for i in range(ncolors)]
    pos += ncolors * 3
    # first frame
    ftype = struct.unpack_from('<i', data, pos)[0]; pos += 4
    if ftype != 0:                             # grouped frame → skip the group header
        gc = struct.unpack_from('<i', data, pos)[0]; pos += 4 + gc * 4
    pos += 4 + 4                               # origin x,y
    w = struct.unpack_from('<i', data, pos)[0]; pos += 4
    h = struct.unpack_from('<i', data, pos)[0]; pos += 4
    px = data[pos:pos + w*h]
    white = palette[255] if ncolors > 255 else (255, 255, 255)
    out = []
    for idx in px:
        r, g, b = palette[idx]
        if texfmt == 2:                        # index-alpha: solid colour, alpha = index
            out.append((white[0], white[1], white[2], idx))
        elif texfmt == 1:                      # ADDITIVE: black bg adds nothing → alpha = brightness
            out.append((r, g, b, max(r, g, b)))
        elif idx == 255:                       # normal/alphatest mask colour → transparent
            out.append((0, 0, 0, 0))
        else:
            out.append((r, g, b, 255))
    _spr_cache[name] = (w, h, out)
    return _spr_cache[name]

def crop_png(spr, x, y, cw, ch, out_path):
    w, h, px = load_spr(spr)
    rows = []
    for ry in range(ch):
        row = bytearray()
        for rx in range(cw):
            sx, sy = x + rx, y + ry
            if 0 <= sx < w and 0 <= sy < h:
                r, g, b, a = px[sy*w + sx]
            else:
                r = g = b = a = 0
            row += bytes([r, g, b, a])
        rows.append(bytes(row))
    write_png(out_path, cw, ch, rows)

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    hud = (SPR_DIR / "hud.txt").read_text(errors='ignore').splitlines()
    n = 0
    for line in hud:
        parts = line.split()
        if len(parts) < 7 or not parts[0].lower().startswith('d_'):
            continue
        name, res, spr, x, y, cw, ch = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
        if res != '640':
            continue
        try:
            crop_png(spr, int(x), int(y), int(cw), int(ch), OUT_DIR / f"{name}.png")
            print(f"  {name}.png  {cw}x{ch}  from {spr} @ {x},{y}")
            n += 1
        except Exception as e:
            print(f"  (skip {name}: {e})")
    print(f"{n} kill icons -> {OUT_DIR}")

if __name__ == '__main__':
    main()
