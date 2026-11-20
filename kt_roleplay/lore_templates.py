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

_TAG = re.compile(r'<%([_#=-]?)(.*?)([_-]?)%>', re.S)
_IF = re.compile(r'@@if[ \t]+([^\r\n]+)(?:\r?\n|\Z)')
_TOKEN = re.compile(r'''//[^\r\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(?P<player>\??\.<user>)''')


def is_template(text: str) -> bool:
    return '<%' in text or text.startswith(('@@if ', '@@if\t'))


def compile_template(text: str) -> str | None:
    """Compile read-only prompt tags and leading conditions, without module loads."""
    try:
        return _compile(text)
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
    while match := _IF.match(text, end):
        condition = match[1]
        if '<%' in condition:
            return None
        chunks.append('if (!(' + _TOKEN.sub(_player_property, condition) + '\n)) return;')
        end = match.end()
    trim = ''
    while (start := text.find('<%', end)) != -1:
        tag = _TAG.match(text, start)
        if tag is None or '<%' in tag[2] or (not tag[1] and tag[2].startswith(('%', '~', ':'))):
            return None
        literal = text[end:start]
        if trim == '_':
            literal = literal.lstrip()
        elif trim == '-':
            literal = re.sub(r'^\r?\n', '', literal)
        if tag[1] == '_':
            literal = literal.rstrip()
        chunks.append('$ktOutput(' + json.dumps(literal) + ');')
        code = _TOKEN.sub(_player_property, tag[2])
        if tag[1] in ('=', '-'):
            # Both tags insert text during prompt generation, not browser HTML.
            chunks.append('$ktOutput((' + code.rstrip().removesuffix(';') + '\n));')
        elif tag[1] != '#':
            chunks.append(code)
        end, trim = tag.end(), tag[3]
    tail = text[end:]
    if not end:
        return None
    if trim == '_':
        tail = tail.lstrip()
    elif trim == '-':
        tail = re.sub(r'^\r?\n', '', tail)
    chunks.append('$ktOutput(' + json.dumps(tail) + ');')
    compiled = 'async ($ktOutput, getvar, _, $ktPlayer) => {\n' + '\n'.join(chunks) + '\n}'
    refs, invalid, truncated = scan_modules(compiled)
    return None if refs or invalid or truncated else compiled


def render_templates(texts: list[str], values: dict, player: str) -> tuple[dict[str, str], int]:
    """Return only successful nonempty renderings, and count failed entries for diagnostics."""
    authored = Counter(texts)
    pairs = [(text, program) for text in authored if (program := compile_template(text)) is not None]
    failed = len(texts) - sum(authored[text] for text, _ in pairs)
    if not pairs:
        return {}, failed
    try:
        payload = json.dumps({'programs': [program for _, program in pairs], 'values': values, 'player': player},
                             ensure_ascii=True, allow_nan=False).encode('ascii')
        worker = Path(__file__).with_name('script_vm.py')
        env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR') if key in os.environ}
        try:
            result = subprocess.run([sys.executable, '-I', '-B', str(worker), 'lore'], cwd=worker.parent, env=env,
                                    input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
            wire = result.stdout
        except subprocess.TimeoutExpired as exc:
            wire = exc.stdout or b''
    except (OSError, ValueError, RecursionError):
        return {}, len(texts)
    # A timed-out worker may have completed earlier entries. Keep its complete responses.
    output = {}
    rendered = wire.split(b'\n')[:-1]
    for index, (text, _) in enumerate(pairs):
        try:
            body = json.loads(rendered[index]) if index < len(rendered) else None
        except (ValueError, RecursionError):
            body = None
        if not isinstance(body, str) or '<%' in body:
            failed += authored[text]
        elif body.strip():
            output[text] = body
    return output, failed
