"""
Export BSP hull 1 (player collision) + spawn points to JSON.
Hull 1 = player standing bbox (-16,-16,0)-(16,16,72), pre-expanded in BSP clip nodes.
Tracing a point through hull 1 is equivalent to tracing a player-sized box.
"""
import struct, json, re, sys
from pathlib import Path
from config import CSTRIKE_PATH

BSP = sys.argv[1] if len(sys.argv) > 1 else \
    CSTRIKE_PATH / "maps" / "de_dust2.bsp"

def lump(data, i):
    off, ln = struct.unpack_from('<II', data, 4 + i*8)
    return off, ln

with open(BSP, 'rb') as f:
    data = f.read()

# ── Planes ────────────────────────────────────────────────────────────────────
poff, plen = lump(data, 1)
planes = []
for i in range(plen // 20):
    b = poff + i * 20
    nx, ny, nz, dist = struct.unpack_from('<ffff', data, b)
    ptype,             = struct.unpack_from('<I',    data, b + 16)
    planes.append([round(nx,6), round(ny,6), round(nz,6), round(dist,4), ptype])

# ── Clip nodes ────────────────────────────────────────────────────────────────
coff, clen = lump(data, 9)
clipnodes = []
for i in range(clen // 8):
    b = coff + i * 8
    planenum,    = struct.unpack_from('<i', data, b)
    c0, c1       = struct.unpack_from('<hh', data, b + 4)
    clipnodes.append([planenum, c0, c1])

# ── All model headnodes ───────────────────────────────────────────────────────
# dmodel_t (64 bytes): mins(12) maxs(12) origin(12) headnode[4](16) visleafs(4) firstface(4) numfaces(4)
moff, mlen = lump(data, 14)
MODEL_SIZE  = 64
num_models  = mlen // MODEL_SIZE
headnodes   = list(struct.unpack_from('<4i', data, moff + 36))   # model 0

model_hull1 = []
model_hull3 = []
for i in range(num_models):
    hn = list(struct.unpack_from('<4i', data, moff + i * MODEL_SIZE + 36))
    model_hull1.append(hn[1])
    model_hull3.append(hn[3])

# ── Spawn points + brush entity hull heads from entity lump ───────────────────
eoff, elen = lump(data, 0)
ent_text = data[eoff:eoff + elen].decode('ascii', errors='replace')

# Non-solid brush entities — intentionally passable, skip them
NON_SOLID = {
    'func_illusionary', 'func_buyzone', 'func_bomb_target',
    'func_ladder', 'func_clip', 'func_hostage_rescue',
    'trigger_multiple', 'trigger_once', 'trigger_hurt',
    'trigger_push', 'trigger_teleport', 'trigger_auto',
    'trigger_relay', 'trigger_counter',
}

spawns           = {'ct': [], 't': []}
solid_heads      = []
solid_heads_duck = []
brush_cls        = {}   # classname → count, for diagnostics

for block in re.findall(r'\{([^}]+)\}', ent_text):
    props = dict(re.findall(r'"(\w+)"\s+"([^"]*)"', block))
    cls   = props.get('classname', '')

    # Spawns
    if cls in ('info_player_start', 'info_player_deathmatch') and 'origin' in props:
        xyz   = list(map(float, props['origin'].split()))
        angle = float(props.get('angle', 0))
        team  = 'ct' if cls == 'info_player_start' else 't'
        spawns[team].append({'origin': xyz, 'angle': angle})

    # All brush entities (have a "*N" model key)
    model_key = props.get('model', '')
    if model_key.startswith('*'):
        brush_cls[cls] = brush_cls.get(cls, 0) + 1
        if cls not in NON_SOLID:
            try:
                idx = int(model_key[1:])
                if 0 < idx < len(model_hull1) and model_hull1[idx] >= 0:
                    solid_heads.append(model_hull1[idx])
                    solid_heads_duck.append(model_hull3[idx] if model_hull3[idx] >= 0 else model_hull1[idx])
            except ValueError:
                pass

# Deduplicate both lists together (preserve order, keyed by hull1 head)
seen = {}
sh1, sh3 = [], []
for h1, h3 in zip(solid_heads, solid_heads_duck):
    if h1 not in seen:
        seen[h1] = True
        sh1.append(h1)
        sh3.append(h3)
solid_heads      = sh1
solid_heads_duck = sh3

# ── Output ────────────────────────────────────────────────────────────────────
out_path = Path(__file__).parent.parent / "maps" / (Path(BSP).stem + '_hull.json')
result = {
    'hull1_head':   headnodes[1],
    'hull3_head':   headnodes[3],   # duck hull (-16,-16,-18)→(16,16,18)
    'solid_heads':      solid_heads,       # brush entity hull1 heads
    'solid_heads_duck': solid_heads_duck,  # same entities, hull3 (duck) heads
    'planes':       planes,
    'clipnodes':    clipnodes,
    'spawns':       spawns,
}

with open(out_path, 'w') as f:
    json.dump(result, f, separators=(',', ':'))

print(f"Planes: {len(planes)}, Clipnodes: {len(clipnodes)}, Models: {num_models}")
print(f"Hull 1 headnode: {headnodes[1]},  Hull 3 (duck): {headnodes[3]}")
print(f"Solid brush entities: {len(solid_heads)}")
print(f"Spawns — CT: {len(spawns['ct'])}, T: {len(spawns['t'])}")
print(f"Written: {out_path}  ({out_path.stat().st_size // 1024} KB)")
print("\nBrush entity classnames found:")
for cls, cnt in sorted(brush_cls.items(), key=lambda x: -x[1]):
    tag = '  [NON-SOLID]' if cls in NON_SOLID else ''
    print(f"  {cls}: {cnt}{tag}")
