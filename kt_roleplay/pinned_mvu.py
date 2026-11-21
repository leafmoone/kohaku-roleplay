"""Fixed MagVarUpdate/Zod compatibility, separate from ordinary card scripts."""

from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import TYPE_CHECKING

from pydantic import JsonValue

from .card_scripts import CardScript
from .module_library import module_sources
from .mvu import _json_mapping, array_index, existing_key, is_initializer, validate_updated_values
from .mvu_legacy import _body, _MAX_COMMANDS, _PATCH, split_opening
from .mvu_patch import json_equal
from .pinned_mvu_worker import _HOST_GLOBALS
from .script_dependencies import scan_modules
from .script_values import CardScriptError, assert_js_numbers

if TYPE_CHECKING:
    from .cards import ParsedCard

CORE = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'
HELPER = 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js'
PINNED_HELPER = ('https://raw.githubusercontent.com/StageDog/tavern_resource/'
                 'a796a5da2cc5993182d2ed44ddefac156e11af1c/dist/util/mvu_zod.js')
# The floating URL is only a declaration. Execute just this reviewed helper ABI.
_HELPER_DIGEST = 'e540ab99589ad83de1495056a84693bda00af92f8848926bcb9a53b9263a0302'
_CORE_DECLARATION = re.compile(r'\s*import\s+([\'\"])' + re.escape(CORE) + r'\1\s*;?\s*')
_RESERVED = frozenset({'__proto__', 'constructor', 'prototype', '$internal'})


def pinned_author(scripts: list[CardScript]) -> CardScript | None:
    enabled = [script for script in scripts if script.enabled]
    if len(enabled) != 2 or any(s.module or s.issue not in (None, 'module_dependency') for s in enabled):
        return None
    core, author = enabled
    if _CORE_DECLARATION.fullmatch(author.content):
        core, author = author, core
    if not _CORE_DECLARATION.fullmatch(core.content) or not re.search(r'\bregisterMvuSchema\b', author.content):
        return None
    refs, invalid, truncated = scan_modules(author.content, top_level_only=True)
    if not invalid and not truncated and refs == [{'specifier': HELPER, 'dynamic': False, 'kind': 'https'}]:
        return author
    return None


def pinned_card_author(card: 'ParsedCard') -> CardScript | None:
    if card.script_projection_complete is not True:
        return None
    author = pinned_author(card.scripts)
    if author is None or (card.opening_gameplay and card.opening_gameplay.counter):
        return None
    fields = card.fields
    directions = [fields.system_prompt, fields.post_history_instructions, fields.mes_example]
    if card.lore:
        directions.extend(entry.content for entry in card.lore.entries if entry.enabled)
    if not any('<JSONPatch>' in text for text in directions):
        return None
    if any(re.search(r'\b_\.(?:set|add)\s*\(', text) for text in directions):
        return None
    for opening in (fields.first_mes, *fields.alternate_greetings):
        if (block := split_opening(opening)[1]) is not None:
            try:
                if not _PATCH.fullmatch(_body(block)):
                    return None
            except ValueError:
                return None
    return author


def helper_text(body: bytes) -> str:
    if sha256(body).hexdigest() != _HELPER_DIGEST:
        raise CardScriptError('The cached MVU Zod helper is not a supported fixed version')
    return body.decode('utf-8-sig')


def cached_pinned_helper(directory: Path, card_id: str) -> str | None:
    sources = module_sources(directory, card_id)
    if body := sources.get(PINNED_HELPER):
        return helper_text(body)
    if (body := sources.get(HELPER)) and sha256(body).hexdigest() == _HELPER_DIGEST:
        return body.decode('utf-8-sig')
    return None


class PinnedHelperMissing(CardScriptError):
    """The fixed MVU runtime needs its prepared helper."""


def compile_pinned_mvu(directory: Path, card_id: str, author: CardScript) -> str:
    helper = cached_pinned_helper(directory, card_id)
    if helper is None:
        raise PinnedHelperMissing('Prepare card resources before running its MVU Zod schema')
    node = shutil.which('node')
    if node is None:
        raise CardScriptError('The fixed MVU linker requires Node.js and the locked npm dependencies')
    data = json.dumps({'author': author.content, 'helper': helper}, ensure_ascii=True).encode('ascii')
    env = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'WINDIR') if key in os.environ}
    try:
        result = subprocess.run([node, str(Path(__file__).with_name('build_pinned_mvu.mjs'))],
                                input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=12)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CardScriptError('The fixed MVU linker did not complete') from exc
    if result.returncode or not result.stdout:
        raise CardScriptError('Could not build the fixed MVU runtime; check the locked npm dependencies and card schema')
    return result.stdout.decode('utf-8')


def initializer_entries(book: dict | None) -> list[dict[str, str]]:
    entries = book.get('entries', []) if book else []
    if isinstance(entries, dict):
        entries = list(entries.values())
    return [{'comment': '[InitVar]', 'content': row['content']} for row in entries
            if isinstance(row, dict) and isinstance(row.get('content'), str)
            and is_initializer(row.get('comment'), row.get('name'))]


def _literal_json(value: JsonValue) -> None:
    if isinstance(value, dict):
        if _RESERVED.intersection(value):
            raise CardScriptError('The update uses a reserved MVU key')
        for item in value.values():
            _literal_json(item)
    elif isinstance(value, list):
        for item in value:
            _literal_json(item)


def canonical_patch(values: dict[str, JsonValue], text: str) -> str:
    match = _PATCH.fullmatch(_body(text))
    if not match:
        raise CardScriptError('The fixed MVU profile needs one literal <JSONPatch> array')
    commands = json.loads(match[1], object_pairs_hook=_json_mapping)
    if not isinstance(commands, list) or not 1 <= len(commands) <= _MAX_COMMANDS:
        raise CardScriptError('Expected a nonempty bounded MVU JSON Patch array')
    assert_js_numbers(commands)
    trial = deepcopy(values)
    pending = []
    for row in commands:
        if not isinstance(row, dict):
            raise CardScriptError('An MVU patch operation must be an object')
        op, path = row.get('op'), row.get('path')
        keys = {'op', 'path'} if op == 'remove' else {'op', 'path', 'value'}
        if (op not in ('add', 'replace', 'remove') or row.keys() != keys or not isinstance(path, str)
                or not path.startswith('/') or re.search(r'~(?![01])', path)):
            raise CardScriptError('Only literal add, replace and remove with valid JSON Pointer are supported')
        parts = [t.replace('~1', '/').replace('~0', '~') for t in path[1:].split('/')]
        if not 1 <= len(parts) <= 16 or any(not p or p.startswith('$') or p in _RESERVED for p in parts):
            raise CardScriptError('Invalid fixed MVU patch path')
        parent: JsonValue = trial
        for key in parts[:-1]:
            parent = parent[existing_key(parent, key)]
        leaf = parts[-1]
        if op == 'remove':
            del parent[existing_key(parent, leaf)]
        else:
            value = row['value']
            _literal_json(value)
            if op == 'add' and isinstance(parent, list):
                parent.insert(array_index(leaf, len(parent), inserting=True), deepcopy(value))
            elif op == 'add' and isinstance(parent, dict) and leaf not in parent:
                parent[leaf] = deepcopy(value)
            elif op == 'replace':
                key = existing_key(parent, leaf)
                if json_equal(parent[key], value):
                    continue
                parent[key] = deepcopy(value)
            else:
                raise CardScriptError('MVU add must insert a new member; use replace for an existing value')
        pending.append(row)
    if not pending:
        return ''
    # Prevent the upstream tag scanner and literal-expression fallback from seeing user syntax.
    body = json.dumps(pending, ensure_ascii=True, allow_nan=False).replace('<','\\u003c').replace('_','\\u005f')
    return '<JSONPatch>' + body + '</JSONPatch>'


def calculate_pinned_mvu(code: str, entries: list[dict[str, str]], values: dict[str, JsonValue],
                         update: str | None) -> dict[str, JsonValue]:
    assert_js_numbers(values)
    data = {'entries': entries, 'values': values, 'update': canonical_patch(values, update) if update is not None else None}
    payload = json.dumps({'code': code, 'data': data}, ensure_ascii=True, allow_nan=False).encode('ascii')
    worker = Path(__file__).with_name('pinned_mvu_worker.py')
    env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR') if key in os.environ}
    try:
        result = subprocess.run([sys.executable, '-I', '-B', str(worker)], input=payload, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=env, timeout=3)
        answer = json.loads(result.stdout) if result.returncode == 0 and result.stdout else None
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        raise CardScriptError('The fixed MVU worker failed; nothing was saved') from exc
    if not isinstance(answer, dict) or answer.get('status') != 'ok' or not isinstance(answer.get('values'), dict):
        if isinstance(answer, dict) and answer.get('status') == 'rejected':
            raise CardScriptError('The author MVU schema rejected the update; nothing was saved')
        if isinstance(answer, dict) and answer.get('status') == 'unsupported_host':
            name = answer.get('name')
            if isinstance(name, str) and name in _HOST_GLOBALS:
                raise CardScriptError(f'The card MVU script requires the host interface {name!r}, which is not available in the fixed runtime; no variable changes were saved')
        raise CardScriptError('The fixed MVU worker did not return a valid candidate; nothing was saved')
    candidate = answer['values']
    assert_js_numbers(candidate)
    return validate_updated_values(candidate)
