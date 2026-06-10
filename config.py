# Configuration for game paths
from pathlib import Path

# Default paths based on existing project structure
CSTRIKE_PATH = r"D:\Games\Steam\steamapps\common\Half-Life\cstrike"
WAD_FILE = "cs_dust.wad"

# Full path to the wad file
WAD_PATH = Path(CSTRIKE_PATH) / WAD_FILE
