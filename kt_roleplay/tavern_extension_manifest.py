"""Read the public SillyTavern UI extension manifest without loading its code."""
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator

from .errors import CardError
from .script_dependencies import scan_modules

_Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class TavernExtensionManifest(BaseModel):
    model_config = ConfigDict(strict=True, extra='ignore')

    display_name: _Text
    author: _Text
    js: _Text
    css: _Text | None = None
    version: _Text | None = None
    homePage: _Text | None = None
    loading_order: int | None = None
    minimum_client_version: _Text | None = None
    dependencies: list[_Text] = Field(default_factory=list)
    requires: list[_Text] = Field(default_factory=list)
    optional: list[_Text] = Field(default_factory=list)
    i18n: dict[_Text, _Text] = Field(default_factory=dict)
    hooks: dict[_Text, _Text] = Field(default_factory=dict)
    generate_interceptor: _Text | None = None

    @field_validator('js', 'css')
    @classmethod
    def local_path(cls, path: str | None) -> str | None:
        if path is None:
            return None
        return _local_path(path)

    @field_validator('i18n')
    @classmethod
    def locale_paths(cls, paths: dict[str, str]) -> dict[str, str]:
        return {locale: _local_path(path) for locale, path in paths.items()}


def _local_path(path: str) -> str:
    value = path.removeprefix('./')
    if (any(c in value for c in '\\:?#%') or any(ord(c) < 32 for c in value)
            or any(part in ('', '.', '..') for part in value.split('/'))):
        raise ValueError('Expected a path inside the extension directory')
    return value


def inspect_tavern_extension(manifest: object, source: object) -> dict:
    try:
        parsed = TavernExtensionManifest.model_validate(manifest)
    except ValidationError as exc:
        error = exc.errors(include_input=False)[0]
        where = '.'.join(map(str, error['loc'])) or 'manifest'
        raise CardError(f'Invalid SillyTavern extension manifest at {where}: {error["msg"]}') from exc
    requires = [*(f'extension:{key}' for key in parsed.dependencies), *(f'extras:{key}' for key in parsed.requires)]
    if parsed.generate_interceptor:
        requires.append('host:generate_interceptor')
    requires.extend(f'host:hooks.{hook}' for hook in parsed.hooks)
    entry = None
    if source is not None:
        if not isinstance(source, str):
            raise CardError('The optional extension entry must be JavaScript text')
        refs, invalid, truncated = scan_modules(source)
        entry = {'references': refs, 'syntaxError': invalid, 'truncated': truncated}
    return {'manifest': parsed.model_dump(exclude_none=True), 'entry': entry, 'declaredRequirements': requires,
            'hostApiUsage': 'not_inspected', 'status': 'inspection_only'}
