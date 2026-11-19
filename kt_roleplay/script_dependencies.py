"""Discover JavaScript module references without executing or resolving code."""

from typing import Literal, TypedDict
from urllib.parse import urlsplit

from tree_sitter import Language, Node, Parser
from tree_sitter_javascript import language

from .card_scripts import CardScript

_JS = Language(language())
_MAX_REFERENCES = 32
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


def _references(root: Node, source: bytes) -> tuple[list[ModuleReference], bool]:
    pending = [root]
    seen = set()
    references: list[ModuleReference] = []
    while pending:
        node = pending.pop()
        if node.type in ("import_statement", "export_statement") and (arg := node.child_by_field_name("source")):
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
        if len(references) == _MAX_REFERENCES:
            return references, True
        seen.add(key)
        references.append(ModuleReference(specifier=ref, kind=_kind(ref, dynamic), dynamic=dynamic))
    return references, False


def scan_modules(code: str) -> tuple[list[ModuleReference], bool, bool]:
    source = code.encode("utf-8")
    root = Parser(_JS).parse(source).root_node
    references, truncated = _references(root, source)
    return references, root.has_error, truncated


def script_dependencies(scripts: list[CardScript]) -> list[ScriptDependencies]:
    rows = []
    for script in scripts:
        if not script.content:
            continue
        references, syntax_error, truncated = scan_modules(script.content)
        if references or syntax_error:
            rows.append(ScriptDependencies(scriptId=script.id, name=script.name, enabled=script.enabled,
                                           references=references, syntaxError=syntax_error, truncated=truncated))
    return rows
