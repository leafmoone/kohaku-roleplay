"""Storage locations shared by the catalog and the creature plugin."""
from pathlib import Path

from kohakuterrarium.utils.config_dir import config_dir


def library_dir() -> Path:
    return config_dir() / "kohaku-roleplay"
