"""Recognize the published embedded GameLogic and StatusMenu pack contracts."""
from collections.abc import Iterator
from typing import Literal, TypedDict

from pydantic import BaseModel, ConfigDict, ValidationError


class _Registry(BaseModel):
    model_config = ConfigDict(strict=True, extra='ignore')
    format: str
    ver: str


class _GameRegistry(_Registry):
    activePackId: str


class _MenuRegistry(_Registry):
    activeMenuId: str
    liftedRows: list[str]
    engineOwned: bool = False


class Artifact(TypedDict):
    kind: Literal['gamelogic', 'statusmenu']
    id: str | None
    format: str | None
    version: str | None
    status: Literal['invalid_metadata', 'unsupported_format', 'missing_embedded_resources', 'needs_host_adapter']
    missing: list[str]


def _entry_texts(book: dict | None) -> Iterator[tuple[str, str | None]]:
    entries = book.get('entries') if book else None
    if isinstance(entries, dict):
        entries = list(entries.values())
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            label = entry.get('comment') or entry.get('name')
            text = entry.get('content')
            if isinstance(label, str):
                yield label, text if isinstance(text, str) else None


def _manifest_text(text: str) -> str:
    # Installed registries carry a leading comment block before JSON.
    lines = iter(text.splitlines(keepends=True))
    for line in lines:
        if line.strip() and not line.lstrip().startswith('#'):
            return line + ''.join(lines)
    return ''


def inspect_tavern_artifacts(book: dict | None) -> list[Artifact]:
    texts: dict[str, list[str | None]] = {}
    for name, text in _entry_texts(book):
        texts.setdefault(name, []).append(text)
    found: list[Artifact] = []
    for kind, key, model, versions in (
        ('gamelogic', '[GameLogicPack:Registry]', _GameRegistry, {'1.0', '1.1'}),
        ('statusmenu', '[StatusMenuPack:Registry]', _MenuRegistry, {'1.0'}),
    ):
        if key not in texts:
            continue
        row: Artifact = {'kind': kind, 'id': None, 'version': None, 'format': None,
                         'status': 'invalid_metadata', 'missing': []}
        found.append(row)
        registry_text, *duplicates = texts[key]
        if duplicates or registry_text is None:
            continue
        try:
            registry = model.model_validate_json(_manifest_text(registry_text))
        except ValidationError:
            continue
        ident = registry.activePackId if isinstance(registry, _GameRegistry) else registry.activeMenuId
        if not ident.strip() or not registry.ver.strip():
            continue
        row.update(id=ident, version=registry.ver, format=registry.format)
        if registry.format not in versions:
            row['status'] = 'unsupported_format'
            continue
        if isinstance(registry, _GameRegistry):
            required = ['[MVU_LogicEngine]']
        else:
            required = [f'[StatusMenuPack:{ident}] (Layout)', *(
                f'[MVU_StatusMenuBody:{name}]' for name in registry.liftedRows)]
            if registry.engineOwned:
                required.append('[MVU_StatusMenuEngine]')
        row['missing'] = [name for name in required if len(texts.get(name, ())) != 1 or not (texts[name][0] or '').strip()]
        row['status'] = 'missing_embedded_resources' if row['missing'] else 'needs_host_adapter'
    return found


def artifact_issue(row: Artifact) -> str:
    if row['status'] == 'invalid_metadata':
        return f"The embedded {row['kind']} registry is invalid or repeated."
    if row['status'] == 'unsupported_format':
        return f"The embedded {row['kind']} format {row['format']} is not recognized."
    if row['status'] == 'missing_embedded_resources':
        return f"The embedded {row['kind']} package is missing or repeats: {', '.join(row['missing'])}."
    if row['kind'] == 'statusmenu':
        return 'The card declares an embedded StatusMenu package and its expected entries. This host cannot mount it yet; downloading modules again will not make the menu available.'
    return 'The card declares an embedded GameLogic package and its expected entries. This host cannot run it yet; downloading modules again will not run it.'
