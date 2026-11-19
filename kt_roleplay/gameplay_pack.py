"""Resolve an authored card's optional gameplay requirement against installed KT packages."""

from copy import deepcopy
import re

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class GameplayPack(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    name: str = Field(pattern=r'^[a-z][a-z0-9_-]{0,62}$')
    version: str = Field(pattern=r'^[0-9]+\.[0-9]+\.[0-9]+$', max_length=40)
    settings: dict[str, JsonValue] = Field(default_factory=dict)


def pack_settings(record: dict | None, name: str) -> dict[str, JsonValue] | None:
    pack = record.get('gameplay_pack') if record else None
    return deepcopy(pack['settings']) if pack and pack['name'] == name else None


def pack_tools(record: dict, agent) -> set[str]:
    pack = record.get('gameplay_pack')
    if pack is None or agent is None:
        return set()
    name = pack['name']
    if not agent.plugins.is_enabled(name):
        return set()
    provider = agent.plugins.get_plugin(name)
    prefix = 'rp_pack_' + name.replace('-', '_') + '_'
    # Only the trusted package supplies tool names. Card settings are never consulted here.
    return {tool for tool in getattr(provider, 'roleplay_tool_names', ())
            if isinstance(tool, str) and tool.startswith(prefix) and re.fullmatch(r'[a-z0-9_]{1,64}', tool)}


class GameplayPackUnavailable(ValueError):
    pass


def tavern_creature(requirement: GameplayPack | None) -> str:
    if requirement is None:
        return '@kohaku-roleplay/creatures/rp_agent'
    from kohakuterrarium.packages import list_packages
    package = next((p for p in list_packages() if p['name'] == requirement.name), None)
    if package is None:
        raise GameplayPackUnavailable(f'Install gameplay pack {requirement.name} {requirement.version} separately before playing')
    if str(package['version']) != requirement.version:
        raise GameplayPackUnavailable(f'Gameplay pack {requirement.name} requires {requirement.version}; installed: {package["version"]}')
    if not any(isinstance(c, dict) and c.get('name') == 'rp_tavern' and c.get('roleplay_pack') is True
               for c in package.get('creatures') or ()):
        raise GameplayPackUnavailable(f'{requirement.name} does not provide a Roleplay gameplay creature')
    # The installed author opts in at this fixed entry; no card-supplied path, class or command.
    return f'@{requirement.name}/creatures/rp_tavern'
