import struct
from pathlib import Path
from config import WAD_PATH

with open(WAD_PATH, 'rb') as f:
    data = f.read()

print("Magic:", data[:4])
num_dirs, dir_offset = struct.unpack_from('<II', data, 4)
print(f"Dirs: {num_dirs}, offset: {dir_offset}")

for i in range(min(10, num_dirs)):
    base = dir_offset + i * 32
    file_pos, disk_size, size, tex_type, compression = struct.unpack_from('<IIIBb', data, base)
    pad = struct.unpack_from('<H', data, base + 14)[0]
    # Show raw bytes at name location
    name_at_8  = data[base+8 :base+24].split(b'\x00')[0]
    name_at_16 = data[base+16:base+32].split(b'\x00')[0]
    print(f"  type=0x{tex_type:02x}  name@8={name_at_8}  name@16={name_at_16}  size={size}")
