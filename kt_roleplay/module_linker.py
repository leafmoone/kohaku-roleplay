"""Link saved modules to an ESM snapshot without giving the bundler a source filesystem."""

import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urljoin

from .card_scripts import CardScript
from .errors import CardError
from .library import CardNotFound, original_card
from .module_library import MAX_CARD_MODULES, PackagedModuleMissing, module_sources, read_packaged_module
from .script_dependencies import scan_modules

_MAX_LINK_BYTES = 3 * 1024 * 1024
_MAX_SCRIPT_BYTES = 64 * 1024
RETRYABLE_MODULE_ISSUES = frozenset({"module_dependency", "dependency_missing", "dependency_unapproved_transitive",
                                    "module_linker_unavailable", "module_link_failed"})


class ModuleLinkError(ValueError):
    pass


def _virtual_graph(entry: str, remote: dict[str, bytes], original: bytes) -> tuple[list[str], list[dict[str, int]]]:
    names = ["card.json"]
    code = [entry]
    indexes = {}
    edges: list[dict[str, int]] = []
    total = len(entry.encode("utf-8"))
    for i, js in enumerate(code):
        refs, syntax_error, truncated = scan_modules(js)
        if syntax_error or truncated or any(ref["kind"] == "unsupported" or ref["specifier"] is None for ref in refs):
            raise ModuleLinkError("dependency_unsupported")
        scope = {}
        for ref in refs:
            spec = ref["specifier"]
            if spec is None:
                raise ModuleLinkError("dependency_unsupported")
            parent = names[i]
            if ref["kind"] == "https" or parent.startswith("https://"):
                name = urljoin(parent, spec) if ref["kind"] == "relative" else spec
                data = remote.get(name)
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
                total += len(data)
                if len(indexes) >= MAX_CARD_MODULES or total > _MAX_LINK_BYTES:
                    raise ModuleLinkError("dependency_limit")
                indexes[name] = len(code)
                names.append(name)
                code.append(data.decode("utf-8-sig"))
            scope[spec] = indexes[name]
        edges.append(scope)
    return code, edges


def _bundle(source: list[str], edges: list[dict[str, int]], *, max_output_bytes: int = _MAX_SCRIPT_BYTES) -> str:
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
    if process.returncode or not process.stdout:
        raise ModuleLinkError("module_link_failed")
    if len(process.stdout) > max_output_bytes:
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
