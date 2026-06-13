import struct, os

def read_attachments(mdl_path):
    with open(mdl_path, 'rb') as f:
        data = f.read()
    num  = struct.unpack_from('<i', data, 212)[0]
    idx  = struct.unpack_from('<i', data, 216)[0]
    print(f"{os.path.basename(mdl_path)}: {num} attachments")
    for i in range(num):
        off  = idx + i * 88
        name = data[off:off+32].rstrip(b'\x00').decode('ascii', errors='replace')
        bone = struct.unpack_from('<i', data, off+36)[0]
        org  = struct.unpack_from('<3f', data, off+40)
        print(f"  [{i}] name='{name}' bone={bone} org={[round(x,2) for x in org]}")

base = "D:/SteamLibrary/steamapps/common/Half-Life/cstrike"
for name in ["models/v_m4a1.mdl", "models/v_usp.mdl"]:
    path = os.path.join(base, name)
    if os.path.exists(path):
        read_attachments(path)
    else:
        print(f"NOT FOUND: {path}")

# Check shell models
print()
for name in ["models/shell.mdl", "models/shelll.mdl", "models/w_bullet.mdl"]:
    path = os.path.join(base, name)
    print(f"{'EXISTS' if os.path.exists(path) else 'missing'}: {name}")
