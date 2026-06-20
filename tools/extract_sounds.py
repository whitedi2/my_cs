"""
Copy the original CS 1.6 WAV sounds this clone needs into ./sounds/, preserving
the GoldSrc sound/ subpath layout (weapons/, items/, player/).

Two sources of truth, both from the original — nothing invented:
  1. MDL animation events (event 5004) in every v_<weapon>.mdl → exact reload /
     deploy / silencer sound files. Parsed straight from the model.
  2. Code-driven sounds the game DLL plays (not stored as MDL events): per-weapon
     gunfire and the knife swing/stab/hit set. Filenames match HLSDK/ReGameDLL.

Each WAV is normalized to 16-bit / 22050 Hz / mono on copy. The originals are a
mix of 8-bit and 11025/22050 Hz PCM; browsers' decodeAudioData handles 8-bit PCM
with audible artifacts / different timbre than the engine, so we re-encode to a
clean, uniform 16-bit format (the sound content is preserved — just the container).

Run from the project root:  python tools/extract_sounds.py
"""
import struct, shutil, sys, wave, audioop
from pathlib import Path

try:
    from config import CSTRIKE_PATH
except Exception:
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from config import CSTRIKE_PATH

CS        = Path(CSTRIKE_PATH)
SND_SRC   = CS / "sound"
VALVE_SND = CS.parent / "valve" / "sound"   # base Half-Life sounds (siblings of cstrike)
MODELS    = CS / "models"
OUT_DIR   = Path(__file__).parent.parent / "sounds"

# View-model weapons present in this clone (WPNS in src/weapons.js).
WEAPONS = ['m4a1', 'usp', 'knife', 'ak47', 'galil', 'famas', 'aug', 'sg552',
           'mp5', 'tmp', 'mac10', 'ump45', 'p90', 'm249',
           'glock18', 'deagle', 'p228', 'fiveseven']

# Code-driven gunfire + knife sounds (played by the game DLL, not MDL events).
# Matches the WeaponSound / EMIT_SOUND calls in HLSDK / ReGameDLL_CS.
CODE_SOUNDS = [
    # gunfire (silenced + unsilenced variants where the original randomises -1/-2)
    'weapons/m4a1-1.wav', 'weapons/m4a1_unsil-1.wav', 'weapons/m4a1_unsil-2.wav',
    'weapons/usp1.wav', 'weapons/usp2.wav', 'weapons/usp_unsil-1.wav',
    'weapons/ak47-1.wav', 'weapons/ak47-2.wav',
    'weapons/galil-1.wav', 'weapons/galil-2.wav',
    'weapons/famas-1.wav', 'weapons/famas-2.wav',
    'weapons/aug-1.wav',
    'weapons/sg552-1.wav', 'weapons/sg552-2.wav',
    'weapons/mp5-1.wav', 'weapons/mp5-2.wav',
    'weapons/tmp-1.wav', 'weapons/tmp-2.wav',
    'weapons/mac10-1.wav',
    'weapons/ump45-1.wav',
    'weapons/p90-1.wav',
    'weapons/m249-1.wav', 'weapons/m249-2.wav',
    'weapons/glock18-2.wav',
    'weapons/deagle-1.wav', 'weapons/deagle-2.wav',
    'weapons/p228-1.wav',
    'weapons/fiveseven-1.wav',
    # knife (deploy + swing + flesh/wall hits + stab)
    'weapons/knife_deploy1.wav',
    'weapons/knife_slash1.wav', 'weapons/knife_slash2.wav',
    'weapons/knife_hit1.wav', 'weapons/knife_hit2.wav',
    'weapons/knife_hit3.wav', 'weapons/knife_hit4.wav',
    'weapons/knife_hitwall1.wav',
    'weapons/knife_stab.wav',
    # C4 bomb: plant, arming beeps, defuse loop/finish, explosion.
    'weapons/c4_plant.wav', 'weapons/c4_click.wav',
    'weapons/c4_beep1.wav', 'weapons/c4_beep2.wav', 'weapons/c4_beep3.wav',
    'weapons/c4_beep4.wav', 'weapons/c4_beep5.wav',
    'weapons/c4_disarm.wav', 'weapons/c4_disarmed.wav', 'weapons/c4_explode1.wav',
]

# Player movement sounds (code-driven in pm_shared.c: PM_PlayStepSound / landing).
# Step set per surface material (materials.txt → step type); concrete pl_step is the
# default (de_dust2's sand textures aren't tagged, so they use it — as in the original).
PLAYER_SOUNDS = (
    [f'player/pl_step{i}.wav'  for i in range(1, 5)] +   # concrete / default
    [f'player/pl_dirt{i}.wav'  for i in range(1, 5)] +
    [f'player/pl_metal{i}.wav' for i in range(1, 5)] +
    [f'player/pl_tile{i}.wav'  for i in range(1, 6)] +   # 5 variants
    [f'player/pl_grate{i}.wav' for i in range(1, 5)] +
    [f'player/pl_duct{i}.wav'  for i in range(1, 5)] +   # vent
    [f'player/pl_slosh{i}.wav' for i in range(1, 5)] +   # shallow liquid
    [f'player/pl_wade{i}.wav'  for i in range(1, 5)] +
    [f'player/pl_snow{i}.wav'  for i in range(1, 7)] +
    [f'player/pl_ladder{i}.wav' for i in range(1, 5)] +
    [f'player/pl_jump{i}.wav'  for i in range(1, 3)] +
    [f'player/pl_fallpain{i}.wav' for i in range(1, 4)]  # hard landing
)

# Texture→material-char table for footstep surface selection (PM_CatagorizeTextureType).
EXTRA_FILES = ['materials.txt']

# Bullet-impact sounds (code-driven in the original):
#  • surface ricochets — TEXTURETYPE_PlaySound / EV_HLDM texture sound: concrete &
#    default → ric_conc, metal/vent/grate → ric_metal (the only two bullet-ric sets CS ships);
#  • victim hits — CBasePlayer::TraceAttack: flesh (no armor), kevlar (torso/arm under
#    armor), helmet (head under helmet), headshot (head, no helmet).
HIT_SOUNDS = [
    'weapons/ric_conc-1.wav', 'weapons/ric_conc-2.wav',
    'weapons/ric_metal-1.wav', 'weapons/ric_metal-2.wav',
    'player/bhit_flesh-1.wav', 'player/bhit_flesh-2.wav', 'player/bhit_flesh-3.wav',
    'player/bhit_kevlar-1.wav', 'player/bhit_helmet-1.wav',
    'player/headshot1.wav', 'player/headshot2.wav', 'player/headshot3.wav',
]

# Sounds that live in the Half-Life base game (valve/), not cstrike/: weapon
# drop/pickup + the HUD weapon-selection confirm / deny beeps.
VALVE_SOUNDS = ['items/weapondrop1.wav', 'items/gunpickup2.wav',
                'common/wpn_select.wav', 'common/wpn_denyselect.wav',
                'common/wpn_moveselect.wav', 'common/wpn_hudon.wav', 'common/wpn_hudoff.wav',
                # Ejected-brass bounce (engine TE_BOUNCE_SHELL) — rifle/pistol casings ringing on the floor.
                'player/pl_shell1.wav', 'player/pl_shell2.wav', 'player/pl_shell3.wav',
                # Varied ricochet whines — played occasionally over the material impact (the
                # distinct "zing" that isn't every shot and differs each time).
                'weapons/ric1.wav', 'weapons/ric2.wav', 'weapons/ric3.wav', 'weapons/ric4.wav', 'weapons/ric5.wav']

# Half-Life weapons (RPG, crossbow) — non-canon, opt-in via the server's mp_hl_weapons
# flag. All sounds are code-driven in HL (no MDL 5004 events), and live in valve/sound/.
#  • RPG: rocketfire1 (launch) + rocket1 (looping flight).
#  • Crossbow: xbow_fire1 (shoot), xbow_reload1 (reload), xbow_fly1 (bolt in flight),
#    xbow_hit1/2 (bolt hits world), xbow_hitbod1/2 (bolt hits a body).
HL_SOUNDS = ['weapons/rocketfire1.wav', 'weapons/rocket1.wav',
             'weapons/xbow_fire1.wav', 'weapons/xbow_reload1.wav', 'weapons/xbow_fly1.wav',
             'weapons/xbow_hit1.wav', 'weapons/xbow_hit2.wav',
             'weapons/xbow_hitbod1.wav', 'weapons/xbow_hitbod2.wav']


TARGET_RATE = 22050


def normalize_wav(path):
    """Rewrite a PCM WAV in place as 16-bit / 22050 Hz / mono. Non-PCM is left as-is."""
    try:
        with wave.open(str(path), 'rb') as w:
            ch, sw, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            data = w.readframes(n)
    except Exception as e:
        print(f"  ! skip (not PCM WAV): {path.name} ({e})")
        return
    if sw == 1:                                  # 8-bit WAV is unsigned → signed, then widen to 16-bit
        data = audioop.lin2lin(audioop.bias(data, 1, -128), 1, 2); sw = 2
    elif sw != 2:                                # 24/32-bit → 16-bit
        data = audioop.lin2lin(data, sw, 2); sw = 2
    if ch == 2:
        data = audioop.tomono(data, sw, 0.5, 0.5); ch = 1
    if rate != TARGET_RATE:
        data, _ = audioop.ratecv(data, sw, ch, rate, TARGET_RATE, None); rate = TARGET_RATE
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(TARGET_RATE)
        w.writeframes(data)


def i32(raw, o): return struct.unpack_from('<i', raw, o)[0]
def cstr(raw, o, n): return raw[o:o + n].split(b'\x00')[0].decode('latin1')

SEQ_SZ = 176


def mdl_event_sounds(mdl_path):
    """Return the set of sound paths referenced by event 5004 in an MDL."""
    raw = mdl_path.read_bytes()
    if raw[0:4] != b'IDST' or i32(raw, 4) != 10:
        return set()
    nseq, oseq = i32(raw, 164), i32(raw, 168)
    out = set()
    for si in range(nseq):
        o = oseq + si * SEQ_SZ
        numevents, eventindex = i32(raw, o + 48), i32(raw, o + 52)
        for e in range(numevents):
            eo = eventindex + e * 76
            if i32(raw, eo + 4) == 5004:
                snd = cstr(raw, eo + 12, 64)
                if snd:
                    out.add(snd.replace('\\', '/'))
    return out


def main():
    wanted = set(CODE_SOUNDS) | set(PLAYER_SOUNDS) | set(HIT_SOUNDS) | set(EXTRA_FILES)
    for w in WEAPONS:
        mdl = MODELS / f"v_{w}.mdl"
        if mdl.exists():
            wanted |= mdl_event_sounds(mdl)
        else:
            print(f"  ! MDL missing, skipping events: {mdl}")

    OUT_DIR.mkdir(exist_ok=True)
    copied = missing = 0
    # (source dir, relative path) pairs: most from cstrike/, drop+pickup from valve/.
    jobs = [(SND_SRC, rel) for rel in sorted(wanted)]
    jobs += [(VALVE_SND, rel) for rel in VALVE_SOUNDS]
    jobs += [(VALVE_SND, rel) for rel in HL_SOUNDS]
    for srcdir, rel in jobs:
        src = srcdir / rel
        dst = OUT_DIR / rel
        if not src.exists():
            print(f"  MISSING in original: {rel}")
            missing += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if rel.lower().endswith('.wav'):
            normalize_wav(dst)
        copied += 1

    print(f"\nDone -> {OUT_DIR}")
    print(f"  copied : {copied}")
    print(f"  missing: {missing}")


if __name__ == '__main__':
    main()
