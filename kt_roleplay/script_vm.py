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
  const mvuEvents = Object.freeze({VARIABLE_UPDATE_STARTED:'mag_variable_update_started',
    SINGLE_VARIABLE_UPDATED:'mag_variable_updated', VARIABLE_UPDATE_ENDED:'mag_variable_update_ended'});
  const allowed = new Set([...Object.values(phases), ...Object.values(mvuEvents), ...buttons.map(n => 'button:' + n)]);
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
    Mvu: {value: Object.freeze({events:mvuEvents})},
    eventOn: {value: (name, fn) => {
      if (firing || !allowed.has(name) || typeof fn !== 'function' || handlers.length >= 32)
        throw new Error('Unsupported card script event registration');
      handlers.push([name, fn]);
    }},
    getButtonEvent: {value: n => {
      if (typeof n !== 'string' || !buttons.includes(n)) throw new Error('Unknown card script button');
      return 'button:' + n;
    }},
    getChatMessages: {value: (range, options) => {
      if (range !== -1 && range !== '-1') throw new Error('Only the current chat message (-1) is available');
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
          Object.keys(options).some(key => key !== 'role') ||
          (options.role !== undefined && !['all', 'user', 'assistant'].includes(options.role))))
        throw new Error('Only a user or assistant role filter is available');
      if (!firing || (event !== 'user' && event !== 'assistant') || typeof args?.text !== 'string' ||
          (options?.role && options.role !== 'all' && options.role !== event)) return [];
      return [{role: event, message: args.text, is_hidden: false}];
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
        result = stringify({status:'ok', handled, values:state, listensMvu:handlers.some(([n]) => Object.values(mvuEvents).includes(n))});
      } catch (error) {
        result = stringify({status: error instanceof MissingGlobal ? 'unsupported_api' : 'script_error'});
      }
    },
    hasMvu: name => handlers.some(([key]) => key === name),
    mvu: async (name, rawState, rawDetail) => {
      firing = true;
      result = undefined;
      state = parse(rawState);
      const detail = parse(rawDetail);
      const frame = {get stat_data() {return state;}, set stat_data(next) {state = next;}};
      try {
        for (const [key, fn] of handlers) {
          if (key !== name) continue;
          if (name === mvuEvents.VARIABLE_UPDATE_STARTED) await fn(frame);
          else if (name === mvuEvents.SINGLE_VARIABLE_UPDATED) await fn(state, detail.path, clone(detail.old), clone(detail.next));
          else if (name === mvuEvents.VARIABLE_UPDATE_ENDED) await fn(frame, {stat_data:clone(detail.before)});
        }
        result = stringify({status:'ok', values:state});
      } catch (error) {
        result = stringify({status:error instanceof MissingGlobal ? 'unsupported_api' : 'script_error'});
      } finally { firing = false; }
    },
    result: () => result,
  });
}
"""


class VmFailure(ValueError):
    pass


def drain(context, deadline):
    for _ in range(64):
        if perf_counter() >= deadline:
            break
        if not context.execute_pending_job():
            return
    raise VmFailure('script_limit')


def load_context(payload, deadline):
    import quickjs

    context = quickjs.Context()
    context.set_memory_limit(8 * 1024 * 1024)
    context.set_max_stack_size(256 * 1024)
    context.set_time_limit(0.05)
    data = json.dumps({k: payload[k] for k in ('values', 'event', 'args', 'buttons')}, allow_nan=False)
    context.eval('const __kt_card_worker = (' + _BRIDGE + ')(' + json.dumps(data) + ');')
    if payload.get('module'):
        context.eval("globalThis.__ktModuleStatus = 'pending';")
        context.set('__ktModuleCompletion', context.module(payload['code']))
        context.eval("__ktModuleCompletion.then(() => { __ktModuleStatus = 'ready'; }, "
                     "error => { __ktModuleStatus = error instanceof ReferenceError ? 'unsupported_api' : 'script_error'; });")
        drain(context, deadline)
        stage = context.eval('__ktModuleStatus')
        if stage != 'ready':
            raise VmFailure('script_limit' if stage == 'pending' else stage)
    else:
        context.eval(payload['code'])
        drain(context, deadline)
    return context


def read_result(context, deadline):
    drain(context, deadline)
    result = context.eval('__kt_card_worker.result();')
    if not isinstance(result, str) or len(result.encode('utf-8')) > _MAX_RESULT:
        raise VmFailure('script_limit')
    return json.loads(result)


def execute(payload: dict) -> dict:
    import quickjs

    deadline = perf_counter() + 0.20
    try:
        context = load_context(payload, deadline)
        context.eval('__kt_card_worker.run(); void 0;')
        return read_result(context, deadline)
    except VmFailure as exc:
        return {'status': str(exc)}
    except quickjs.JSException as exc:
        error = str(exc)
        if error.startswith('ReferenceError:'):
            return {'status': 'unsupported_api'}
        return {'status': 'script_limit' if 'interrupted' in error.lower() else 'script_error'}


def main() -> None:
    try:
        mvu = sys.argv[1:] == ['mvu']
        limit = 2 * 1024 * 1024 if mvu else _MAX_INPUT
        raw = sys.stdin.buffer.read(limit + 1)
        if len(raw) > limit:
            result = {'status': 'script_limit'}
        elif mvu:
            # -I excludes the script's directory. Import the trusted package, not card or session paths.
            from pathlib import Path
            sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
            from kt_roleplay.script_mvu import execute_update
            result = execute_update(json.loads(raw))
        else:
            result = execute(json.loads(raw))
    except ImportError as exc:
        result = {'status': 'engine_missing' if exc.name == 'quickjs' else 'worker_dependency_missing'}
    except ValueError as exc:
        result = {'status': 'invalid_update', 'reason': str(exc)} if mvu else {'status': 'script_error'}
    except (KeyError, TypeError, RecursionError):
        result = {"status": "script_error"}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True, allow_nan=False).encode("ascii"))


if __name__ == "__main__":
    main()
