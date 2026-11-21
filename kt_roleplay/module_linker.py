"""Link saved modules to an ESM snapshot without giving the bundler a source filesystem."""

from collections.abc import Callable
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urljoin, urlsplit

from .card_scripts import CardScript
from .errors import CardError
from .library import CardNotFound, original_card
from .module_download import _module_target, exact_module_path
from .module_library import PackagedModuleMissing, module_sources, read_packaged_module
from .script_dependencies import scan_modules

# Older saves may have stored now-supported root paths as dependency_unsupported.
RETRYABLE_MODULE_ISSUES = frozenset({"module_dependency", "dependency_missing", "dependency_unapproved_transitive",
                                    "module_linker_unavailable", "module_link_failed", "dependency_unsupported"})


class ModuleLinkError(ValueError):
    pass


def _root_module_url(parent: str, spec: str) -> str:
    """Resolve a root path on a cached HTTPS module, never on an inline card or archive."""
    if (not parent.lower().startswith('https://') or not spec.startswith('/') or spec.startswith('//')
            or '\\' in spec or '#' in spec):
        raise ModuleLinkError('dependency_unsupported')
    try:
        parts = urlsplit(spec)
        # Do not cache paths the browser might normalize to a different target.
        if (not exact_module_path(parts.path, parts.query) or '//' in parts.path or ';' in parts.path
                or (spec.endswith('?') and not parts.query)
                or any(segment.lower().replace('%2e', '.') in ('.', '..') for segment in parts.path.split('/'))):
            raise ValueError
        url = urljoin(parent, spec)
        _module_target(url)
    except ValueError as exc:
        raise ModuleLinkError('dependency_unsupported') from exc
    return url


def _virtual_graph(entry: str, remote: dict[str, bytes], original: bytes, *,
                   prepare: Callable[[str], bytes | None] | None = None) -> tuple[list[str], list[dict[str, int]]]:
    names = ["card.json"]
    code = [entry]
    indexes = {}
    edges: list[dict[str, int]] = []
    for i, js in enumerate(code):
        refs, syntax_error, truncated = scan_modules(js)
        if syntax_error or truncated:
            raise ModuleLinkError("dependency_unsupported")
        if any(ref['dynamic'] for ref in refs):
            raise ModuleLinkError('dependency_dynamic_import')
        scope = {}
        targets = {}
        for ref in refs:
            spec = ref["specifier"]
            if spec is None:
                raise ModuleLinkError("dependency_unsupported")
            parent = names[i]
            if ref['kind'] == 'unsupported':
                name = _root_module_url(parent, spec)
            elif ref['kind'] == 'relative' and parent.lower().startswith('https://'):
                name = urljoin(parent, spec)
            else:
                name = spec
            targets[spec] = name
        for spec, name in targets.items():
            if name.lower().startswith('https://'):
                data = remote.get(name)
                if data is None and prepare is not None:
                    data = prepare(name)
                    if data is None:
                        continue
                    remote[name] = data
                if data is None:
                    raise ModuleLinkError("dependency_missing" if i == 0 else "dependency_unapproved_transitive")
            else:
                try:
                    name, data = read_packaged_module(original, parent, spec)
                except PackagedModuleMissing as exc:
                    raise ModuleLinkError("dependency_missing") from exc
                except CardError as exc:
                    raise ModuleLinkError("dependency_unsupported") from exc
            if name not in indexes:
                indexes[name] = len(code)
                names.append(name)
                code.append(data.decode("utf-8-sig"))
            scope[spec] = indexes[name]
        edges.append(scope)
    return code, edges


def _bundle(source: list[str], edges: list[dict[str, int]], *, max_output_bytes: int | None = None) -> str:
    runner = Path(__file__).with_name("link_card_module.mjs")
    node = shutil.which("node")
    if node is None or not (runner.parent.parent / "node_modules" / "rolldown").is_dir():
        raise ModuleLinkError("module_linker_unavailable")
    env = {k: os.environ[k] for k in ("SYSTEMROOT", "WINDIR", "PATH") if k in os.environ}
    try:
        process = subprocess.run([node, str(runner)], cwd=runner.parent, env=env,
                                 input=json.dumps({"sources": source, "edges": edges}, ensure_ascii=True).encode("ascii"),
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8)
    except OSError as exc:
        raise ModuleLinkError("module_linker_unavailable") from exc
    except subprocess.TimeoutExpired as exc:
        raise ModuleLinkError("module_link_failed") from exc
    if process.returncode == 20:
        raise ModuleLinkError("module_linker_unavailable")
    if process.returncode == 21:
        raise ModuleLinkError("dependency_missing")
    if process.returncode or not process.stdout:
        raise ModuleLinkError("module_link_failed")
    if max_output_bytes is not None and len(process.stdout) > max_output_bytes:
        raise ModuleLinkError("dependency_limit")
    return process.stdout.decode("utf-8")


def link_card_scripts(directory: Path, card_id: str, scripts: list[CardScript]) -> list[CardScript]:
    remote, original = None, None
    resolved = []
    for script in scripts:
        if script.module or not script.enabled or (script.issue is not None and script.issue not in RETRYABLE_MODULE_ISSUES):
            resolved.append(script)
            continue
        refs, _, _ = scan_modules(script.content)
        if not refs:
            resolved.append(script)
            continue
        try:
            if remote is None or original is None:
                remote = module_sources(directory, card_id)
                original = original_card(directory, card_id)
            code = _bundle(*_virtual_graph(script.content, remote, original))
            resolved.append(script.model_copy(update={"content": code, "issue": None, "module": True}))
        except CardNotFound:
            resolved.append(script.model_copy(update={"issue": "dependency_missing"}))
        except ModuleLinkError as exc:
            resolved.append(script.model_copy(update={"issue": str(exc)}))
    return resolved
