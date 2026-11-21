"""Run one prepared MVU calculation with no Python callbacks or host objects."""

import json
import re
import sys
from time import perf_counter


_HOST_GLOBALS = frozenset({'window', 'document', 'fetch', 'localStorage', 'tavern_events', 'getChatMessages'})
_MISSING_NAME = re.compile(r"ReferenceError: '?([A-Za-z_][A-Za-z0-9_]*)'? is not defined")


def _report_missing_host(error: str) -> None:
    line = error.partition('\n')[0]
    match = _MISSING_NAME.fullmatch(line)
    if match and match[1] in _HOST_GLOBALS:
        sys.stdout.write(json.dumps({'status': 'unsupported_host', 'name': match[1]}))


def main() -> None:
    import quickjs

    payload = json.load(sys.stdin)
    context = quickjs.Context()
    context.set_memory_limit(48 * 1024 * 1024)
    context.set_max_stack_size(512 * 1024)
    context.set_time_limit(0.3)
    try:
        context.eval(payload['code'])
        wire = json.dumps(payload['data'], allow_nan=False)
        context.eval('let ktResult, ktError; __ktPinnedMvu(' + json.dumps(wire)
                     + ').then(value => { ktResult = value; }, error => { ktError = String(error); });')
        deadline = perf_counter() + 1.1
        for _ in range(128):
            if perf_counter() >= deadline or not context.execute_pending_job():
                break
        value = context.eval('ktResult')
    except quickjs.JSException as exc:
        _report_missing_host(str(exc))
        return
    if isinstance(value, str):
        sys.stdout.buffer.write(value.encode('utf-8'))
    elif isinstance(error := context.eval('ktError'), str):
        _report_missing_host(error)


if __name__ == '__main__':
    main()
