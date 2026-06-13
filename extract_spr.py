"""Extract GoldSrc .spr sprite frames to PNG (no external deps)."""
import struct, zlib, os, sys

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

def extract_spr(filepath, outdir):
    with open(filepath, 'rb') as f:
        data = f.read()
    pos = 0

    assert data[pos:pos+4] == b'IDSP', "Not a SPR file"
    pos += 4
    version  = struct.unpack_from('<i', data, pos)[0]; pos += 4
    _type    = struct.unpack_from('<i', data, pos)[0]; pos += 4
    texfmt   = struct.unpack_from('<i', data, pos)[0]; pos += 4  # 0=normal,1=additive,2=indexalpha,3=alphatest
    pos += 4  # bounding radius
    pos += 4  # max width
    pos += 4  # max height
    num_frames = struct.unpack_from('<i', data, pos)[0]; pos += 4
    pos += 4  # beam length
    pos += 4  # sync type

    num_colors = struct.unpack_from('<H', data, pos)[0]; pos += 2
    palette = [(data[pos+i*3], data[pos+i*3+1], data[pos+i*3+2]) for i in range(num_colors)]
    pos += num_colors * 3

    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(filepath))[0]
    frame_idx = 0

    for _ in range(num_frames):
        frame_type = struct.unpack_from('<i', data, pos)[0]; pos += 4
        if frame_type == 0:
            sub_frames = [None]  # placeholder
        else:
            group_count = struct.unpack_from('<i', data, pos)[0]; pos += 4
            pos += group_count * 4  # skip intervals
            sub_frames = list(range(group_count))

        for _ in (sub_frames):
            ox = struct.unpack_from('<i', data, pos)[0]; pos += 4
            oy = struct.unpack_from('<i', data, pos)[0]; pos += 4
            w  = struct.unpack_from('<i', data, pos)[0]; pos += 4
            h  = struct.unpack_from('<i', data, pos)[0]; pos += 4
            pixels = data[pos:pos + w * h]; pos += w * h

            rows = []
            for y in range(h):
                row = bytearray()
                for x in range(w):
                    idx = pixels[y * w + x]
                    r, g, b = palette[idx]
                    if texfmt == 2:        # index-alpha: idx = alpha, color from palette
                        a = idx
                    elif idx == 255:       # mask color for normal/additive/alphatest
                        a = 0
                    else:
                        a = 255
                    row += bytes([r, g, b, a])
                rows.append(bytes(row))

            out = os.path.join(outdir, f"{base}_{frame_idx:02d}.png")
            write_png(out, w, h, rows)
            print(f"  {out}  {w}x{h}  fmt={texfmt}")
            frame_idx += 1

    print(f"{filepath}: {frame_idx} frames extracted")

sprites_src = "D:/SteamLibrary/steamapps/common/Half-Life/cstrike/sprites/"
out_dir     = "d:/Code/my_cs/sprites/"

for name in ["muzzleflash1.spr", "muzzleflash2.spr", "muzzleflash3.spr", "muzzleflash4.spr"]:
    extract_spr(os.path.join(sprites_src, name), out_dir)
