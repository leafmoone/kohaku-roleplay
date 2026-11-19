"""Data-only worker for opted-in card scripts. No Python callbacks or module loader."""

import json
import sys
from time import perf_counter

_MAX_INPUT = 128 * 1024
_MAX_RESULT = 64 * 1024

_BRIDGE = r"""
(raw) => {
  const {values, event, args, buttons} = JSON.parse(raw);
  const parse = JSON.parse, stringify = JSON.stringify, MissingGlobal = ReferenceError;
  const clone = v => parse(stringify(v));
  const phases = Object.freeze({CHAT_CHANGED:'opening', MESSAGE_SENT:'user', MESSAGE_RECEIVED:'assistant', KT_TOOL:'tool'});
  const allowed = new Set([...Object.values(phases), ...buttons.map(n => 'button:' + n)]);
  const handlers = [];
  let state = values, firing = false, result;
  const scope = opts => {
    if (opts !== undefined && (!opts || typeof opts !== 'object' || (opts.type !== undefined && opts.type !== 'chat')))
      throw new Error('Only current-session variables are available');
  };
  const get = opts => { scope(opts); return clone(state); };
  const set = (next, opts) => {
    scope(opts);
    if (!firing) throw new Error('Register handlers before changing variables');
    state = clone(next);
  };
  Object.defineProperties(globalThis, {
    tavern_events: {value: phases},
    eventOn: {value: (name, fn) => {
      if (firing || !allowed.has(name) || typeof fn !== 'function' || handlers.length >= 32)
        throw new Error('Unsupported card script event registration');
      handlers.push([name, fn]);
    }},
    getButtonEvent: {value: n => {
      if (typeof n !== 'string' || !buttons.includes(n)) throw new Error('Unknown card script button');
      return 'button:' + n;
    }},
    getVariables: {value: get},
    replaceVariables: {value: set},
    updateVariablesWith: {value: (fn, opts) => {
      const copy = get(opts), next = fn(copy);
      if (next != null && typeof next.then === 'function')
        return Promise.resolve(next).then(v => set(v === undefined ? copy : v, opts));
      set(next === undefined ? copy : next, opts);
    }},
  });
  return Object.freeze({
    run: async () => {
      if (firing) throw new Error('Card script already invoked');
      firing = true;
      try {
        let handled = false;
        for (const [name, fn] of handlers) {
          if (name !== event) continue;
          handled = true;
          await fn(clone(args));
        }
        result = stringify({status:'ok', handled, values:state});
      } catch (error) {
        result = stringify({status: error instanceof MissingGlobal ? 'unsupported_api' : 'script_error'});
      }
    },
    result: () => result,
  });
}
"""


def execute(payload: dict) -> dict:
    # This module is launched as a subprocess with a scrubbed environment and a wall-time limit.
    import quickjs

    context = quickjs.Context()
    context.set_memory_limit(8 * 1024 * 1024)
    context.set_max_stack_size(256 * 1024)
    context.set_time_limit(0.05)
    deadline = perf_counter() + 0.20
    data = json.dumps({k: payload[k] for k in ("values", "event", "args", "buttons")}, ensure_ascii=True, allow_nan=False)
    try:
        context.eval("const __kt_card_worker = (" + _BRIDGE + ")(" + json.dumps(data) + ");")
        if payload.get("module"):
            context.eval("globalThis.__ktModuleStatus = 'pending';")
            completion = context.module(payload["code"])
            context.set("__ktModuleCompletion", completion)
            context.eval("__ktModuleCompletion.then(() => { __ktModuleStatus = 'ready'; }, "
                         "error => { __ktModuleStatus = error instanceof ReferenceError ? 'unsupported_api' : 'script_error'; });")
            for _ in range(64):
                if perf_counter() >= deadline:
                    return {"status": "script_limit"}
                if not context.execute_pending_job():
                    break
            stage = context.eval("__ktModuleStatus")
            if stage != "ready":
                return {"status": "script_limit" if stage == "pending" else stage}
        else:
            context.eval(payload["code"])
        context.eval("__kt_card_worker.run(); void 0;")
        for _ in range(64):
            if perf_counter() >= deadline:
                return {"status": "script_limit"}
            if not context.execute_pending_job():
                break
        else:
            return {"status": "script_limit"}
        result = context.eval("__kt_card_worker.result();")
    except quickjs.JSException as exc:
        error = str(exc)
        if error.startswith("ReferenceError:"):
            return {"status": "unsupported_api"}
        return {"status": "script_limit" if "interrupted" in error.lower() else "script_error"}
    if not isinstance(result, str) or len(result.encode("utf-8")) > _MAX_RESULT:
        return {"status": "script_limit"}
    return json.loads(result)


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(_MAX_INPUT + 1)
        result = execute(json.loads(raw)) if len(raw) <= _MAX_INPUT else {"status": "script_limit"}
    except ImportError:
        result = {"status": "engine_missing"}
    except (KeyError, TypeError, ValueError, RecursionError):
        result = {"status": "script_error"}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True, allow_nan=False).encode("ascii"))


if __name__ == "__main__":
    main()
