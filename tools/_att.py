import json, struct, math

# ── M4A1 bones ───────────────────────────────────────────────────────────────
with open("models/v_m4a1_anim.json") as f:
    d = json.load(f)
bones = d["bones"]
print("M4A1 total bones:", len(bones))
b = 41
chain = []
while b != -1:
    chain.append("%d:%s" % (b, bones[b]["name"]))
    b = bones[b]["parent"]
print("Bone41 chain:", " -> ".join(chain))

with open("models/v_usp_anim.json") as f:
    d2 = json.load(f)
b2 = d2["bones"]
b = 20
chain2 = []
while b != -1:
    chain2.append("%d:%s" % (b, b2[b]["name"]))
    b = b2[b]["parent"]
print("USP Bone20 chain:", " -> ".join(chain2))

# ── Compute rest-pose world position of attachment[0] ────────────────────────
# Each bone val = [tx, ty, tz, rx, ry, rz]
def quat_from_euler(rx, ry, rz):
    sr, cr = math.sin(rx/2), math.cos(rx/2)
    sp, cp = math.sin(ry/2), math.cos(ry/2)
    sy, cy = math.sin(rz/2), math.cos(rz/2)
    return (sr*cp*cy - cr*sp*sy,
            cr*sp*cy + sr*cp*sy,
            cr*cp*sy - sr*sp*cy,
            cr*cp*cy + sr*sp*sy)  # x,y,z,w

def quat_mul(a, b):
    ax,ay,az,aw = a; bx,by,bz,bw = b
    return (aw*bx+ax*bw+ay*bz-az*by,
            aw*by-ax*bz+ay*bw+az*bx,
            aw*bz+ax*by-ay*bx+az*bw,
            aw*bw-ax*bx-ay*by-az*bz)

def rotate_v(q, v):
    qx,qy,qz,qw = q; vx,vy,vz = v
    # p' = q p q*
    ix = qw*vx + qy*vz - qz*vy
    iy = qw*vy + qz*vx - qx*vz
    iz = qw*vz + qx*vy - qy*vx
    iw = -qx*vx - qy*vy - qz*vz
    return (ix*qw + iw*(-qx) + iy*(-qz) - iz*(-qy),
            iy*qw + iw*(-qy) + iz*(-qx) - ix*(-qz),
            iz*qw + iw*(-qz) + ix*(-qy) - iy*(-qx))

def bone_world(bones_list, idx):
    b = bones_list[idx]
    tx,ty,tz,rx,ry,rz = b["val"][:6]
    q = quat_from_euler(rx, ry, rz)
    pos = [tx, ty, tz]
    par = b["parent"]
    if par >= 0:
        ppos, pq = bone_world(bones_list, par)
        pos = list(rotate_v(pq, pos))
        pos = [pos[i]+ppos[i] for i in range(3)]
        q = quat_mul(pq, q)
    return pos, q

print("\nM4A1 rest-pose bone41 world pos:")
pos41, q41 = bone_world(bones, 41)
print("  bone:", [round(x,3) for x in pos41])
att_org = [0, -18.5, 0]
att_world = [pos41[i] + rotate_v(q41, att_org)[i] for i in range(3)]
print("  attachment[0]:", [round(x,3) for x in att_world])

print("\nUSP rest-pose bone20 world pos:")
pos20, q20 = bone_world(b2, 20)
print("  bone:", [round(x,3) for x in pos20])
att_org_usp = [2.6, -13.3, 2.0]
att_world_usp = [pos20[i] + rotate_v(q20, att_org_usp)[i] for i in range(3)]
print("  attachment[0]:", [round(x,3) for x in att_world_usp])
