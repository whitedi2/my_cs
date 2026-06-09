"""
GoldSrc BSP v30 -> OBJ + MTL + PNG textures + lightmap vertex colors (lm.bin)
Uses adaptive midpoint subdivision to sample the lightmap at luxel density,
giving smooth per-pixel-quality gradients via dense Gouraud shading.
"""
import struct, re, sys, math
from pathlib import Path
from PIL import Image
from collections import defaultdict
import array as _array

LUMP_ENTITIES = 0; LUMP_PLANES = 1; LUMP_TEXTURES = 2; LUMP_VERTICES = 3
LUMP_VISIBILITY = 4; LUMP_NODES = 5; LUMP_TEXINFO = 6; LUMP_FACES = 7
LUMP_LIGHTING = 8; LUMP_CLIPNODES = 9; LUMP_LEAVES = 10
LUMP_MARKSURFACES = 11; LUMP_EDGES = 12; LUMP_SURFEDGES = 13; LUMP_MODELS = 14

SKIP_TEXTURES = {'sky', 'trigger', 'aaatrigger', 'clip', 'hint', 'skip', 'null', 'nodraw'}
MAX_DEPTH = 2   # max subdivision depth (4^depth triangles per original)

# ---------------------------------------------------------------------------
# BSP parsing
# ---------------------------------------------------------------------------

def lump(data, index):
    off, length = struct.unpack_from('<II', data, 4 + index * 8)
    return off, length

def parse_vertices(data, off, length):
    return [struct.unpack_from('<fff', data, off + i*12) for i in range(length // 12)]

def parse_edges(data, off, length):
    return [struct.unpack_from('<HH', data, off + i*4) for i in range(length // 4)]

def parse_surfedges(data, off, length):
    return [struct.unpack_from('<i', data, off + i*4)[0] for i in range(length // 4)]

def parse_faces(data, off, length):
    faces = []
    for i in range(length // 20):
        base = off + i * 20
        _, _, first_edge, num_edges, texinfo = struct.unpack_from('<HHIhh', data, base)
        lightofs, = struct.unpack_from('<i', data, base + 16)
        faces.append((first_edge, num_edges, texinfo, lightofs))
    return faces

def parse_texinfo(data, off, length):
    result = []
    for i in range(length // 40):
        base = off + i * 40
        sx, sy, sz, sd = struct.unpack_from('<ffff', data, base)
        tx, ty, tz, td = struct.unpack_from('<ffff', data, base + 16)
        miptex, flags  = struct.unpack_from('<II',   data, base + 32)
        result.append(((sx,sy,sz), sd, (tx,ty,tz), td, miptex, flags))
    return result

def parse_bsp_textures(data, off, length):
    if length == 0:
        return {}, []
    num, = struct.unpack_from('<I', data, off)
    name_list, tex_dict = [], {}
    for i in range(num):
        tex_off, = struct.unpack_from('<i', data, off + 4 + i*4)
        if tex_off < 0:
            name_list.append('__unknown__'); continue
        abs_off = off + tex_off
        name = data[abs_off:abs_off+16].split(b'\x00')[0].decode('ascii', errors='replace').lower()
        w, h = struct.unpack_from('<II', data, abs_off + 16)
        mip0_off, = struct.unpack_from('<I', data, abs_off + 24)
        name_list.append(name)
        if mip0_off == 0:
            tex_dict[name] = (w, h, None); continue
        pixels    = data[abs_off + mip0_off : abs_off + mip0_off + w*h]
        mip_bytes = w*h + (w//2)*(h//2) + (w//4)*(h//4) + (w//8)*(h//8)
        pal_start = abs_off + mip0_off + mip_bytes + 2
        palette   = data[pal_start:pal_start + 768]
        tex_dict[name] = (w, h, miptex_to_image(pixels, w, h, palette))
    return tex_dict, name_list

def parse_entities(data, off, length):
    text = data[off:off+length].decode('ascii', errors='replace')
    m = re.search(r'"wad"\s+"([^"]+)"', text)
    return m.group(1) if m else ''

# ---------------------------------------------------------------------------
# WAD3
# ---------------------------------------------------------------------------

def load_wad(wad_path):
    try:
        with open(wad_path, 'rb') as f:
            data = f.read()
    except (FileNotFoundError, PermissionError):
        return {}
    if data[:4] != b'WAD3':
        return {}
    num_dirs, dir_offset = struct.unpack_from('<II', data, 4)
    textures = {}
    for i in range(num_dirs):
        base = dir_offset + i * 32
        file_pos, disk_size, size, tex_type, _ = struct.unpack_from('<IIIBb', data, base)
        name = data[base+16:base+32].split(b'\x00')[0].decode('ascii', errors='replace').lower()
        if tex_type != 0x43:
            continue
        mip = data[file_pos:file_pos + size]
        w, h = struct.unpack_from('<II', mip, 16)
        mip0_off, = struct.unpack_from('<I', mip, 24)
        pixels    = mip[mip0_off:mip0_off + w*h]
        mip_bytes = w*h + (w//2)*(h//2) + (w//4)*(h//4) + (w//8)*(h//8)
        pal_start = mip0_off + mip_bytes + 2
        palette   = mip[pal_start:pal_start + 768]
        textures[name] = (w, h, miptex_to_image(pixels, w, h, palette))
    return textures

def miptex_to_image(pixels, w, h, palette):
    img = Image.new('RGB', (w, h))
    pal = [(palette[j*3], palette[j*3+1], palette[j*3+2]) for j in range(256)]
    pix = img.load()
    for y in range(h):
        for x in range(w):
            pix[x, y] = pal[pixels[y*w + x]]
    return img

# ---------------------------------------------------------------------------
# Lightmap sampling + subdivision
# ---------------------------------------------------------------------------

def linear_to_srgb(c):
    c = max(0.0, min(1.0, c))
    if c <= 0.0031308:
        return 12.92 * c
    return 1.055 * (c ** (1.0/2.4)) - 0.055

def sample_lm(raw_s, raw_t, lm_data, lightofs, lm_w, lm_h, lm_ms, lm_mt):
    """Bilinear sample lightmap. Returns linear (r,g,b) in [0,1]."""
    if lightofs < 0:
        return (1.0, 1.0, 1.0)
    ls = max(0.0, min(float(lm_w - 1), (raw_s - lm_ms) / 16.0))
    lt = max(0.0, min(float(lm_h - 1), (raw_t - lm_mt) / 16.0))
    ix = int(ls); iy = int(lt)
    fx = ls - ix;  fy = lt - iy
    ix1 = min(ix+1, lm_w-1); iy1 = min(iy+1, lm_h-1)

    def px(x, y):
        idx = lightofs + (y * lm_w + x) * 3
        if idx + 2 < len(lm_data):
            # GoldSrc overbright 2: raw 128 -> 1.0 linear
            return (lm_data[idx]/128.0, lm_data[idx+1]/128.0, lm_data[idx+2]/128.0)
        return (1.0, 1.0, 1.0)

    p00=px(ix,iy); p10=px(ix1,iy); p01=px(ix,iy1); p11=px(ix1,iy1)
    r = p00[0]*(1-fx)*(1-fy) + p10[0]*fx*(1-fy) + p01[0]*(1-fx)*fy + p11[0]*fx*fy
    g = p00[1]*(1-fx)*(1-fy) + p10[1]*fx*(1-fy) + p01[1]*(1-fx)*fy + p11[1]*fx*fy
    b = p00[2]*(1-fx)*(1-fy) + p10[2]*fx*(1-fy) + p01[2]*(1-fx)*fy + p11[2]*fx*fy
    # OBJLoader calls .convertSRGBToLinear() on vertex colors, so we pre-encode
    # as sRGB for a correct round-trip: sRGB_to_linear(sRGB(L)) = L
    return (linear_to_srgb(min(1.0, r)), linear_to_srgb(min(1.0, g)), linear_to_srgb(min(1.0, b)))

def subdivide_tri(p0,p1,p2, s0,t0,s1,t1,s2,t2,
                  tex_w, tex_h,
                  lm_data, lightofs, lm_w, lm_h, lm_ms, lm_mt,
                  depth, out_v, out_uv, out_c):
    """
    Recursively subdivide triangle via midpoint split.
    Appends (x,y,z), (u,v), (r,g,b) to out_v, out_uv, out_c per vertex.
    """
    def emit(p, s, t):
        out_v.append((p[0], p[2], -p[1]))          # GoldSrc -> Y-up
        out_uv.append((s / tex_w, -(t / tex_h)))
        out_c.append(sample_lm(s, t, lm_data, lightofs, lm_w, lm_h, lm_ms, lm_mt))

    if depth <= 0:
        emit(p0, s0, t0); emit(p1, s1, t1); emit(p2, s2, t2)
        return

    def mid3(a, b): return ((a[0]+b[0])*0.5, (a[1]+b[1])*0.5, (a[2]+b[2])*0.5)
    pm01=mid3(p0,p1); sm01=(s0+s1)*0.5; tm01=(t0+t1)*0.5
    pm12=mid3(p1,p2); sm12=(s1+s2)*0.5; tm12=(t1+t2)*0.5
    pm02=mid3(p0,p2); sm02=(s0+s2)*0.5; tm02=(t0+t2)*0.5

    kw = dict(tex_w=tex_w, tex_h=tex_h,
              lm_data=lm_data, lightofs=lightofs,
              lm_w=lm_w, lm_h=lm_h, lm_ms=lm_ms, lm_mt=lm_mt,
              depth=depth-1, out_v=out_v, out_uv=out_uv, out_c=out_c)
    subdivide_tri(p0,  pm01, pm02, s0,  t0,  sm01,tm01, sm02,tm02, **kw)
    subdivide_tri(pm01,p1,  pm12,  sm01,tm01, s1,  t1,  sm12,tm12, **kw)
    subdivide_tri(pm02,pm12,p2,    sm02,tm02, sm12,tm12, s2,  t2,  **kw)
    subdivide_tri(pm01,pm12,pm02,  sm01,tm01, sm12,tm12, sm02,tm02,**kw)

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def face_polygon(face, surfedges, edges):
    first_edge, num_edges = face[0], face[1]
    poly = []
    for i in range(num_edges):
        se = surfedges[first_edge + i]
        poly.append(edges[se][0] if se >= 0 else edges[-se][1])
    return poly

def compute_face_extents(poly_verts, S, Sd, T, Td):
    s_vals = [vx*S[0]+vy*S[1]+vz*S[2]+Sd for vx,vy,vz in poly_verts]
    t_vals = [vx*T[0]+vy*T[1]+vz*T[2]+Td for vx,vy,vz in poly_verts]
    EPS = 1e-4
    bmins_s = int(math.floor(min(s_vals)/16 + EPS))
    bmins_t = int(math.floor(min(t_vals)/16 + EPS))
    bmaxs_s = int(math.ceil (max(s_vals)/16 - EPS))
    bmaxs_t = int(math.ceil (max(t_vals)/16 - EPS))
    w = max(1, bmaxs_s - bmins_s + 1)
    h = max(1, bmaxs_t - bmins_t + 1)
    return bmins_s*16, bmins_t*16, w, h

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def convert(bsp_path, out_dir):
    print(f"Reading {bsp_path}")
    with open(bsp_path, 'rb') as f:
        data = f.read()

    version, = struct.unpack_from('<I', data, 0)
    if version != 30:
        print(f"  Warning: expected v30, got v{version}")

    vertices  = parse_vertices (data, *lump(data, LUMP_VERTICES))
    edges     = parse_edges    (data, *lump(data, LUMP_EDGES))
    surfedges = parse_surfedges(data, *lump(data, LUMP_SURFEDGES))
    faces     = parse_faces    (data, *lump(data, LUMP_FACES))
    texinfos  = parse_texinfo  (data, *lump(data, LUMP_TEXINFO))
    bsp_texs, tex_name_list = parse_bsp_textures(data, *lump(data, LUMP_TEXTURES))
    wad_str   = parse_entities (data, *lump(data, LUMP_ENTITIES))

    lm_off, lm_len = lump(data, LUMP_LIGHTING)
    lightmap = data[lm_off:lm_off + lm_len]
    print(f"  Vertices:{len(vertices)}  Faces:{len(faces)}  "
          f"Textures:{len(bsp_texs)}  Lightmap:{lm_len//3} luxels")

    # WAD loading
    cstrike_dir = Path(bsp_path).parents[1]
    hl_dir      = Path(bsp_path).parents[2]
    wad_dirs    = [p.resolve() for p in [cstrike_dir, hl_dir/'valve', hl_dir/'cstrike'] if p.exists()]

    referenced_wads = []
    if wad_str:
        for w in wad_str.split(';'):
            name = Path(w.strip().replace('\\', '/')).name
            if name: referenced_wads.append(name)

    wad_db = {}
    for wname in referenced_wads:
        for d in wad_dirs:
            p = d / wname
            if p.exists() and p.is_file():
                before = len(wad_db)
                wad_db.update(load_wad(str(p)))
                if len(wad_db) > before:
                    print(f"  WAD {wname}: +{len(wad_db)-before}")
                break

    missing = [n for n,(w,h,img) in bsp_texs.items() if img is None and n not in wad_db]
    if missing:
        print(f"  Scanning WADs for {len(missing)} missing textures...")
        for d in wad_dirs:
            for wf in Path(d).glob('*.wad'):
                if wf.is_file():
                    before = len(wad_db)
                    wad_db.update(load_wad(str(wf)))
                    if len(wad_db) > before:
                        print(f"  WAD {wf.name}: +{len(wad_db)-before}")

    textures = {}
    for name, (w, h, img) in bsp_texs.items():
        if img is not None:  textures[name] = (w, h, img)
        elif name in wad_db: textures[name] = wad_db[name]
        else:                textures[name] = (64, 64, None)

    tex_dir = Path(out_dir) / 'textures'
    tex_dir.mkdir(exist_ok=True)
    saved = 0
    for name, (w, h, img) in textures.items():
        png = tex_dir / f"{name}.png"
        if img is not None and not png.exists():
            img.save(str(png)); saved += 1
    print(f"  Textures: {saved} PNGs")

    stem = Path(bsp_path).stem
    out  = Path(out_dir)

    with open(out / f"{stem}.mtl", 'w') as mf:
        for name in textures:
            mf.write(f"newmtl {name}\n  Ka 1 1 1\n  Kd 1 1 1\n  map_Kd textures/{name}.png\n\n")

    # Build geometry with adaptive subdivision
    all_v  = []   # (nx, ny, nz) – Y-up
    all_uv = []   # (u, v)
    all_c  = []   # (r, g, b) sRGB lightmap color
    # groups: tex -> [(v_start, n_verts)]  (n_verts always multiple of 3)
    groups = defaultdict(list)
    v_cursor = uv_cursor = 1

    for face in faces:
        first_edge, num_edges, ti_idx, lightofs = face
        if ti_idx < 0 or ti_idx >= len(texinfos):
            continue
        S, Sd, T, Td, miptex, _flags = texinfos[ti_idx]
        if miptex >= len(tex_name_list):
            continue
        tex_name = tex_name_list[miptex]
        if any(tex_name.startswith(s) for s in SKIP_TEXTURES):
            continue

        w, h, _ = textures.get(tex_name, (64, 64, None))
        if not w or not h: w = h = 64

        poly = face_polygon(face, surfedges, edges)
        if len(poly) < 3: continue

        poly_verts = [vertices[vi] for vi in poly]
        lm_ms, lm_mt, lm_w, lm_h = compute_face_extents(poly_verts, S, Sd, T, Td)

        # Raw S/T for each polygon vertex
        raw_s = [vx*S[0]+vy*S[1]+vz*S[2]+Sd for vx,vy,vz in poly_verts]
        raw_t = [vx*T[0]+vy*T[1]+vz*T[2]+Td for vx,vy,vz in poly_verts]

        face_v = []; face_uv = []; face_c = []

        for i in range(1, len(poly) - 1):
            # Fan triangle: vertex 0, i, i+1
            p0,p1,p2   = poly_verts[0], poly_verts[i], poly_verts[i+1]
            s0,s1,s2   = raw_s[0],      raw_s[i],      raw_s[i+1]
            t0,t1,t2   = raw_t[0],      raw_t[i],      raw_t[i+1]

            # Adaptive depth: match lightmap luxel density
            ls0=(s0-lm_ms)/16; lt0=(t0-lm_mt)/16
            ls1=(s1-lm_ms)/16; lt1=(t1-lm_mt)/16
            ls2=(s2-lm_ms)/16; lt2=(t2-lm_mt)/16
            max_edge = max(math.hypot(ls1-ls0,lt1-lt0),
                           math.hypot(ls2-ls1,lt2-lt1),
                           math.hypot(ls0-ls2,lt0-lt2))
            depth = max(0, min(MAX_DEPTH, int(math.ceil(math.log2(max(max_edge, 1.0))))))

            subdivide_tri(p0,p1,p2, s0,t0,s1,t1,s2,t2,
                          w, h,
                          lightmap, lightofs, lm_w, lm_h, lm_ms, lm_mt,
                          depth, face_v, face_uv, face_c)

        n = len(face_v)
        if n == 0: continue

        groups[tex_name].append((v_cursor, n))
        all_v  += face_v
        all_uv += face_uv
        all_c  += face_c
        v_cursor  += n
        uv_cursor += n

    # Write OBJ
    obj_path = out / f"{stem}.obj"

    print(f"  Writing OBJ ({len(all_v)} verts, {len(groups)} materials)...")
    total_tris = 0

    # Vertex colors are embedded directly in the OBJ as "v x y z r g b".
    # Three.js r125+ OBJLoader parses this into a 'color' BufferAttribute,
    # eliminating any need for a separate binary and avoiding ordering bugs.
    with open(obj_path, 'w') as of:
        of.write(f"# {stem}.bsp\nmtllib {stem}.mtl\n\n")
        for (x,y,z),(r,g,b) in zip(all_v, all_c):
            of.write(f"v {x:.3f} {y:.3f} {z:.3f} {r:.4f} {g:.4f} {b:.4f}\n")
        of.write("\n")
        for u,v in all_uv:
            of.write(f"vt {u:.6f} {v:.6f}\n")
        of.write("\n")
        for tex, seg_list in groups.items():
            of.write(f"usemtl {tex}\ng {tex}\n")
            for v_start, n_verts in seg_list:
                for i in range(0, n_verts, 3):
                    a=v_start+i; b=a+1; c=a+2
                    of.write(f"f {a}/{a} {b}/{b} {c}/{c}\n")
                    total_tris += 1

    print(f"  Done: {total_tris} triangles, {len(all_c)} verts (colors embedded) -> {obj_path}")
    print(f"\nRun serve.py to view in browser.")


if __name__ == '__main__':
    bsp = sys.argv[1] if len(sys.argv) > 1 else \
        r"D:\SteamLibrary\steamapps\common\Half-Life\cstrike\maps\de_dust2.bsp"
    out = sys.argv[2] if len(sys.argv) > 2 else r"d:\Code\my_cs"
    convert(bsp, out)
