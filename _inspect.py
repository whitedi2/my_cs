import json, math

with open('v_knife_anim.json') as f:
    d = json.load(f)

bones = d['bones']
seqs = {s['name']: s for s in d['sequences']}

def euler_mat(rx, ry, rz):
    sr, cr = math.sin(rx*0.5), math.cos(rx*0.5)
    sp, cp = math.sin(ry*0.5), math.cos(ry*0.5)
    sy, cy = math.sin(rz*0.5), math.cos(rz*0.5)
    qx = sr*cp*cy - cr*sp*sy; qy = cr*sp*cy + sr*cp*sy
    qz = cr*cp*sy - sr*sp*cy; qw = cr*cp*cy + sr*sp*sy
    return [[1-2*(qy*qy+qz*qz), 2*(qx*qy-qw*qz), 2*(qx*qz+qw*qy)],
            [2*(qx*qy+qw*qz), 1-2*(qx*qx+qz*qz), 2*(qy*qz-qw*qx)],
            [2*(qx*qz-qw*qy), 2*(qy*qz+qw*qx), 1-2*(qx*qx+qy*qy)]]

def mmul(A, B):
    return [[sum(A[r][k]*B[k][c] for k in range(3)) for c in range(3)] for r in range(3)]

def bone_worlds(pose):
    Rs, Ts = [None]*len(bones), [None]*len(bones)
    for i, p in enumerate(pose):
        R = euler_mat(p[3], p[4], p[5])
        t = list(p[:3])
        par = bones[i]['parent']
        if par >= 0 and Rs[par]:
            t = [Ts[par][j] + sum(Rs[par][j][k]*t[k] for k in range(3)) for j in range(3)]
            R = mmul(Rs[par], R)
        Rs[i], Ts[i] = R, t
    return Rs, Ts

idle_Rs, idle_Ts = bone_worlds(seqs['idle']['frames'][0])

def max_rot_deg(seq_name):
    frames = seqs[seq_name]['frames']
    fps = seqs[seq_name]['fps']
    max_ang = 0
    best_b = 0
    best_f = 0
    for fi, frame in enumerate(frames):
        cur_Rs, _ = bone_worlds(frame)
        for b in range(len(bones)):
            RiT = [[idle_Rs[b][c][r] for c in range(3)] for r in range(3)]
            Mskin = mmul(cur_Rs[b], RiT)
            trace = Mskin[0][0]+Mskin[1][1]+Mskin[2][2]
            ang = math.degrees(math.acos(max(-1, min(1, (trace-1)/2))))
            if ang > max_ang:
                max_ang = ang; best_b = b; best_f = fi
    return max_ang, best_b, best_f, fps, len(frames)

for name in ['idle', 'slash1', 'slash2', 'midslash1', 'stab']:
    if name not in seqs: continue
    ang, b, fi, fps, nf = max_rot_deg(name)
    dur = nf / fps if fps > 0 else 0
    print(f'{name:12s}: max_rot={ang:6.1f}° at bone {b} frame {fi}  ({nf} frames @ {fps:.0f}fps = {dur:.2f}s)')
