"""
GoldSrc world weapon MDL (p_<weapon>.mdl) → bundled JSON for hand attachment.

p_* models share the player skeleton (Bip01 …) — the gun mesh is weighted to
the hand bones. To render the gun in third-person we drive ITS skeleton with the
player model's current animation (matched by bone name) and skin the mesh.

Output: models/p_<weapon>.json  { meshes, bones, bindFrame }  (+ textures/p_*).
Run from project root, e.g.:
    python tools/pweapon_to_json.py p_m4a1 --mdl "D:/…/models/p_m4a1.mdl"
"""
import struct, json, math, sys
from pathlib import Path

name = 'p_m4a1'
mdl_override = None
_args = sys.argv[1:]
i = 0
while i < len(_args):
    if _args[i] == '--mdl' and i + 1 < len(_args):
        mdl_override = _args[i + 1]; i += 2
    elif not _args[i].startswith('-'):
        name = _args[i]; i += 1
    else:
        i += 1

if mdl_override:
    MDL_PATH = Path(mdl_override)
else:
    try:
        from config import CSTRIKE_PATH
        MDL_PATH = Path(CSTRIKE_PATH) / "models" / f"{name}.mdl"
    except Exception:
        MDL_PATH = Path(f"{name}.mdl")
if not MDL_PATH.exists():
    sys.exit(f"MDL not found: {MDL_PATH}")

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

OUT_DIR = Path(__file__).parent.parent
(OUT_DIR / "textures").mkdir(exist_ok=True)
(OUT_DIR / "models").mkdir(exist_ok=True)
raw = MDL_PATH.read_bytes()

def i32(o):  return struct.unpack_from('<i',  raw, o)[0]
def u16(o):  return struct.unpack_from('<H',  raw, o)[0]
def s16(o):  return struct.unpack_from('<h',  raw, o)[0]
def f32(o):  return struct.unpack_from('<f',  raw, o)[0]
def f3(o):   return struct.unpack_from('<3f', raw, o)
def f6(o):   return struct.unpack_from('<6f', raw, o)
def cstr(o, n): return raw[o:o+n].split(b'\x00')[0].decode('latin1')

assert raw[0:4] == b'IDST' and i32(4) == 10, "Not a GoldSrc v10 studio model"
NBONES   = i32(140); OBONES   = i32(144)
NSEQ     = i32(164); OSEQ     = i32(168)
NTEX     = i32(180); OTEX     = i32(184)
NSKINREF = i32(192); NSKINFAM = i32(196); OSKIN = i32(200)
NBODY    = i32(204); OBODY    = i32(208)

BONE_SZ = 112
bones = []
for i in range(NBONES):
    o = OBONES + i * BONE_SZ
    bones.append({'name': cstr(o, 32), 'parent': i32(o + 32),
                  'val': [round(v, 6) for v in f6(o + 64)],
                  'scale': [round(v, 8) for v in f6(o + 88)]})

# Bind frame = sequence 0 frame 0 (decode the RLE, fall back to bone defaults).
SEQ_SZ = 176
def decode_frame0():
    os_ = OSEQ
    if NSEQ == 0 or i32(os_ + 156) != 0:
        return [b['val'][:] for b in bones]
    animindex = i32(os_ + 124)
    pose = []
    for b in range(NBONES):
        anim_base = animindex + b * 12
        vals = []
        for dof in range(6):
            off = u16(anim_base + dof * 2)
            if off == 0:
                vals.append(bones[b]['val'][dof]); continue
            rle = anim_base + off
            valid = raw[rle]
            delta = s16(rle + 2) if valid > 0 else 0
            vals.append(bones[b]['val'][dof] + bones[b]['scale'][dof] * delta)
        pose.append(vals)
    return pose
bind_pose = decode_frame0()

def euler_mat(rx, ry, rz):
    sr, cr = math.sin(rx*.5), math.cos(rx*.5); sp, cp = math.sin(ry*.5), math.cos(ry*.5); sy, cy = math.sin(rz*.5), math.cos(rz*.5)
    qx = sr*cp*cy-cr*sp*sy; qy = cr*sp*cy+sr*cp*sy; qz = cr*cp*sy-sr*sp*cy; qw = cr*cp*cy+sr*sp*sy
    return [[1-2*(qy*qy+qz*qz),2*(qx*qy-qw*qz),2*(qx*qz+qw*qy)],
            [2*(qx*qy+qw*qz),1-2*(qx*qx+qz*qz),2*(qy*qz-qw*qx)],
            [2*(qx*qz-qw*qy),2*(qy*qz+qw*qx),1-2*(qx*qx+qy*qy)]]
def compose(Ra, ta, Rb, tb):
    Rc = [[sum(Ra[r][k]*Rb[k][c] for k in range(3)) for c in range(3)] for r in range(3)]
    tc = [ta[j] + sum(Ra[j][k]*tb[k] for k in range(3)) for j in range(3)]
    return Rc, tc
def xform_pt(R, t, p): return [t[i] + sum(R[i][k]*p[k] for k in range(3)) for i in range(3)]
def xform_n(R, n):     return [sum(R[i][k]*n[k] for k in range(3)) for i in range(3)]

bone_R = [None]*NBONES; bone_t = [None]*NBONES
for i, pv in enumerate(bind_pose):
    R, t = euler_mat(pv[3], pv[4], pv[5]), [pv[0], pv[1], pv[2]]
    par = bones[i]['parent']
    if par >= 0 and bone_R[par] is not None:
        R, t = compose(bone_R[par], bone_t[par], R, t)
    bone_R[i], bone_t[i] = R, t

# Textures
TEX_SZ = 80
textures_out = []
for i in range(NTEX):
    o = OTEX + i*TEX_SZ
    tname = cstr(o, 64); flags = i32(o+64); width = i32(o+68); height = i32(o+72); tidx = i32(o+76)
    safe = tname.replace('/', '_').replace('\\', '_').strip()
    rel = f"textures/{name}_{i}_{safe}.png"
    textures_out.append({'name': tname, 'width': width, 'height': height, 'file': rel})
    if HAS_PIL and width > 0 and height > 0:
        pix = raw[tidx:tidx+width*height]; pal = raw[tidx+width*height:tidx+width*height+768]
        masked = bool(flags & 0x40)
        if masked:
            img = Image.new('RGBA', (width, height))
            data = [(pal[p*3], pal[p*3+1], pal[p*3+2], 0 if (pal[p*3]<8 and pal[p*3+1]<8 and pal[p*3+2]<8) else 255) for p in pix]
        else:
            img = Image.new('RGB', (width, height))
            data = [(pal[p*3], pal[p*3+1], pal[p*3+2]) for p in pix]
        img.putdata(data); img.save(str(OUT_DIR / rel))

def skin_tex(skinref, fam=0): return u16(OSKIN + (fam*NSKINREF + skinref)*2)

# Mesh (bodypart 0, first sub-model)
BODYPART_SZ = 76; MODEL_SZ = 112; MESH_SZ = 20
obp = OBODY
om  = i32(obp + 72)
nummesh = i32(om+72); meshoff = i32(om+76)
numverts = i32(om+80); vinfoff = i32(om+84); voff = i32(om+88)
numnorms = i32(om+92); ninfoff = i32(om+96); noff = i32(om+100)
raw_v = [f3(voff+j*12) for j in range(numverts)]
vbone = [raw[vinfoff+j] for j in range(numverts)]
raw_n = [f3(noff+j*12) for j in range(numnorms)]
nbone = [raw[ninfoff+j] for j in range(numnorms)]

out_meshes = []
for mi in range(nummesh):
    om2 = meshoff + mi*MESH_SZ
    triindex = i32(om2+4); skinref = i32(om2+8)
    tidx = skin_tex(skinref); tw, th = textures_out[tidx]['width'], textures_out[tidx]['height']
    positions, normals, uvs, indices = [], [], [], []
    vert_map = {}; off2 = triindex
    while True:
        count = s16(off2); off2 += 2
        if count == 0: break
        is_fan = count < 0; count = abs(count)
        tv = []
        for _ in range(count):
            vi = s16(off2); ni = s16(off2+2); s = s16(off2+4); t = s16(off2+6); off2 += 8
            key = (vi, ni, s, t)
            if key not in vert_map:
                vert_map[key] = len(positions)//3
                wp = xform_pt(bone_R[vbone[vi]], bone_t[vbone[vi]], raw_v[vi])
                wn = xform_n(bone_R[nbone[ni]], raw_n[ni])
                positions.extend([wp[0], wp[2], -wp[1]]); normals.extend([wn[0], wn[2], -wn[1]])
                uvs.extend([s/tw, 1.0 - t/th])
            tv.append(vert_map[key])
        if is_fan:
            for k in range(1, count-1): indices.extend([tv[0], tv[k], tv[k+1]])
        else:
            for k in range(count-2): indices.extend([tv[k+1], tv[k], tv[k+2]] if k & 1 else [tv[k], tv[k+1], tv[k+2]])
    if indices:
        out_meshes.append({'positions': [round(v,3) for v in positions], 'normals': [round(v,4) for v in normals],
                           'uvs': [round(v,5) for v in uvs], 'indices': indices,
                           'texFile': textures_out[tidx]['file'],
                           'boneIndices': [vbone[vi] for (vi, ni, s, t) in vert_map.keys()]})

result = {'name': name, 'meshes': out_meshes, 'textures': textures_out,
          'bones': bones, 'bindFrame': [[round(v, 6) for v in pv] for pv in bind_pose]}
out_path = OUT_DIR / "models" / f"{name}.json"
with open(out_path, 'w') as fh:
    json.dump(result, fh, separators=(',', ':'))
print(f"Done: {out_path} ({out_path.stat().st_size//1024} KB)  bones={len(bones)} meshes={len(out_meshes)}")
