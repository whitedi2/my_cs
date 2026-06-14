"""
Extract skin data (bone indices + local space positions) from GoldSrc MDL v10.
Creates v_<weapon>_skin.json with bone indices for each vertex.
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
def f3(o):   return struct.unpack_from('<3f', raw, o)
def cstr(o, n): return raw[o:o+n].split(b'\x00')[0].decode('latin1')

# ── Validate ───────────────────────────────────────────────────────────────
assert raw[0:4] == b'IDST', "Not a GoldSrc studio model"
assert i32(4) == 10, f"Unsupported MDL version {i32(4)}"

print(f"MDL: {cstr(8, 64)!r}")

# ── Header ─────────────────────────────────────────────────────────────────
NBONES = i32(140); OBONES = i32(144)
NBODY  = i32(204); OBODY  = i32(208)

print(f"  bones={NBONES}  bodyparts={NBODY}")

# ── Body parts → skin data ────────────────────────────────────────────────
BODYPART_SZ = 76
MODEL_SZ    = 112
MESH_SZ     = 20

skin_data = []  # Array of bone indices, one per vertex in the final mesh

for bp in range(NBODY):
    obp  = OBODY + bp * BODYPART_SZ
    moff = i32(obp + 72)

    om          = moff
    nummesh     = i32(om + 72);  meshoff = i32(om + 76)
    numverts    = i32(om + 80);  vinfoff = i32(om + 84)
    vbone       = [raw[vinfoff + j] for j in range(numverts)]

    for mi in range(nummesh):
        om2      = meshoff + mi * MESH_SZ
        triindex = i32(om2 + 4)

        bone_indices = []
        off2 = triindex

        while True:
            count = s16(off2); off2 += 2
            if count == 0:
                break
            is_fan = count < 0
            count  = abs(count)

            for _ in range(count):
                vi = s16(off2); off2 += 2
                _ni = s16(off2+2); off2 += 2
                _s = s16(off2+4); off2 += 4
                _t = s16(off2+6); off2 += 8
                bone_indices.append(vbone[vi])

            # Skip strip/fan indices (they reference the vertices we already processed)
            # The bone indices are already collected above

        if bone_indices:
            skin_data.append({
                'bone_indices': bone_indices,
            })
            print(f"  Mesh {mi}: {len(bone_indices)} vertices with bone indices")

# ── Write skin JSON ───────────────────────────────────────────────────────
out_path = Path(__file__).parent.parent / "models" / f"v_{weapon_name}_skin.json"
with open(out_path, 'w') as fh:
    json.dump(skin_data, fh, separators=(',', ':'))

size_kb = out_path.stat().st_size // 1024
print(f"\nDone: {out_path}  ({size_kb} KB)")
