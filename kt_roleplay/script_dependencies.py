"""Discover JavaScript module references without executing or resolving code."""

from typing import Literal, NotRequired, TypedDict
from urllib.parse import urlsplit

from tree_sitter import Language, Node, Parser
from tree_sitter_javascript import language

from .card_scripts import CardScript

_JS = Language(language())
_ReferenceKind = Literal["https", "relative", "unsupported"]


class ModuleReference(TypedDict):
    specifier: str | None
    kind: _ReferenceKind
    dynamic: bool


class ScriptDependencies(TypedDict):
    scriptId: str
    name: str
    enabled: bool
    references: list[ModuleReference]
    syntaxError: bool
    truncated: bool
    compatibilityNotes: NotRequired[list[str]]


def _literal(node: Node | None, source: bytes) -> str | None:
    if node is None or node.type != "string":
        return None
    if len(node.named_children) != 1 or node.named_children[0].type != "string_fragment":
        return None
    value = source[node.start_byte + 1:node.end_byte - 1].decode("utf-8")
    if not value or len(value) > 2048 or any(char.isspace() or ord(char) < 32 for char in value):
        return None
    return value


def _kind(specifier: str | None, dynamic: bool) -> _ReferenceKind:
    if dynamic or specifier is None:
        return "unsupported"
    if specifier.startswith(("./", "../")):
        return "relative"
    try:
        url = urlsplit(specifier)
        if url.scheme == "https" and url.hostname and not url.username and not url.password and not url.fragment:
            return "https"
    except ValueError:
        pass
    return "unsupported"


def _references(root: Node, source: bytes, *, top_level_only: bool = False) -> tuple[list[ModuleReference], bool]:
    pending = [root]
    seen = set()
    references: list[ModuleReference] = []
    while pending:
        node = pending.pop()
        if node.type in ("import_statement", "export_statement") and (arg := node.child_by_field_name("source")):
            if top_level_only and node.parent != root:
                return [], True
            dynamic = False
        elif (node.type == "call_expression" and (callee := node.child_by_field_name("function"))
              and callee.type == "import"):
            dynamic = True
            args = node.child_by_field_name("arguments")
            arg = next((child for child in args.named_children if child.type != "comment"), None) if args else None
            if args:
                pending.append(args)
        else:
            pending.extend(reversed(node.named_children))
            continue
        ref = _literal(arg, source)
        key = (ref, dynamic)
        if key in seen:
            continue
        seen.add(key)
        references.append(ModuleReference(specifier=ref, kind=_kind(ref, dynamic), dynamic=dynamic))
    return references, False


def _schema_helper(root: Node, source: bytes) -> bool:
    # A named import identifies the public API (including local aliases), not a keyword in prose.
    for statement in root.named_children:
        if statement.type != 'import_statement':
            continue
        spec = _literal(statement.child_by_field_name('source'), source)
        if _kind(spec, False) != 'https' or urlsplit(spec).path.rsplit('/', 1)[-1] not in ('mvu_zod.js', 'mvu_zod.mjs'):
            continue
        for clause in statement.named_children:
            if clause.type != 'import_clause':
                continue
            for names in clause.named_children:
                if names.type == 'named_imports' and any(
                    (name := item.child_by_field_name('name')) is not None and name.text == b'registerMvuSchema'
                    for item in names.named_children
                ):
                    return True
    return False


def _scan(code: str, *, top_level_only: bool = False) -> tuple[Node, bytes, list[ModuleReference], bool]:
    source = code.encode('utf-8')
    root = Parser(_JS).parse(source).root_node
    refs, truncated = _references(root, source, top_level_only=top_level_only)
    return root, source, refs, truncated


def scan_modules(code: str, *, top_level_only: bool = False) -> tuple[list[ModuleReference], bool, bool]:
    root, _, references, truncated = _scan(code, top_level_only=top_level_only)
    return references, root.has_error, truncated


def script_dependencies(scripts: list[CardScript]) -> list[ScriptDependencies]:
    rows = []
    for script in scripts:
        if not script.content:
            continue
        root, source, references, truncated = _scan(script.content)
        if references or root.has_error:
            row = ScriptDependencies(scriptId=script.id, name=script.name, enabled=script.enabled,
                                     references=references, syntaxError=root.has_error, truncated=truncated)
            if b'registerMvuSchema' in source and _schema_helper(root, source):
                row['compatibilityNotes'] = ['external_mvu_zod_schema']
            rows.append(row)
    return rows
