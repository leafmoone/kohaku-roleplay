"""Expose configured endpoints of an independently running local Tavern plugin."""

import json
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlencode

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, ValidationError, model_validator

PluginId = Annotated[str, Field(pattern=r'^[A-Za-z0-9_-]{1,64}$')]
EndpointPath = Annotated[str, Field(pattern=r'^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$', max_length=160)]
Method = Literal['GET', 'POST']
_MAX_JSON = 256 * 1024


class LegacyEndpoint(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    method: Method
    path: EndpointPath


class LegacyProvider(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    port: int = Field(ge=1, le=65535)
    endpoints: list[LegacyEndpoint] = Field(min_length=1, max_length=32)


class LegacyRequest(LegacyEndpoint):
    pluginId: PluginId
    query: dict[str, str] = Field(default_factory=dict, max_length=32)
    body: JsonValue = None

    @model_validator(mode='after')
    def check_method(self) -> 'LegacyRequest':
        if self.method == 'GET' and 'body' in self.model_fields_set:
            raise ValueError('A GET plugin request cannot carry a body')
        return self


class LegacySelection(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    pluginIds: list[PluginId] = Field(max_length=16)


class LegacyPluginError(ValueError):
    pass


_PROVIDERS = TypeAdapter(dict[PluginId, LegacyProvider])


def configured_plugins(directory: Path) -> dict[str, LegacyProvider]:
    path = directory / 'legacy-tavern-plugins.json'
    try:
        with path.open('rb') as file:
            data = file.read(_MAX_JSON + 1)
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise LegacyPluginError('Could not read legacy-tavern-plugins.json') from exc
    if len(data) > _MAX_JSON:
        raise LegacyPluginError('legacy-tavern-plugins.json is too large')
    try:
        return _PROVIDERS.validate_json(data)
    except ValidationError as exc:
        issue = exc.errors(include_input=False)[0]
        at = '.'.join(map(str, issue['loc']))
        raise LegacyPluginError(f"Invalid legacy-tavern-plugins.json at {at}: {issue['msg']}") from exc


def _reject_constant(value: str) -> None:
    raise ValueError(f'{value} is not a JSON number')


def request_plugin(providers: dict[str, LegacyProvider], call: LegacyRequest) -> dict[str, JsonValue]:
    provider = providers.get(call.pluginId)
    if provider is None:
        raise LegacyPluginError(f'Legacy plugin {call.pluginId} is not configured')
    if not any(row.method == call.method and row.path == call.path for row in provider.endpoints):
        raise LegacyPluginError('The plugin route or method is not enabled on this host')
    query = urlencode(call.query)
    if len(query) > 4096:
        raise LegacyPluginError('Plugin query is too large')
    path = f'/api/plugins/{call.pluginId}/{call.path}' + ('?' + query if query else '')
    headers = {'Accept': 'application/json'}
    body = None
    if 'body' in call.model_fields_set:
        try:
            body = json.dumps(call.body, allow_nan=False).encode('ascii')
        except (ValueError, RecursionError) as exc:
            raise LegacyPluginError('Plugin body is not JSON data') from exc
        if len(body) > _MAX_JSON:
            raise LegacyPluginError('Plugin body is too large')
        headers['Content-Type'] = 'application/json'
    # Never forward browser headers, credentials or arbitrary destinations; do not follow redirects.
    connection = HTTPConnection('127.0.0.1', provider.port, timeout=3)
    try:
        connection.request(call.method, path, body=body, headers=headers)
        reply = connection.getresponse()
        raw = reply.read(_MAX_JSON + 1)
        status, content_type = reply.status, reply.headers.get_content_type()
    except (OSError, HTTPException) as exc:
        raise LegacyPluginError(f'Could not reach local plugin {call.pluginId}') from exc
    finally:
        connection.close()
    if len(raw) > _MAX_JSON:
        raise LegacyPluginError('Plugin response is too large')
    if not raw:
        return {'status': status, 'body': None}
    if content_type != 'application/json' and not content_type.endswith('+json'):
        raise LegacyPluginError(f'Plugin returned HTTP {status} without a JSON response')
    try:
        data = json.loads(raw, parse_constant=_reject_constant)
        # JSON numeric exponents can overflow even when NaN tokens are prohibited.
        json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, RecursionError) as exc:
        raise LegacyPluginError(f'Plugin returned invalid JSON with HTTP {status}') from exc
    return {'status': status, 'body': data}
