"""
GoldSrc player MDL v10 → bundled JSON (mesh + bones + movement animations).

Player models (cstrike/models/player/<name>/<name>.mdl) are full-body studio
models with all animation sequences embedded (seqgroup 0).  This tool extracts:
  • the body mesh (bodypart "studio"), baked at the bind-pose frame, with a
    per-vertex bone index — exactly like mdl_to_json.py does for view models;
  • the bone hierarchy (name/parent/val/scale);
  • only the MOVEMENT sequences we animate in third-person (idle/walk/run/…),
    decoded with the full RLE frame decoder from extract_anim.py.

Output: models/player_<name>.json  (+ body texture PNGs in textures/).

Usage (run from project root):
    python tools/player_to_json.py urban
    python tools/player_to_json.py --mdl "D:/…/player/urban/urban.mdl" --name urban
"""
import struct, json, math, sys
from pathlib import Path

# Movement sequences we actually drive in third-person. Bind pose = first entry.
WANTED_SEQS = ['idle1', 'crouch_idle', 'walk', 'run', 'crouchrun', 'jump', 'longjump']
DEATH_SEQS  = ['death1', 'death2', 'death3', 'head', 'gutshot', 'crouch_die']   # added with --deaths (enemy targets)
FLINCH_SEQS = ['head_flinch', 'gut_flinch']   # non-lethal hit reactions (with --deaths)
BIND_SEQ    = 'idle1'
if '--deaths' in sys.argv:
    WANTED_SEQS = WANTED_SEQS + DEATH_SEQS

# ── Args ────────────────────────────────────────────────────────────────────
name = 'urban'
mdl_override = None
_args = sys.argv[1:]
i = 0
while i < len(_args):
    if _args[i] == '--mdl' and i + 1 < len(_args):
        mdl_override = _args[i + 1]; i += 2
    elif _args[i] == '--name' and i + 1 < len(_args):
        name = _args[i + 1]; i += 2
    elif not _args[i].startswith('-'):
        name = _args[i]; i += 1
    else:
        i += 1

if mdl_override:
    MDL_PATH = Path(mdl_override)
else:
    try:
        from config import CSTRIKE_PATH
        MDL_PATH = Path(CSTRIKE_PATH) / "models" / "player" / name / f"{name}.mdl"
    except Exception:
        MDL_PATH = Path(f"{name}.mdl")

if not MDL_PATH.exists():
    sys.exit(f"MDL not found: {MDL_PATH}")

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("Pillow not installed — textures skipped")

OUT_DIR = Path(__file__).parent.parent
(OUT_DIR / "textures").mkdir(exist_ok=True)
(OUT_DIR / "models").mkdir(exist_ok=True)

raw = MDL_PATH.read_bytes()

# ── Unpack helpers ─────────────────────────────────────────────────────────
def i32(o):  return struct.unpack_from('<i',  raw, o)[0]
def u16(o):  return struct.unpack_from('<H',  raw, o)[0]
def s16(o):  return struct.unpack_from('<h',  raw, o)[0]
def f32(o):  return struct.unpack_from('<f',  raw, o)[0]
def f3(o):   return struct.unpack_from('<3f', raw, o)
def f6(o):   return struct.unpack_from('<6f', raw, o)
def cstr(o, n): return raw[o:o+n].split(b'\x00')[0].decode('latin1')

assert raw[0:4] == b'IDST', "Not a GoldSrc studio model"
assert i32(4) == 10, f"Unsupported MDL version {i32(4)}"
print(f"MDL: {cstr(8, 64)!r}")

NBONES   = i32(140); OBONES   = i32(144)
NSEQ     = i32(164); OSEQ     = i32(168)
NTEX     = i32(180); OTEX     = i32(184)
NSKINREF = i32(192); NSKINFAM = i32(196); OSKIN = i32(200)
NBODY    = i32(204); OBODY    = i32(208)
print(f"  bones={NBONES}  seqs={NSEQ}  textures={NTEX}  bodyparts={NBODY}")

# ── Bones (112 bytes each) ──────────────────────────────────────────────────
BONE_SZ = 112
bones = []
for i in range(NBONES):
    o = OBONES + i * BONE_SZ
    bones.append({
        'name':   cstr(o, 32),
        'parent': i32(o + 32),
        'val':    [round(v, 6) for v in f6(o + 64)],
        'scale':  [round(v, 8) for v in f6(o + 88)],
    })

# ── Sequence frame decoder (RLE, mstudioanimvalue_t) ───────────────────────
SEQ_SZ = 176

def seq_index(seqname):
    for si in range(NSEQ):
        if cstr(OSEQ + si * SEQ_SZ, 32).lower() == seqname.lower():
            return si
    return None

def decode_frame(seq_idx, frame_idx, blend=0):
    os_ = OSEQ + seq_idx * SEQ_SZ
    if i32(os_ + 156) != 0:   # seqgroup != 0 → demand-loaded, unsupported here
        return None
    numframes = i32(os_ + 56)
    if frame_idx >= numframes:
        return None
    # Blended sequences store numblends × NBONES anim blocks back-to-back; blend b
    # (the aim-pitch dimension) starts NBONES*12 bytes further in.
    animindex = i32(os_ + 124) + blend * NBONES * 12
    pose = []
    for b in range(NBONES):
        bone = bones[b]
        anim_base = animindex + b * 12   # 6 × u16 offsets
        vals = []
        for dof in range(6):
            off = u16(anim_base + dof * 2)
            if off == 0:
                vals.append(bone['val'][dof]); continue
            rle = anim_base + off
            k = frame_idx
            while True:
                valid = raw[rle]; total = raw[rle + 1]
                if total == 0: k = 0; break
                if k < total: break
                k -= total
                rle += (valid + 1) * 2
            valid = raw[rle]
            delta = s16(rle + 2 + (k if k < valid else valid - 1) * 2)
            vals.append(bone['val'][dof] + bone['scale'][dof] * delta)
        pose.append(vals)
    return pose

# ── Bind-pose bone world transforms (for baking the mesh) ──────────────────
def euler_mat(rx, ry, rz):
    sr, cr = math.sin(rx * 0.5), math.cos(rx * 0.5)
    sp, cp = math.sin(ry * 0.5), math.cos(ry * 0.5)
    sy, cy = math.sin(rz * 0.5), math.cos(rz * 0.5)
    qx = sr*cp*cy - cr*sp*sy; qy = cr*sp*cy + sr*cp*sy
    qz = cr*cp*sy - sr*sp*cy; qw = cr*cp*cy + sr*sp*sy
    return [
        [1-2*(qy*qy+qz*qz),   2*(qx*qy-qw*qz),   2*(qx*qz+qw*qy)],
        [2*(qx*qy+qw*qz),     1-2*(qx*qx+qz*qz), 2*(qy*qz-qw*qx)],
        [2*(qx*qz-qw*qy),     2*(qy*qz+qw*qx),   1-2*(qx*qx+qy*qy)],
    ]
def compose(Ra, ta, Rb, tb):
    Rc = [[sum(Ra[r][k]*Rb[k][c] for k in range(3)) for c in range(3)] for r in range(3)]
    tc = [ta[j] + sum(Ra[j][k]*tb[k] for k in range(3)) for j in range(3)]
    return Rc, tc
def xform_pt(R, t, p): return [t[i] + sum(R[i][k]*p[k] for k in range(3)) for i in range(3)]
def xform_n(R, n):     return [sum(R[i][k]*n[k] for k in range(3)) for i in range(3)]

bind_idx = seq_index(BIND_SEQ)
if bind_idx is None:
    sys.exit(f"Bind sequence {BIND_SEQ!r} not found")
bind_pose = decode_frame(bind_idx, 0)
print(f"  Bind pose: seq {bind_idx} ({BIND_SEQ}) frame 0")

bone_R = [None] * NBONES
bone_t = [None] * NBONES
for i, pv in enumerate(bind_pose):
    tx, ty, tz, rx, ry, rz = pv
    R, t = euler_mat(rx, ry, rz), [tx, ty, tz]
    par = bones[i]['parent']
    if par >= 0 and bone_R[par] is not None:
        R, t = compose(bone_R[par], bone_t[par], R, t)
    bone_R[i], bone_t[i] = R, t

# ── Textures (80 bytes each) ────────────────────────────────────────────────
TEX_SZ = 80
textures_out = []
for i in range(NTEX):
    o = OTEX + i * TEX_SZ
    tname  = cstr(o, 64)
    flags  = i32(o + 64); width = i32(o + 68); height = i32(o + 72); tidx = i32(o + 76)
    safe = tname.replace('/', '_').replace('\\', '_').strip()
    rel  = f"textures/player_{name}_{i}_{safe}.png"
    textures_out.append({'name': tname, 'width': width, 'height': height, 'file': rel})
    if HAS_PIL and width > 0 and height > 0:
        pix = raw[tidx : tidx + width * height]
        pal = raw[tidx + width*height : tidx + width*height + 768]
        masked = bool(flags & 0x40)
        if masked:
            img = Image.new('RGBA', (width, height))
            data = [(pal[p*3], pal[p*3+1], pal[p*3+2],
                     0 if (pal[p*3] < 8 and pal[p*3+1] < 8 and pal[p*3+2] < 8) else 255) for p in pix]
        else:
            img = Image.new('RGB', (width, height))
            data = [(pal[p*3], pal[p*3+1], pal[p*3+2]) for p in pix]
        img.putdata(data)
        img.save(str(OUT_DIR / rel))
        print(f"  Texture {i}: {tname!r} ({width}x{height}){' [masked]' if masked else ''}")

def skin_tex(skinref, fam=0):
    return u16(OSKIN + (fam * NSKINREF + skinref) * 2)

# ── Body mesh (bodypart "studio" only — skip backpack/hat groups) ──────────
BODYPART_SZ = 76
MODEL_SZ    = 112
MESH_SZ     = 20
out_meshes  = []

# Pick the "studio" bodypart (the actual body); fall back to bodypart 0.
body_bp = 0
for bp in range(NBODY):
    if cstr(OBODY + bp * BODYPART_SZ, 64).lower() == 'studio':
        body_bp = bp; break

obp  = OBODY + body_bp * BODYPART_SZ
moff = i32(obp + 72)                         # first sub-model of this bodypart
om          = moff
nummesh     = i32(om + 72);  meshoff = i32(om + 76)
numverts    = i32(om + 80);  vinfoff = i32(om + 84);  voff = i32(om + 88)
numnorms    = i32(om + 92);  ninfoff = i32(om + 96);  noff = i32(om + 100)
print(f"  Body part {body_bp} ({cstr(obp,64)!r}): {nummesh} meshes, {numverts} verts")

raw_v  = [f3(voff + j*12) for j in range(numverts)]
vbone  = [raw[vinfoff + j] for j in range(numverts)]
raw_n  = [f3(noff  + j*12) for j in range(numnorms)]
nbone  = [raw[ninfoff + j] for j in range(numnorms)]

for mi in range(nummesh):
    om2      = meshoff + mi * MESH_SZ
    triindex = i32(om2 + 4)
    skinref  = i32(om2 + 8)
    tidx = skin_tex(skinref)
    tw, th = textures_out[tidx]['width'], textures_out[tidx]['height']

    positions, normals, uvs, indices = [], [], [], []
    vert_map = {}
    off2 = triindex
    while True:
        count = s16(off2); off2 += 2
        if count == 0: break
        is_fan = count < 0
        count  = abs(count)
        tv = []
        for _ in range(count):
            vi = s16(off2); ni = s16(off2+2); s = s16(off2+4); t = s16(off2+6)
            off2 += 8
            key = (vi, ni, s, t)
            if key not in vert_map:
                vert_map[key] = len(positions) // 3
                wp = xform_pt(bone_R[vbone[vi]], bone_t[vbone[vi]], raw_v[vi])
                wn = xform_n (bone_R[nbone[ni]], raw_n[ni])
                positions.extend([ wp[0],  wp[2], -wp[1]])   # GoldSrc → Three (x, z, -y)
                normals.extend(  [ wn[0],  wn[2], -wn[1]])
                uvs.extend([s / tw, 1.0 - t / th])
            tv.append(vert_map[key])
        if is_fan:
            for k in range(1, count - 1):
                indices.extend([tv[0], tv[k], tv[k+1]])
        else:
            for k in range(count - 2):
                indices.extend([tv[k+1], tv[k], tv[k+2]] if k & 1 else [tv[k], tv[k+1], tv[k+2]])

    if indices:
        bone_indices = [vbone[vi] for (vi, ni, s, t) in vert_map.keys()]
        out_meshes.append({
            'positions':   [round(v, 3) for v in positions],
            'normals':     [round(v, 4) for v in normals],
            'uvs':         [round(v, 5) for v in uvs],
            'indices':     indices,
            'texFile':     textures_out[tidx]['file'],
            'boneIndices': bone_indices,
        })
        print(f"  Mesh {mi}: {len(indices)//3} tris  tex={textures_out[tidx]['name']!r}")

# ── Movement sequences ──────────────────────────────────────────────────────
sequences = []
for sname in WANTED_SEQS:
    si = seq_index(sname)
    if si is None:
        print(f"  (skip {sname!r}: not in model)"); continue
    os_ = OSEQ + si * SEQ_SZ
    fps = f32(os_ + 32); numframes = i32(os_ + 56)
    frames = []
    for f in range(numframes):
        pose = decode_frame(si, f)
        if pose:
            frames.append([[round(v, 5) for v in vals] for vals in pose])
    if frames:
        sequences.append({'name': sname, 'fps': fps, 'numframes': numframes, 'frames': frames})
        print(f"  Seq {si} {sname!r}: {len(frames)} frames @ {fps:.0f}fps")

# ── Aim/shoot/reload layer (upper body, per weapon class) ──────────────────
# In CS the upper body is driven by a weapon-class sequence layered on the gait:
#   ref_aim_<set>    : hold pose, 9 blends across pitch (look up/down)
#   ref_shoot_<set>  : firing gesture
#   ref_reload_<set> : reload gesture
# plus crouch_ variants. We export the aim poses (frame 0 of each blend) and the
# shoot/reload frames (middle blend) for the weapon classes we use.
ANIM_SETS = ['carbine', 'onehanded', 'knife']   # M4A1, USP, knife

def r5(pose):  return [[round(v, 5) for v in vals] for vals in pose]

def pitch_blend_idxs(nb):
    """CS player aim/shoot store a 3×3 grid (yaw × pitch) as 9 blends, laid out as
    index = pitch_step*3 + yaw_step. The center-yaw, varying-pitch column is
    [1, 4, 7] (verified by hand position: y/x ≈ const, z = up→mid→down). Using all
    9 — or the diagonal [0,4,8] — mixes yaw into pitch, so the torso twists sideways
    on a purely vertical aim. Indices are ordered up→down (blendstart→blendend)."""
    return [1, 4, 7] if nb == 9 else list(range(nb))

def export_aim(sname):
    """ref_aim hold: frame 0 of the center-yaw pitch column + the pitch range."""
    si = seq_index(sname)
    if si is None: return None
    os_ = OSEQ + si * SEQ_SZ
    nb = i32(os_ + 120)
    blends = []
    for b in pitch_blend_idxs(nb):
        p = decode_frame(si, 0, b)
        if p: blends.append(r5(p))
    if not blends: return None
    return {'blends': blends, 'range': [round(f32(os_ + 136), 1), round(f32(os_ + 144), 1)]}

def export_clip(sname, blend=None):
    """Multi-frame gesture (shoot/reload) at the middle pitch blend."""
    si = seq_index(sname)
    if si is None: return None
    os_ = OSEQ + si * SEQ_SZ
    nb = i32(os_ + 120)
    if blend is None: blend = nb // 2
    fps = f32(os_ + 32); numframes = i32(os_ + 56)
    frames = [r5(decode_frame(si, f, blend)) for f in range(numframes) if decode_frame(si, f, blend)]
    if not frames: return None
    return {'fps': fps, 'frames': frames}

def export_clip_pitched(sname):
    """Gesture stored at 3 pitch blends (down/level/up) so it can follow the look
    pitch at runtime. Used for melee, whose big swing can't be layered additively
    like the gun recoil. Costs ~3× a single-blend clip."""
    si = seq_index(sname)
    if si is None: return None
    os_ = OSEQ + si * SEQ_SZ
    nb = i32(os_ + 120)
    fps = f32(os_ + 32); numframes = i32(os_ + 56)
    idxs = pitch_blend_idxs(nb)   # center-yaw pitch column (up→mid→down)
    blends = []
    for bi in idxs:
        fr = [r5(decode_frame(si, f, bi)) for f in range(numframes) if decode_frame(si, f, bi)]
        if fr: blends.append(fr)
    if not blends: return None
    return {'fps': fps, 'range': [round(f32(os_ + 136), 1), round(f32(os_ + 144), 1)], 'blends': blends}

# Melee swings follow the look pitch via 3 stored blends; guns layer recoil
# additively over the aimed pose, so a single (middle) blend is enough for them.
MELEE_SETS = ['knife']

aim_sets = {}
for s in ANIM_SETS:
    shoot_fn = export_clip_pitched if s in MELEE_SETS else export_clip
    entry = {
        'aim':          export_aim(f'ref_aim_{s}'),
        'crouchAim':    export_aim(f'crouch_aim_{s}'),
        'shoot':        shoot_fn(f'ref_shoot_{s}'),
        'crouchShoot':  shoot_fn(f'crouch_shoot_{s}'),
        'reload':       export_clip(f'ref_reload_{s}'),
        'crouchReload': export_clip(f'crouch_reload_{s}'),
    }
    aim_sets[s] = {k: v for k, v in entry.items() if v}
    have = ', '.join(aim_sets[s].keys())
    print(f"  Aim set {s!r}: {have}")

# ── Flinch (non-lethal hit reactions) ──────────────────────────────────────
# 2-frame upper-body twitch, 9 directional blends in the original. We export the
# center blend (neutral direction) — enough to show a hit reaction on the dummy.
flinch_out = {}
if '--deaths' in sys.argv:
    for sname in FLINCH_SEQS:
        si = seq_index(sname)
        if si is None:
            print(f"  (skip flinch {sname!r}: not in model)"); continue
        os_ = OSEQ + si * SEQ_SZ
        nb = i32(os_ + 120); mid = nb // 2
        fps = f32(os_ + 32); numframes = i32(os_ + 56)
        frames = [r5(decode_frame(si, f, mid)) for f in range(numframes) if decode_frame(si, f, mid)]
        if frames:
            flinch_out[sname] = {'fps': fps, 'frames': frames}
            print(f"  Flinch {sname!r}: {len(frames)} frames (blend {mid})")

# ── Write bundle ────────────────────────────────────────────────────────────
result = {
    'name':      name,
    'meshes':    out_meshes,
    'textures':  textures_out,
    'bones':     bones,
    'sequences': sequences,
    'bindSeq':   BIND_SEQ,
    'aimSets':   aim_sets,
    'flinch':    flinch_out,
}
out_path = OUT_DIR / "models" / f"player_{name}.json"
with open(out_path, 'w') as fh:
    json.dump(result, fh, separators=(',', ':'))
print(f"\nDone: {out_path}  ({out_path.stat().st_size // 1024} KB)")
print(f"  bones={len(bones)}  meshes={len(out_meshes)}  seqs={len(sequences)}")
