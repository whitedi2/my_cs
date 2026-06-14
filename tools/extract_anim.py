"""
Extract animation data from GoldSrc MDL v10 → separate JSON file.
Creates v_<weapon>_anim.json with bones + animation sequences.
Does NOT modify the working mdl_to_json.py or existing weapon JSON files.
"""
import struct, json, sys
from pathlib import Path

weapon_name = 'knife'
for _arg in sys.argv[1:]:
    if not _arg.startswith('-'):
        _stem = Path(_arg).stem
        weapon_name = _stem[2:] if _stem.startswith('v_') else _stem
        break

try:
    from config import CSTRIKE_PATH
    MDL_PATH = Path(CSTRIKE_PATH) / "models" / f"v_{weapon_name}.mdl"
except Exception:
    MDL_PATH = Path(f"v_{weapon_name}.mdl")

if not MDL_PATH.exists():
    sys.exit(f"MDL not found: {MDL_PATH}")

raw = MDL_PATH.read_bytes()

# ── Helpers ────────────────────────────────────────────────────────────────
def i32(o):  return struct.unpack_from('<i',  raw, o)[0]
def u16(o):  return struct.unpack_from('<H',  raw, o)[0]
def s16(o):  return struct.unpack_from('<h',  raw, o)[0]
def f32(o):  return struct.unpack_from('<f',  raw, o)[0]
def f6(o):   return struct.unpack_from('<6f', raw, o)
def cstr(o, n): return raw[o:o+n].split(b'\x00')[0].decode('latin1')

# ── Validate ───────────────────────────────────────────────────────────────
assert raw[0:4] == b'IDST', "Not a GoldSrc studio model"
assert i32(4) == 10, f"Unsupported MDL version {i32(4)}"

print(f"MDL: {cstr(8, 64)!r}")

# ── Header ─────────────────────────────────────────────────────────────────
NBONES = i32(140); OBONES = i32(144)
NSEQ   = i32(164);  OSEQ  = i32(168)

print(f"  bones={NBONES}  seqs={NSEQ}")

# ── Bones: 112 bytes each ──────────────────────────────────────────────────
BONE_SZ = 112
bones = []
for i in range(NBONES):
    o = OBONES + i * BONE_SZ
    bones.append({
        'name':   cstr(o, 32),
        'parent': i32(o + 32),
        'val':    list(f6(o + 64)),   # default tx,ty,tz,rx,ry,rz
        'scale':  list(f6(o + 88)),   # scale for each dof
    })

# ── Sequences: 176 bytes header each ──────────────────────────────────────
SEQ_SZ = 176

def decode_frame(seq_idx, frame_idx):
    """Decode frame frame_idx of sequence seq_idx → per-bone [tx,ty,tz,rx,ry,rz]."""
    os_ = OSEQ + seq_idx * SEQ_SZ
    seqgroup = i32(os_ + 156)
    if seqgroup != 0:
        return None  # demand-loaded group, skip

    numframes = i32(os_ + 56)
    if frame_idx >= numframes:
        return None

    animindex = i32(os_ + 124)
    pose = []

    for b in range(NBONES):
        bone = bones[b]
        anim_base = animindex + b * 12  # 6 × u16 offsets for this bone
        vals = []

        for dof in range(6):
            off = u16(anim_base + dof * 2)
            if off == 0:
                vals.append(bone['val'][dof])
                continue

            # Walk GoldSrc RLE stream (mstudioanimvalue_t) to frame_idx.
            # Each block: [valid:u8, total:u8] followed by valid×s16 values.
            # Block covers 'total' frames; if k < valid → stored; else → repeat last.
            rle = anim_base + off
            k = frame_idx
            while True:
                valid = raw[rle]      # num.valid
                total = raw[rle + 1]  # num.total
                if total == 0:
                    k = 0; break
                if k < total:
                    break
                k -= total
                rle += (valid + 1) * 2  # skip header + valid s16 values

            valid = raw[rle]
            if k < valid:
                delta = s16(rle + 2 + k * 2)
            else:
                delta = s16(rle + 2 + (valid - 1) * 2)

            vals.append(bone['val'][dof] + bone['scale'][dof] * delta)

        pose.append(vals)

    return pose

# ── Extract all sequences ─────────────────────────────────────────────────
sequences = []

for si in range(NSEQ):
    os_ = OSEQ + si * SEQ_SZ
    label = cstr(os_, 32)
    fps = f32(os_ + 32)
    numframes = i32(os_ + 56)
    
    print(f"\n  Sequence {si}: {label!r}  fps={fps}  frames={numframes}")
    
    # Decode all frames
    frames = []
    for frame in range(numframes):
        pose = decode_frame(si, frame)
        if pose:
            frames.append(pose)
    
    if frames:
        sequences.append({
            'name': label,
            'fps': fps,
            'numframes': numframes,
            'frames': frames,
        })
        print(f"    Exported {len(frames)} frames")

# ── Write animation JSON ──────────────────────────────────────────────────
result = {
    'bones': bones,
    'sequences': sequences,
}

out_path = Path(__file__).parent.parent / "models" / f"v_{weapon_name}_anim.json"
with open(out_path, 'w') as fh:
    json.dump(result, fh, separators=(',', ':'))

size_kb = out_path.stat().st_size // 1024
print(f"\nDone: {out_path}  ({size_kb} KB)")
print(f"  Bones: {len(bones)}")
print(f"  Sequences: {len(sequences)}")
