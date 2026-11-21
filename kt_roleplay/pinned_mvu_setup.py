"""One pre-turn character setup for the fixed MVU game-start panel protocol."""
from __future__ import annotations

import html
from html.parser import HTMLParser
import json
import re
from collections.abc import Iterator

from pydantic import BaseModel, ConfigDict, JsonValue
from tree_sitter import Parser

from .mvu_patch import json_equal
from .script_dependencies import _JS
from .script_values import CardScriptError

SETUP_MARKER = '<GameStartMenu/>'
_FIELDS = frozenset({
    'Name', 'Age', 'Gender', 'Race', 'Occupation', 'Strength', 'Agility', 'Constitution',
    'Intelligence', 'Wisdom', 'Charisma', 'Core-points', 'Inventory', 'Equipment',
    'Level', 'Hp_max', 'Hp_curr', 'Sta_max', 'Sta_curr', 'Mp_max', 'Mp_curr',
    'Physical_attack', 'Magic_attack', 'Physical_defense', 'Magic_defense', 'Magic_assist',
})
_USER_MACRO = '{{user}}'
_ATTR = re.compile(r'\svalue="(\{\{user\}\})"(?=[\s/>])', re.I)


class _SetupMacros(HTMLParser):
    def __init__(self, source: str):
        super().__init__(convert_charrefs=False)
        self.offsets = [0, *(m.end() for m in re.finditer('\n', source))]
        self.script = False
        self.positions: dict[int, bool] = {}
        self.feed(source)
        self.close()

    def _source_offset(self) -> int:
        line, column = self.getpos()
        return self.offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        self.script = tag == 'script' and all(name != 'src' for name, _ in attrs)
        if tag == 'input' and dict(attrs).get('value') == _USER_MACRO:
            matches = list(_ATTR.finditer(self.get_starttag_text()))
            if len(matches) == 1:
                self.positions[self._source_offset() + matches[0].start(1)] = False

    def handle_endtag(self, tag):
        if tag == 'script':
            self.script = False

    def handle_data(self, data):
        if not self.script or _USER_MACRO not in data:
            return
        body = data.encode()
        root = Parser(_JS).parse(body).root_node
        if root.has_error:
            return
        nodes = [root]
        offset = self._source_offset()
        while nodes:
            node = nodes.pop()
            if node.type == 'string' and node.text == b"'{{user}}'":
                self.positions[offset + len(body[:node.start_byte + 1].decode())] = True
            else:
                nodes.extend(node.named_children)


def _setup_macros(source: str) -> dict[int, bool] | None:
    tokens = {m.start() for m in re.finditer(r'\{\{', source)}
    if not tokens:
        return {}
    try:
        params = _SetupMacros(source).positions
    except (AssertionError, UnicodeError):
        return None
    return params if params.keys() == tokens else None


def supported_setup_template(source: str) -> bool:
    return _setup_macros(source) is not None


def render_setup_template(source: str, user: str) -> str:
    params = _setup_macros(source)
    if params is None:
        raise CardScriptError('Unsupported character setup macro')
    encoded = json.dumps(user, ensure_ascii=True).replace('<', '\\u003c')
    for start, in_script in sorted(params.items(), reverse=True):
        if in_script:
            source = source[:start - 1] + encoded + source[start + len(_USER_MACRO) + 1:]
        else:
            source = source[:start] + html.escape(user, quote=True) + source[start + len(_USER_MACRO):]
    return source


def setup_projection(values: dict[str, JsonValue]) -> dict[str, JsonValue] | None:
    if not isinstance(main := values.get('Mainchar'), dict) or type(values.get('GameStarted')) is not bool:
        return None
    if not {'Name', 'Inventory', 'Equipment'} <= main.keys():
        return None
    return {'GameStarted': values['GameStarted'], 'Mainchar': {k: v for k, v in main.items() if k in _FIELDS}}


class MvuSetupWrite(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    statData: dict[str, JsonValue]


def _diff(old: JsonValue, new: JsonValue, path: str) -> Iterator[dict[str, JsonValue]]:
    if isinstance(old, dict) and isinstance(new, dict):
        for key in dict.fromkeys([*old, *new]):
            p = path + '/' + key.replace('~', '~0').replace('/', '~1')
            if key not in old:
                yield {'op': 'add', 'path': p, 'value': new[key]}
            elif key not in new:
                yield {'op': 'remove', 'path': p}
            else:
                yield from _diff(old[key], new[key], p)
    elif isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        for i, (left, right) in enumerate(zip(old, new, strict=True)):
            yield from _diff(left, right, f'{path}/{i}')
    elif not json_equal(old, new):
        yield {'op': 'replace', 'path': path, 'value': new}


def _starter_weapon(value: JsonValue) -> bool:
    return (isinstance(value, dict) and value.get('Type') == 'Weapon'
            and value.get('Slot') == 'Hand' and type(value.get('Qty')) is int and value['Qty'] == 1)


def _check_setup_fields(before: dict, after: dict) -> None:
    for key, old in before.items():
        new = after[key]
        if json_equal(old, new):
            continue
        if key in ('Inventory', 'Equipment') and isinstance(old, dict) and isinstance(new, dict):
            removed = [old[name] for name in old.keys() - new.keys()]
            added = [new[name] for name in new.keys() - old.keys()]
            changed = [name for name in old.keys() & new.keys() if not json_equal(old[name], new[name])]
            if (not changed and len(removed) <= 2 and len(added) <= (1 if key == 'Inventory' else 0)
                    and all(_starter_weapon(item) for item in [*removed, *added])):
                continue
        elif (isinstance(old, list) and isinstance(new, list) and old and len(old) == len(new)
              and json_equal(old[1:], new[1:])):
            # Keep tuple labels/metadata; the author's schema checks the played value.
            continue
        raise CardScriptError('The opening setup may edit played values and choose a starter weapon only')


def setup_update(before: dict[str, JsonValue], after: dict[str, JsonValue]) -> str:
    if (before.get('GameStarted') is not False or after.get('GameStarted') is not True
            or after.keys() != before.keys() or not isinstance(main := after.get('Mainchar'), dict)
            or main.keys() != before['Mainchar'].keys()):
        raise CardScriptError('The opening setup must keep its declared fields and start the game once')
    _check_setup_fields(before['Mainchar'], main)
    patch = list(_diff(before, after, ''))
    return '<UpdateVariable><JSONPatch>' + json.dumps(patch, allow_nan=False).replace('<', '\\u003c') + '</JSONPatch></UpdateVariable>'


def setup_preserved(before: dict[str, JsonValue], after: dict[str, JsonValue]) -> bool:
    def private(values):
        return {**{k: v for k, v in values.items() if k not in ('GameStarted', 'Mainchar')},
                'Mainchar': {k: v for k, v in values['Mainchar'].items() if k not in _FIELDS}}
    old, new = setup_projection(before), setup_projection(after)
    if not old or not new or new['GameStarted'] is not True or not json_equal(private(before), private(after)):
        return False
    if old['Mainchar'].keys() != new['Mainchar'].keys():
        return False
    _check_setup_fields(old['Mainchar'], new['Mainchar'])
    return True
