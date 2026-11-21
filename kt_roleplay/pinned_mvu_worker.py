"""Run one prepared MVU calculation with no Python callbacks or host objects."""

import json
import sys
from time import perf_counter


def main() -> None:
    import quickjs

    payload = json.load(sys.stdin)
    context = quickjs.Context()
    context.set_memory_limit(48 * 1024 * 1024)
    context.set_max_stack_size(512 * 1024)
    context.set_time_limit(0.3)
    context.eval(payload['code'])
    wire = json.dumps(payload['data'], allow_nan=False)
    context.eval('let ktResult; __ktPinnedMvu(' + json.dumps(wire)
                 + ').then(value => { ktResult = value; });')
    deadline = perf_counter() + 1.1
    for _ in range(128):
        if perf_counter() >= deadline or not context.execute_pending_job():
            break
    value = context.eval('ktResult')
    if isinstance(value, str):
        sys.stdout.buffer.write(value.encode('utf-8'))


if __name__ == '__main__':
    main()
