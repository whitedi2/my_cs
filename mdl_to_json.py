"""
GoldSrc MDL v10 → JSON + PNG textures
Exports v_knife.json with mesh in Three.js coordinate space (same as BSP exporter).
"""
import struct, json, math, sys
from pathlib import Path

# Accept weapon name as positional arg; optional --pose <seqname>; optional --out <filename>; optional --mdl <full_path>.
weapon_name = 'knife'
pose_override = None   # e.g. 'idle_unsil'
out_override  = None   # e.g. 'v_usp_sil.json'
mdl_override  = None   # full path to .mdl file
_args = sys.argv[1:]
i = 0
while i < len(_args):
    if _args[i] == '--pose' and i + 1 < len(_args):
        pose_override = _args[i + 1]; i += 2
    elif _args[i] == '--out' and i + 1 < len(_args):
        out_override = _args[i + 1]; i += 2
    elif _args[i] == '--mdl' and i + 1 < len(_args):
        mdl_override = _args[i + 1]; i += 2
    elif not _args[i].startswith('-'):
        _stem = Path(_args[i]).stem
        weapon_name = _stem[2:] if _stem.startswith('v_') else _stem
        i += 1
    else:
        i += 1

if mdl_override:
    MDL_PATH = Path(mdl_override)
else:
    try:
        from config import CSTRIKE_PATH
        MDL_PATH = Path(CSTRIKE_PATH) / "models" / f"v_{weapon_name}.mdl"
    except Exception:
        MDL_PATH = Path(f"v_{weapon_name}.mdl")

if not MDL_PATH.exists():
    sys.exit(f"MDL not found: {MDL_PATH}")

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("Pillow not installed — textures skipped")

OUT_DIR = Path(__file__).parent
(OUT_DIR / "textures").mkdir(exist_ok=True)

raw = MDL_PATH.read_bytes()

# ── Unpack helpers ─────────────────────────────────────────────────────────
def i32(o):  return struct.unpack_from('<i',  raw, o)[0]
def u16(o):  return struct.unpack_from('<H',  raw, o)[0]
def s16(o):  return struct.unpack_from('<h',  raw, o)[0]
def f32(o):  return struct.unpack_from('<f',  raw, o)[0]
def f3(o):   return struct.unpack_from('<3f', raw, o)
def f6(o):   return struct.unpack_from('<6f', raw, o)
def cstr(o, n): return raw[o:o+n].split(b'\x00')[0].decode('latin1')

# ── Validate ───────────────────────────────────────────────────────────────
assert raw[0:4] == b'IDST', "Not a GoldSrc studio model"
assert i32(4) == 10, f"Unsupported MDL version {i32(4)}"

print(f"MDL: {cstr(8, 64)!r}")

# ── Header offsets ─────────────────────────────────────────────────────────
# studiohdr_t layout (offsets after id/version/name/length):
#   eyepos(12) min(12) max(12) bbmin(12) bbmax(12) flags(4) = 64 bytes at 76
#   Then pairs: nbones(4)+obones(4), nbonecon+obonecon, nhitbox+ohitbox,
#               nseq+oseq, nseqgrp+oseqgrp, ntex+otex+otexdata,
#               nskinref+nskinfam+oskin, nbody+obody, ...
NBONES   = i32(140); OBONES   = i32(144)
NSEQ     = i32(164); OSEQ     = i32(168)
NTEX     = i32(180); OTEX     = i32(184)
NSKINREF = i32(192); NSKINFAM = i32(196); OSKIN = i32(200)
NBODY    = i32(204); OBODY    = i32(208)

print(f"  bones={NBONES}  seqs={NSEQ}  textures={NTEX}  bodyparts={NBODY}")

# ── Skin table: NSKINFAM × NSKINREF int16 entries ─────────────────────────
def skin_tex(skinref, fam=0):
    return u16(OSKIN + (fam * NSKINREF + skinref) * 2)

# ── Bones: 112 bytes each ──────────────────────────────────────────────────
# name[32] parent(4) flags(4) bonecontroller[6×4] value[6×4] scale[6×4]
BONE_SZ = 112
bones = []
for i in range(NBONES):
    o = OBONES + i * BONE_SZ
    bones.append({
        'name':   cstr(o, 32),
        'parent': i32(o + 32),
        'val':    list(f6(o + 64)),   # tx,ty,tz,rx,ry,rz
        'scale':  list(f6(o + 88)),
    })

# ── Decode frame 0 of a sequence into per-bone [tx,ty,tz,rx,ry,rz] ───────
# mstudioseqdesc_t: label[32] fps(4) flags(4) activity(4) actweight(4)
#   numevents(4) eventidx(4) numframes@56 numpivots(4) pivotidx(4)
#   motiontype(4) motionbone(4) linearmovement(12)
#   automoveposidx(4) automoveangleidx(4) bbmin(12) bbmax(12)
#   numblends@120 animindex@124 ...
SEQ_SZ = 176

def read_seq_names():
    names = []
    for si in range(NSEQ):
        names.append(cstr(OSEQ + si * SEQ_SZ, 32))
    return names

seq_names = read_seq_names()
print(f"  Sequences: {seq_names}")

def decode_frame0(seq_idx):
    """Decode frame 0 of sequence seq_idx, return per-bone [tx,ty,tz,rx,ry,rz]."""
    os_  = OSEQ + seq_idx * SEQ_SZ
    seqgroup  = i32(os_ + 156)
    if seqgroup != 0:
        print(f"  WARNING: seq {seq_idx} is demand-loaded (seqgroup={seqgroup}), using ref pose")
        return [b['val'] for b in bones]
    numframes  = i32(os_ + 56)
    animindex  = i32(os_ + 124)
    pose = []
    for b in range(NBONES):
        bone      = bones[b]
        anim_base = animindex + b * 12   # 12 bytes = 6 × uint16 offsets
        vals = []
        for dof in range(6):
            off = u16(anim_base + dof * 2)
            if off == 0:
                vals.append(bone['val'][dof])
            else:
                pos = anim_base + off
                valid = raw[pos]
                delta = s16(pos + 2) if valid > 0 else 0
                vals.append(bone['val'][dof] + bone['scale'][dof] * delta)
        pose.append(vals)
    return pose

# Pick bind-pose sequence: --pose override, or first 'idle', or seq 0
if pose_override:
    idle_idx = next((i for i, n in enumerate(seq_names) if n.lower() == pose_override.lower()), None)
    if idle_idx is None:
        sys.exit(f"--pose {pose_override!r} not found in sequences: {seq_names}")
else:
    idle_idx = next((i for i, n in enumerate(seq_names) if n.lower() == 'idle'), 0)
print(f"  Using sequence {idle_idx} ({seq_names[idle_idx]!r}) frame 0 for mesh pose")
use_pose = decode_frame0(idle_idx)

# ── Reference-pose bone world transforms ──────────────────────────────────
def euler_mat(rx, ry, rz):
    """GoldSrc MDL bone rotation via Half-Life SDK AngleQuaternion → matrix."""
    # Matches hlsdk AngleQuaternion(angles, q) where angles[0]=rx, [1]=ry, [2]=rz
    sr, cr = math.sin(rx * 0.5), math.cos(rx * 0.5)
    sp, cp = math.sin(ry * 0.5), math.cos(ry * 0.5)
    sy, cy = math.sin(rz * 0.5), math.cos(rz * 0.5)
    qx = sr*cp*cy - cr*sp*sy
    qy = cr*sp*cy + sr*cp*sy
    qz = cr*cp*sy - sr*sp*cy
    qw = cr*cp*cy + sr*sp*sy
    # Row-major 3×3 matrix from unit quaternion (standard formula)
    return [
        [1-2*(qy*qy+qz*qz),   2*(qx*qy-qw*qz),   2*(qx*qz+qw*qy)],
        [2*(qx*qy+qw*qz),     1-2*(qx*qx+qz*qz), 2*(qy*qz-qw*qx)],
        [2*(qx*qz-qw*qy),     2*(qy*qz+qw*qx),   1-2*(qx*qx+qy*qy)],
    ]

def compose(Ra, ta, Rb, tb):
    Rc = [[sum(Ra[r][k]*Rb[k][c] for k in range(3)) for c in range(3)] for r in range(3)]
    tc = [ta[j] + sum(Ra[j][k]*tb[k] for k in range(3)) for j in range(3)]
    return Rc, tc

def xform_pt(R, t, p):
    return [t[i] + sum(R[i][k]*p[k] for k in range(3)) for i in range(3)]

def xform_n(R, n):
    return [sum(R[i][k]*n[k] for k in range(3)) for i in range(3)]

bone_R = [None] * NBONES
bone_t = [None] * NBONES
for i, pose_vals in enumerate(use_pose):
    tx, ty, tz, rx, ry, rz = pose_vals
    R = euler_mat(rx, ry, rz)
    t = [tx, ty, tz]
    par = bones[i]['parent']
    if par >= 0 and bone_R[par] is not None:
        R, t = compose(bone_R[par], bone_t[par], R, t)
    bone_R[i], bone_t[i] = R, t

# ── Textures: 80 bytes each ────────────────────────────────────────────────
# name[64] flags(4) width(4) height(4) index(4)
TEX_SZ = 80
textures_out = []

for i in range(NTEX):
    o      = OTEX + i * TEX_SZ
    tname  = cstr(o, 64)
    flags  = i32(o + 64)
    width  = i32(o + 68)
    height = i32(o + 72)
    tidx   = i32(o + 76)

    safe = tname.replace('/', '_').replace('\\', '_').strip()
    rel  = f"textures/{weapon_name}_{i}_{safe}.png"
    textures_out.append({'name': tname, 'width': width, 'height': height, 'file': rel})

    if HAS_PIL and width > 0 and height > 0:
        pix = raw[tidx : tidx + width * height]
        pal = raw[tidx + width*height : tidx + width*height + 768]
        masked = bool(flags & 0x40)
        if masked:
            img = Image.new('RGBA', (width, height))
            pixels = []
            for idx in pix:
                r, g, b = pal[idx*3], pal[idx*3+1], pal[idx*3+2]
                pixels.append((r, g, b, 0 if (r < 8 and g < 8 and b < 8) else 255))
        else:
            img = Image.new('RGB', (width, height))
            pixels = [(pal[idx*3], pal[idx*3+1], pal[idx*3+2]) for idx in pix]
        img.putdata(pixels)
        img.save(str(OUT_DIR / rel))
        print(f"  Texture {i}: {tname!r} ({width}x{height}){' [masked]' if masked else ''}")

# ── Body parts → meshes ────────────────────────────────────────────────────
# mstudiobodyparts_t: name[64] nummodels(4) base(4) modelindex(4) = 76 bytes
# mstudiomodel_t:    name[64] type(4) bndrad(4)
#   nummesh(4) meshidx(4) numv(4) vinfoidx(4) vidx(4)
#   numn(4) ninfoidx(4) nidx(4) numgrp(4) grpidx(4)  = 112 bytes
# mstudiomesh_t:     numtris(4) triidx(4) skinref(4) numnorms(4) normidx(4) = 20 bytes
BODYPART_SZ = 76
MODEL_SZ    = 112
MESH_SZ     = 20

out_meshes  = []

for bp in range(NBODY):
    obp  = OBODY + bp * BODYPART_SZ
    moff = i32(obp + 72)   # offset to first sub-model

    om          = moff
    nummesh     = i32(om + 72);  meshoff = i32(om + 76)
    numverts    = i32(om + 80);  vinfoff = i32(om + 84);  voff = i32(om + 88)
    numnorms    = i32(om + 92);  ninfoff = i32(om + 96);  noff = i32(om + 100)

    raw_v  = [f3(voff + j*12) for j in range(numverts)]
    vbone  = [raw[vinfoff + j] for j in range(numverts)]
    raw_n  = [f3(noff  + j*12) for j in range(numnorms)]
    nbone  = [raw[ninfoff + j] for j in range(numnorms)]

    for mi in range(nummesh):
        om2      = meshoff + mi * MESH_SZ
        triindex = i32(om2 + 4)
        skinref  = i32(om2 + 8)

        tidx = skin_tex(skinref)
        tw   = textures_out[tidx]['width']
        th   = textures_out[tidx]['height']

        positions, normals, uvs, indices = [], [], [], []
        vert_map = {}
        off2     = triindex

        while True:
            count = s16(off2); off2 += 2
            if count == 0:
                break
            is_fan = count < 0
            count  = abs(count)

            tv = []
            for _ in range(count):
                vi = s16(off2); ni = s16(off2+2); s = s16(off2+4); t = s16(off2+6)
                off2 += 8
                key = (vi, ni, s, t)
                if key not in vert_map:
                    vert_map[key] = len(positions) // 3
                    # Transform to world (model) space
                    wp = xform_pt(bone_R[vbone[vi]], bone_t[vbone[vi]], raw_v[vi])
                    wn = xform_n (bone_R[nbone[ni]], raw_n[ni])
                    # GoldSrc → Three.js: same as BSP exporter (x, z, -y)
                    positions.extend([ wp[0],  wp[2], -wp[1]])
                    normals.extend(  [ wn[0],  wn[2], -wn[1]])
                    uvs.extend([s / tw, 1.0 - t / th])
                tv.append(vert_map[key])

            # Triangulate strip or fan
            if is_fan:
                for k in range(1, count - 1):
                    indices.extend([tv[0], tv[k], tv[k+1]])
            else:
                for k in range(count - 2):
                    if k & 1:
                        indices.extend([tv[k+1], tv[k],   tv[k+2]])
                    else:
                        indices.extend([tv[k],   tv[k+1], tv[k+2]])

        if indices:
            # Build bone index array - one per vertex, in same order as vert_map keys
            bone_indices = [vbone[vi] for (vi, ni, s, t) in vert_map.keys()]
            out_meshes.append({
                'positions': [round(v, 3) for v in positions],
                'normals':   [round(v, 4) for v in normals],
                'uvs':       [round(v, 5) for v in uvs],
                'indices':   indices,
                'texFile':   textures_out[tidx]['file'],
                'boneIndices': bone_indices,
            })
            nverts = len(positions) // 3
            px_list = positions[0::3]; py_list = positions[1::3]; pz_list = positions[2::3]
            bb = (min(px_list), max(px_list), min(py_list), max(py_list), min(pz_list), max(pz_list))
            print(f"  Mesh {mi}: {len(indices)//3} tris  tex={textures_out[tidx]['name']!r}"
                  f"  X[{bb[0]:.1f},{bb[1]:.1f}] Y[{bb[2]:.1f},{bb[3]:.1f}] Z[{bb[4]:.1f},{bb[5]:.1f}]")

# ── Bounding box (for scale hint) ──────────────────────────────────────────
if out_meshes:
    all_pos = []
    for m in out_meshes:
        p = m['positions']
        all_pos.extend([(p[i], p[i+1], p[i+2]) for i in range(0, len(p), 3)])
    xs = [v[0] for v in all_pos]; ys = [v[1] for v in all_pos]; zs = [v[2] for v in all_pos]
    bbox = {'min': [min(xs),min(ys),min(zs)], 'max': [max(xs),max(ys),max(zs)]}
    size = [bbox['max'][i]-bbox['min'][i] for i in range(3)]
    print(f"  Bounding box size: {size[0]:.1f} x {size[1]:.1f} x {size[2]:.1f} units")
else:
    bbox = None

# ── Write JSON ─────────────────────────────────────────────────────────────
result = {
    'meshes':    out_meshes,
    'textures':  textures_out,
    'bbox':      bbox,
}
out_path = OUT_DIR / (out_override if out_override else f"v_{weapon_name}.json")
with open(out_path, 'w') as fh:
    json.dump(result, fh, separators=(',', ':'))
size_kb = out_path.stat().st_size // 1024
print(f"\nDone: {out_path}  ({size_kb} KB)")
print("Run: python serve.py  — then reload the viewer")
