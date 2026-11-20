"""One explicitly approved schema-derived string for the legacy opening snapshot."""

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from .author_opening import OpeningSchemaGrant
from .card_scripts import CardScript
from .module_library import module_sources
from .module_linker import ModuleLinkError, _bundle
from .mvu import validate_updated_values
from .mvu_patch import json_equal
from .opening_page_library import _installed_lodash_module
from .script_dependencies import scan_modules
from .script_tool import _worker_result
from .script_values import CardScriptError, assert_js_numbers

# The compatibility adapter replaces this reviewed registration API, not the
# upstream helper's initialization, command filtering, or event implementation.
_HELPER_URL = 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js'
_MAX_BUNDLE = 256 * 1024

_PRELUDE = '''
import zod from 'kt:installed-zod-classic';
import lodash from 'kt:installed-lodash';
Object.defineProperties(globalThis, {
    z: {value: zod}, _: {value: lodash}, $: {value: fn => fn()}
});
'''
_REGISTRATION = '''
let schema;
export function registerMvuSchema(next) {
    if (schema || !next || typeof next.parse !== 'function') throw new TypeError('Expected one schema');
    schema = next;
}
export function parseRegistered(input) {
    if (!schema) throw new TypeError('No schema was registered');
    return schema.parse(input);
}
'''


class OpeningSchemaSnapshot(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    grant: OpeningSchemaGrant
    code: str = Field(min_length=1, max_length=_MAX_BUNDLE)
    value: str = Field(min_length=1, max_length=1024)
    input_ids: list[str] | None = None  # None keeps legacy API snapshots on the full state.


def _one_https_dependency(source: str) -> str:
    refs, syntax_error, truncated = scan_modules(source)
    if (syntax_error or truncated or len(refs) != 1 or refs[0]['kind'] != 'https'
            or refs[0]['dynamic'] or refs[0]['specifier'] is None):
        raise ModuleLinkError('dependency_unsupported')
    return refs[0]['specifier']


def link_opening_schema(directory: Path, card_id: str, scripts: list[CardScript], grant: OpeningSchemaGrant) -> str:
    script = next((item for item in scripts if item.id == grant.scriptId and item.enabled), None)
    if script is None or script.issue not in (None, 'module_dependency'):
        raise ModuleLinkError('dependency_unsupported')
    url = _one_https_dependency(script.content)
    cached = module_sources(directory, card_id)
    if url not in cached:
        raise ModuleLinkError('dependency_missing')
    try:
        source = cached[url].decode('utf-8-sig')
    except UnicodeError as exc:
        raise ModuleLinkError('dependency_unsupported') from exc
    if _one_https_dependency(source) != _HELPER_URL:
        raise ModuleLinkError('dependency_unsupported')
    root = '''import 'kt:prelude'; import 'kt:declaration';
import { parseRegistered } from 'kt:schema';
const parse = JSON.parse, stringify = JSON.stringify;
Object.defineProperty(globalThis, '__kt_parse_schema', {value: raw => stringify(parseRegistered(parse(raw)))});
'''
    return _bundle([root, _PRELUDE, script.content, source, _REGISTRATION, _installed_lodash_module()],
                   [{'kt:prelude': 1, 'kt:declaration': 2, 'kt:schema': 4},
                    {'kt:installed-zod-classic': -1, 'kt:installed-lodash': 5}, {url: 3}, {_HELPER_URL: 4}, {}, {}],
                   max_output_bytes=_MAX_BUNDLE)


def _parent(values: dict[str, JsonValue], path: list[str]) -> dict[str, JsonValue]:
    for part in path[:-1]:
        child = values.get(part)
        if not isinstance(child, dict):
            raise CardScriptError('The derived field needs an existing variable object')
        values = child
    return values


def derive_opening_schema(code: str, values: dict[str, JsonValue], grant: OpeningSchemaGrant) -> str:
    assert_js_numbers(values)
    leaf = grant.outputPath[-1]
    if leaf in _parent(values, grant.outputPath):
        raise CardScriptError('The derived field must not replace a declared variable')
    proposal = _worker_result({'code': code, 'values': values}, schema=True).get('values')
    if not isinstance(proposal, dict):
        raise CardScriptError('The opening schema did not return an object')
    derived = _parent(proposal, grant.outputPath).pop(leaf, None)
    try:
        validate_updated_values(proposal)
        derived_bytes = len(derived.encode('utf-8')) if isinstance(derived, str) else 0
    except (ValueError, RecursionError) as exc:
        raise CardScriptError('The opening schema returned invalid variable data') from exc
    if not 0 < derived_bytes <= 1024:
        raise CardScriptError('The opening schema did not return the authorized derived string')
    if not json_equal(values, proposal):
        raise CardScriptError('The selected schema would change declared variables outside the opening counter')
    return derived


def with_opening_schema_output(values: dict[str, JsonValue], snapshot: OpeningSchemaSnapshot) -> dict[str, JsonValue]:
    # Copy only the parent chain; this projection must never change stored MVU.
    result = values.copy()
    current = result
    for part in snapshot.grant.outputPath[:-1]:
        child = current.get(part)
        if not isinstance(child, dict):
            return values
        current[part] = child.copy()
        current = current[part]
    current.setdefault(snapshot.grant.outputPath[-1], snapshot.value)
    return result
