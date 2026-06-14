"""List all texture names in a GoldSrc WAD3 file."""
import struct, sys

def list_wad(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic = data[:4]
    assert magic == b'WAD3', f"Not WAD3: {magic}"
    num_lumps = struct.unpack_from('<i', data, 4)[0]
    dir_offset = struct.unpack_from('<i', data, 8)[0]
    print(f"{path}: {num_lumps} lumps\n")
    for i in range(num_lumps):
        off = dir_offset + i * 32
        file_pos   = struct.unpack_from('<i', data, off)[0]
        disk_size  = struct.unpack_from('<i', data, off+4)[0]
        lump_type  = struct.unpack_from('<B', data, off+10)[0]
        name       = data[off+16:off+32].rstrip(b'\x00').decode('ascii', errors='replace')
        print(f"  {name:<32}  type={lump_type}  size={disk_size}")

list_wad("D:/SteamLibrary/steamapps/common/Half-Life/cstrike/decals.wad")
