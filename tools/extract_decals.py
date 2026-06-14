"""Extract GoldSrc decal textures from WAD3 file to PNG."""
import struct, zlib, os

PY = "C:/Users/white/AppData/Local/Programs/Python/Python311/python.exe"

def write_png(path, w, h, rgba_rows):
    def chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', c)
    raw = b''.join(b'\x00' + row for row in rgba_rows)
    img_data = zlib.compress(raw, 9)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', img_data))
        f.write(chunk(b'IEND', b''))

def extract_wad_textures(wad_path, names_filter, outdir):
    with open(wad_path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'WAD3'
    num_lumps  = struct.unpack_from('<i', data, 4)[0]
    dir_offset = struct.unpack_from('<i', data, 8)[0]

    os.makedirs(outdir, exist_ok=True)

    for i in range(num_lumps):
        off      = dir_offset + i * 32
        file_pos = struct.unpack_from('<i', data, off)[0]
        lump_type= struct.unpack_from('<B', data, off+10)[0]
        name     = data[off+16:off+32].rstrip(b'\x00').decode('ascii', errors='replace')

        if name not in names_filter:
            continue

        # WAD3 type 0x43 = mip texture
        # Header: name(16) + w(4) + h(4) + mip_offsets(4*4)
        base = file_pos
        tex_name = data[base:base+16].rstrip(b'\x00').decode('ascii', errors='replace')
        w = struct.unpack_from('<I', data, base+16)[0]
        h = struct.unpack_from('<I', data, base+20)[0]
        mip0_off = struct.unpack_from('<I', data, base+24)[0]  # offset from base

        pixels = data[base + mip0_off : base + mip0_off + w * h]

        # Palette is after all 4 mip levels: mip0 + mip1(w/2*h/2) + mip2(w/4*h/4) + mip3(w/8*h/8) + 2 bytes count
        mip_total = w*h + (w//2)*(h//2) + (w//4)*(h//4) + (w//8)*(h//8)
        pal_off = base + mip0_off + mip_total + 2  # +2 for palette count short
        palette = [(data[pal_off+j*3], data[pal_off+j*3+1], data[pal_off+j*3+2]) for j in range(256)]
        transparent_color = palette[255]  # index 255 = transparent for { textures

        # GoldSrc gunshot decals are grayscale masks rendered with MULTIPLY blend:
        # dark = darkens wall (the hole), white = leaves wall unchanged.
        # Contrast-stretch so the dark core deepens and the soft gray halo goes to
        # pure white — otherwise the halo reads as a faint translucent square.
        LO, HI = 15, 235   # lum<=LO → black, lum>=HI → white; wide range keeps a soft, blurred edge
        rows = []
        for y in range(h):
            row = bytearray()
            for x in range(w):
                idx = pixels[y * w + x]
                r, g, b = palette[idx]
                lum = (r * 77 + g * 150 + b * 29) >> 8
                if   lum <= LO: out = 0
                elif lum >= HI: out = 255
                else:           out = int((lum - LO) * 255 / (HI - LO))
                row += bytes([out, out, out, 255])
            rows.append(bytes(row))

        safe_name = name.replace('{', '').replace('/', '_')
        out_path = os.path.join(outdir, safe_name + '.png')
        write_png(out_path, w, h, rows)
        print(f"  {name} -> {out_path}  ({w}x{h})")

wad_path = "D:/SteamLibrary/steamapps/common/Half-Life/cstrike/decals.wad"
out_dir  = "d:/Code/my_cs/decals/"

targets = (
    ["{shot"    + str(i) for i in range(1, 6)] +
    ["{bigshot" + str(i) for i in range(1, 6)]
)

print("Extracting decals...")
extract_wad_textures(wad_path, targets, out_dir)
print("Done.")
