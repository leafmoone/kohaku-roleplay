"""Describe the two Tavern Helper declarations; importing a card does not run them."""

import re
from hashlib import sha256

from pydantic import BaseModel, ConfigDict, Field

_LOCAL_IMPORT = re.compile(r"(?m)(?:^|;)\s*(?:import\s*(?:\(|[\"'{*]|[\w$.]+\s+from\b)|export\s+[^\n]*\bfrom\b)")
_MAX_CODE_BYTES = 64 * 1024
_MAX_SCRIPTS = 12


class ScriptButton(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')
    name: str = Field(min_length=1, max_length=80)
    visible: bool


class CardScript(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=100)
    content: str
    enabled: bool
    buttons: list[str] = Field(default_factory=list, max_length=8)
    buttons_enabled: bool = True
    issue: str | None = None
    module: bool = False

    def view(self) -> dict[str, object]:
        view = self.model_dump(exclude={'content', 'buttons_enabled'})
        if not self.buttons_enabled:
            view['buttons'] = []
        return view


def _card_script_rows(extensions: dict | None) -> list:
    if not isinstance(extensions, dict):
        return []
    helper = extensions.get('tavern_helper')
    rows = helper.get('scripts') if isinstance(helper, dict) else None
    if not isinstance(rows, list):
        rows = extensions.get('TavernHelper_scripts')
    return rows if isinstance(rows, list) else []


def script_projection_complete(extensions: dict | None) -> bool:
    # A strict engine profile must account for all enabled author scripts,
    # including entries the bounded legacy execution/list view did not project.
    for index, item in enumerate(_card_script_rows(extensions)):
        if not isinstance(item, dict):
            continue
        data = item.get('value', item)
        if not isinstance(data, dict) or data.get('enabled') is not True:
            continue
        if (index >= _MAX_SCRIPTS or item.get('type', data.get('type', 'script')) != 'script'
                or not isinstance(data.get('content'), str)):
            return False
    return True


def inspect_card_scripts(extensions: dict | None) -> list[CardScript]:
    raw = _card_script_rows(extensions)
    result = []
    seen = set()
    for index, item in enumerate(raw[:_MAX_SCRIPTS]):
        if not isinstance(item, dict) or item.get("type", "script") != "script":
            continue
        data = item.get("value", item)
        if not isinstance(data, dict) or not isinstance(code := data.get("content"), str):
            continue
        name = data.get("name")
        name = name.strip()[:100] if isinstance(name, str) else ""
        name = name.encode("utf-8", errors="replace").decode("utf-8")
        key = data.get("id")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", key) or key in seen:
            key = f"card-script-{index + 1}"
        while key in seen:
            key += "-"
        seen.add(key)
        issue = None
        try:
            code_size = len(code.encode("utf-8"))
        except UnicodeError:
            code_size = _MAX_CODE_BYTES + 1
        if not code.strip() or code_size > _MAX_CODE_BYTES:
            code, issue = "", "invalid_script"
        elif _LOCAL_IMPORT.search(code):
            issue = "module_dependency"
        group = data.get('button')
        buttons = data.get('buttons', group)
        buttons_enabled = not isinstance(group, dict) or group.get('enabled', True) is True
        if isinstance(buttons, dict):
            buttons_enabled = buttons_enabled and buttons.get('enabled', True) is True
            buttons = buttons.get('buttons', [])
        visible = []
        if isinstance(buttons, list):
            for button in buttons[:8]:
                title = button.get("name") if isinstance(button, dict) else button
                if isinstance(button, dict) and button.get("visible") is False:
                    continue
                if isinstance(title, str) and 0 < len(title.strip()) <= 80 and title.strip() not in visible:
                    visible.append(title.strip().encode("utf-8", errors="replace").decode("utf-8"))
        result.append(CardScript(id=key, name=name or f"Script {index + 1}", content=code,
                                 enabled=data.get('enabled') is True, buttons=visible, buttons_enabled=buttons_enabled, issue=issue))
    return result


def visible_script_buttons(script: CardScript, appended: list[ScriptButton]) -> list[str]:
    if not script.buttons_enabled:
        return []
    return [*script.buttons, *(row.name for row in appended if row.visible)]


def script_fingerprint(bundle: list[CardScript]) -> str:
    """Scope explicit consent to this version of the declared scripts, not just a card name."""
    def encode(script: CardScript) -> str:
        omitted = set()
        if not script.module:
            omitted.add('module')
        if script.buttons_enabled:
            # Existing snapshots had implicit permission for their visible buttons.
            omitted.add('buttons_enabled')
        return script.model_dump_json(ensure_ascii=True, exclude=omitted)

    return sha256('\x1e'.join(map(encode, bundle)).encode('ascii')).hexdigest()
