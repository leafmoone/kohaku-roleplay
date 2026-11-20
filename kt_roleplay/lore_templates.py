"""A read-only subset of legacy prompt templates for authored world-info text."""

import json
import os
import re
import subprocess
import sys
from collections import Counter
from functools import lru_cache
from pathlib import Path

from .script_dependencies import scan_modules

MAX_TEMPLATES = 32
MAX_TEMPLATE_BYTES = 64 * 1024
MAX_TEMPLATE_RESULT = 16 * 1024
_TAG = re.compile(r'<%([_#]?)(.*?)([_-]?)%>', re.S)
_TOKEN = re.compile(r'''//[^\r\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(?P<player>\??\.<user>)''')


def compile_template(text: str) -> str | None:
    """Compile control tags and trim markers; reject other EJS tags and module loads."""
    try:
        return _compile(text) if len(text.encode('utf-8')) <= MAX_TEMPLATE_BYTES else None
    except (UnicodeError, RecursionError):
        return None


def _player_property(match: re.Match[str]) -> str:
    if not match['player']:
        return match[0]
    return ('?.' if match[0].startswith('?.') else '') + '[$ktPlayer]'


@lru_cache(maxsize=128)
def _compile(text: str) -> str | None:
    chunks = []
    end = 0
    trim = ''
    while (start := text.find('<%', end)) != -1:
        tag = _TAG.match(text, start)
        if tag is None or '<%' in tag[2] or tag[2].startswith(('=', '-', '%', '~', ':')):
            return None
        literal = text[end:start]
        if trim == '_':
            literal = literal.lstrip()
        elif trim == '-':
            literal = re.sub(r'^\r?\n', '', literal)
        if tag[1] == '_':
            literal = literal.rstrip()
        chunks.append('$ktOutput(' + json.dumps(literal) + ');')
        if tag[1] != '#':
            chunks.append(_TOKEN.sub(_player_property, tag[2]))
        end, trim = tag.end(), tag[3]
    tail = text[end:]
    if not end:
        return None
    if trim == '_':
        tail = tail.lstrip()
    elif trim == '-':
        tail = re.sub(r'^\r?\n', '', tail)
    chunks.append('$ktOutput(' + json.dumps(tail) + ');')
    compiled = '($ktOutput, getvar, _, $ktPlayer) => {\n' + '\n'.join(chunks) + '\n}'
    refs, invalid, truncated = scan_modules(compiled)
    return None if refs or invalid or truncated else compiled


def render_templates(texts: list[str], values: dict, player: str) -> tuple[dict[str, str], int]:
    """Return only successful nonempty renderings, and count failed entries for diagnostics."""
    authored = Counter(texts)
    pairs = []
    for text in authored:
        if len(pairs) >= MAX_TEMPLATES:
            break
        if program := compile_template(text):
            pairs.append((text, program))
    failed = len(texts) - sum(authored[text] for text, _ in pairs)
    if not pairs:
        return {}, failed
    try:
        payload = json.dumps({'programs': [program for _, program in pairs], 'values': values, 'player': player},
                             ensure_ascii=True, allow_nan=False).encode('ascii')
        worker = Path(__file__).with_name('script_vm.py')
        env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR') if key in os.environ}
        result = subprocess.run([sys.executable, '-I', '-B', str(worker), 'lore'], cwd=worker.parent, env=env,
                                input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
        if result.returncode:
            return {}, len(texts)
        rendered = json.loads(result.stdout)
        if not isinstance(rendered, list) or len(rendered) != len(pairs):
            return {}, len(texts)
        output = {}
        for (text, _), body in zip(pairs, rendered, strict=True):
            if not isinstance(body, str) or '<%' in body or len(body.encode('utf-8')) > MAX_TEMPLATE_RESULT:
                failed += authored[text]
            elif body.strip():
                output[text] = body
        return output, failed
    except (OSError, subprocess.TimeoutExpired, ValueError, RecursionError):
        return {}, len(texts)
