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
  const mvuEvents = Object.freeze({VARIABLE_UPDATE_STARTED:'mag_variable_update_started', COMMAND_PARSED:'mag_command_parsed',
    SINGLE_VARIABLE_UPDATED:'mag_variable_updated', VARIABLE_UPDATE_ENDED:'mag_variable_update_ended'});
  const deferred = new Set(['mag_variable_initialized','mag_before_message_update']);
  const inactive = new Set();
  const allowed = new Set([...Object.values(phases), ...Object.values(mvuEvents)]);
  const handlers = [];
  const buttonRows = clone(buttons);
  let published = false;
  let state = values, firing = false, result;
  const validButton = n => typeof n === 'string' && n.trim() === n && n.length > 0 && Array.from(n).length <= 80;
  const buttonEvent = name => {
    if (!validButton(name)) throw new Error('Invalid card script button name');
    return 'button:' + name;
  };
  const on = (name, fn) => {
    if (firing || typeof fn !== 'function' || handlers.length >= 32)
      throw new Error('Unsupported card script event registration');
    if (deferred.has(name)) { inactive.add(name); return; }
    if (!allowed.has(name) && !(typeof name === 'string' && name.startsWith('button:') && validButton(name.slice(7))))
      throw new Error('Unsupported card script event registration');
    handlers.push([name, fn]);
  };
  const appendButtons = rows => {
    if (!Array.isArray(rows) || rows.length > 8) throw new Error('Expected up to eight card script buttons');
    const next = buttonRows.slice();
    for (const row of rows) {
      if (!row || !validButton(row.name) || typeof row.visible !== 'boolean')
        throw new Error('Expected button name and visibility');
      if (!next.some(button => button.name === row.name)) next.push({name:row.name, visible:row.visible});
    }
    if (next.length > 8) throw new Error('Only eight buttons per card script can be published');
    if (next.length === buttonRows.length) return;
    if (event === 'mvu') throw new Error('Cannot publish buttons during an MVU settlement');
    buttonRows.splice(0, buttonRows.length, ...next);
    published = true;
  };
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
    Mvu: {value: Object.freeze({events:Object.freeze({...mvuEvents, VARIABLE_INITIALIZED:'mag_variable_initialized',
      BEFORE_MESSAGE_UPDATE:'mag_before_message_update'})})},
    eventOn: {value: on},
    eventOnButton: {value: (name, fn) => on(buttonEvent(name), fn)},
    getScriptButtons: {value: () => clone(buttonRows)},
    appendInexistentScriptButtons: {value: appendButtons},
    _: {configurable:true, writable:true, value: Object.freeze({remove(list, predicate) {
      if (!Array.isArray(list) || typeof predicate !== 'function') throw new Error('Expected an array and a predicate');
      const indexes = [], removed = [];
      for (let i = 0, length = list.length; i < length; i++) {
        if (predicate(list[i], i, list)) { indexes.push(i); removed.push(list[i]); }
      }
      for (let i = indexes.length - 1; i >= 0; i--) list.splice(indexes[i], 1);
      return removed;
    }})},
    getButtonEvent: {value: buttonEvent},
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
        result = stringify({status:'ok', handled, values:state, inactive:[...inactive],
          listensMvu:handlers.some(([n]) => Object.values(mvuEvents).includes(n)), buttons:published ? buttonRows : undefined});
      } catch (error) {
        result = stringify({status: error instanceof MissingGlobal ? 'unsupported_api' : 'script_error'});
      }
    },
    hasMvu: name => handlers.some(([key]) => key === name),
    inactiveEvents: () => stringify([...inactive]),
    mvu: async (name, rawState, rawDetail) => {
      firing = true;
      result = undefined;
      state = parse(rawState);
      const detail = parse(rawDetail);
      const frame = {get stat_data() {return state;}, set stat_data(next) {state = next;}};
      if (name === mvuEvents.VARIABLE_UPDATE_ENDED) frame.display_data = detail.display;
      const commands = detail?.commands;
      try {
        for (const [key, fn] of handlers) {
          if (key !== name) continue;
          if (name === mvuEvents.VARIABLE_UPDATE_STARTED) await fn(frame);
          else if (name === mvuEvents.COMMAND_PARSED) await fn(frame, commands, detail.text);
          else if (name === mvuEvents.SINGLE_VARIABLE_UPDATED) await fn(state, detail.path, clone(detail.old), clone(detail.next));
          else if (name === mvuEvents.VARIABLE_UPDATE_ENDED) await fn(frame, {stat_data:clone(detail.before)});
        }
        result = stringify({status:'ok', values:state, commands, display:detail?.forwardDisplay ? frame.display_data : undefined});
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


def read_result(context, deadline, limit=_MAX_RESULT):
    drain(context, deadline)
    result = context.eval('__kt_card_worker.result();')
    if not isinstance(result, str) or len(result.encode('utf-8')) > limit:
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
