"""The fixed MVU status-page profile: a display projection and a local DOM alias."""
from __future__ import annotations

from html.parser import HTMLParser
import re

from pydantic import BaseModel, ConfigDict, JsonValue
from tree_sitter import Parser

from .card_web import WebPanel
from .script_dependencies import _JS

STATUS_MARKER = '<StatusPlaceHolderImpl/>'
_BINDING = re.compile(r'(Mainchar|World)\.([A-Za-z][A-Za-z0-9_-]*)')
_ROOTS = ('Mainchar', 'World')
_BAR_FIELDS = {'Hp_curr', 'Hp_max', 'Sta_curr', 'Sta_max', 'Mp_curr', 'Mp_max'}
_FIELDS = {
    'World': {'Date', 'Location', 'Time', 'Weather'},
    'Mainchar': _BAR_FIELDS | {'Age', 'Agility', 'Charisma', 'Constitution', 'Core-points', 'Exp', 'Gender',
                              'Intelligence', 'Level', 'Magic_assist', 'Magic_attack', 'Magic_defense', 'Mental_state',
                              'Name', 'Occupation', 'Physical_attack', 'Physical_defense', 'Race', 'Strength', 'Wisdom'},
}
_BAR_ATTRS = {'data-bind-bar', 'data-bind-bar-max', 'data-bind-curr', 'data-bind-max'}
_BOUND_ATTRS = _BAR_ATTRS | {'data-bind-fullpath', 'data-bind-list-fullpath'}
_INERT = {'iframe', 'noembed', 'noscript', 'textarea', 'title', 'template', 'xmp', 'plaintext'}
_LOCAL_WINDOW = '''
// The real parent remains across an opaque-origin boundary. The author's
// local DOM lookups instead use the same document as the status module.
const window = new Proxy(Object.create(null), {
  get(_facade, key) {
    if (key === "parent") return window;
    const value = Reflect.get(globalThis, key, globalThis);
    return typeof value === "function" ? value.bind(globalThis) : value;
  },
  set(_facade, key, value) { return Reflect.set(globalThis, key, value, globalThis); }
});
'''


class StatusPanel(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    panel: WebPanel
    fields: dict[str, list[str]]
    inventory: bool

    def project(self, values: dict[str, JsonValue]) -> dict[str, JsonValue]:
        result = {}
        for root, fields in self.fields.items():
            source = values.get(root)
            if root in _FIELDS and isinstance(source, dict):
                result[root] = {field: source[field] for field in fields
                                if field in _FIELDS[root] and field in source and _simple(source[field])}
        main = values.get('Mainchar')
        if self.inventory and isinstance(main, dict) and isinstance(inventory := main.get('Inventory'), dict):
            result.setdefault('Mainchar', {})['Inventory'] = {
                name: {'Qty': item['Qty']} for name, item in inventory.items()
                if isinstance(item, dict) and type(item.get('Qty')) is int and item['Qty'] >= 0
            }
        return result


def _simple(value: JsonValue) -> bool:
    if isinstance(value, list):
        # MVU display tuple: played value and its author label.
        return len(value) == 2 and not isinstance(value[0], (dict, list)) and isinstance(value[1], str)
    return not isinstance(value, dict)


class _StatusLayout(HTMLParser):
    def __init__(self, source: str):
        super().__init__(convert_charrefs=False)
        self.lines = [0, *(m.end() for m in re.finditer('\n', source))]
        self.module: tuple[int, int] | None = None
        self._start: int | None = None
        self._inert: list[str] = []
        self.valid = True
        self.fields: dict[str, set[str]] = {root: set() for root in _ROOTS}
        self.inventory = False
        self.portrait = False
        self._div_paths: list[tuple[int, str | None]] = []
        self.feed(source)
        self.close()

    def _offset(self) -> int:
        line, column = self.getpos()
        return self.lines[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if tag in _INERT:
            self._inert.append(tag)
        if tag == 'script':
            if self._inert or self._start is not None or self.module is not None or attrs != [('type', 'module')]:
                self.valid = False
            else:
                self._start = self._offset() + len(self.get_starttag_text())
        # The author instantiates template bindings; other inert/raw-text
        # subtrees do not describe a supported display field.
        if any(parent != 'template' for parent in self._inert):
            return
        depth = len(self._inert)
        if tag == 'div':
            self._div_paths.append((depth, dict(attrs).get('data-bind-fullpath')))
        if tag == 'img' and [v for k, v in attrs if k == 'data-bind-img'] == ['Image']:
            path = next((p for d, p in reversed(self._div_paths) if d == depth and p is not None), None)
            self.portrait |= path == 'Mainchar.Image'
        seen: set[str] = set()
        for key, value in attrs:
            if key in _BOUND_ATTRS and key in seen:
                self.valid = False
            seen.add(key)
            if not value:
                continue
            if key == 'data-bind-fullpath' and (match := _BINDING.fullmatch(value)):
                root, field = match.groups()
                if field in _FIELDS[root]:
                    self.fields[root].add(field)
            if key in _BAR_ATTRS and value in _BAR_FIELDS:
                self.fields['Mainchar'].add(value)
            if key == 'data-bind-list-fullpath' and value == 'Mainchar.Inventory':
                self.inventory = True

    def handle_endtag(self, tag):
        if tag == 'div' and self._div_paths and self._div_paths[-1][0] == len(self._inert):
            self._div_paths.pop()
        if tag == 'script' and self._start is not None:
            end = self._offset()
            if end <= self._start:
                self.valid = False
            self.module = (self._start, end)
            self._start = None
        if self._inert and tag == self._inert[-1]:
            while self._div_paths and self._div_paths[-1][0] == len(self._inert):
                self._div_paths.pop()
            self._inert.pop()


def _has_supported_status_module(code: str) -> bool:
    root = Parser(_JS).parse(code.encode()).root_node
    if root.has_error:
        return False
    pending = [root]
    while pending:
        node = pending.pop()
        if node.type in ('import_statement', 'export_statement'):
            return False
        if node.type in ('class_declaration', 'function_declaration', 'generator_function_declaration', 'variable_declarator'):
            # Binding patterns can contain nested destructuring. The alias is
            # intentionally not inserted into any document which declares window.
            binding = node.child_by_field_name('name')
            if binding is not None and re.search(rb'\bwindow\b', binding.text or b''):
                return False
        pending.extend(node.named_children)
    return True


def has_status_portrait(panel: StatusPanel) -> bool:
    try:
        layout = _StatusLayout(panel.panel.html)
        return layout.valid and layout.portrait
    except (AssertionError, UnicodeError):
        return False


def status_panel(panel: WebPanel) -> StatusPanel | None:
    try:
        layout = _StatusLayout(panel.html)
    except (AssertionError, UnicodeError):
        return None
    if (not layout.valid or layout.module is None or 'Name' not in layout.fields['Mainchar'] or not layout.fields['World']):
        return None
    start, end = layout.module
    if not _has_supported_status_module(panel.html[start:end]):
        return None
    source = panel.html[:start] + _LOCAL_WINDOW + panel.html[start:]
    return StatusPanel(panel=panel.model_copy(update={'html': source}),
                       fields={key: sorted(values) for key, values in layout.fields.items()}, inventory=layout.inventory)
