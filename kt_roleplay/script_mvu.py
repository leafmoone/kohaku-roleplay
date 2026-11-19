"""Process a single MVU update, with isolated card listeners and no intermediate save."""

import json
from time import perf_counter

from .mvu import MvuChange, apply_changes
from .mvu_legacy import apply_literal_update, read_update
from .script_values import assert_js_numbers, validated_script_values
from .script_vm import VmFailure, load_context, read_result

_STARTED = 'mag_variable_update_started'
_PARSED = 'mag_command_parsed'
_UPDATED = 'mag_variable_updated'
_ENDED = 'mag_variable_update_ended'


def _path(parts: list[str]) -> str:
    # Keep common dot paths readable and preserve literal segments containing dots/brackets.
    result = ''
    for part in parts:
        if any(c in part for c in '.[]\\\"\'') or not part:
            result += '[' + json.dumps(part, ensure_ascii=False) + ']'
        else:
            result += ('.' if result else '') + part
    return result


def execute_update(payload: dict) -> dict:
    import quickjs

    before = payload['values']
    listeners = {name: [] for name in (_STARTED, _PARSED, _UPDATED, _ENDED)}
    assert_js_numbers(before)
    deadline = perf_counter() + 1.0
    def check_time():
        if perf_counter() >= deadline:
            raise ValueError('MVU listener transaction exceeded its time limit')
    inactive = {}
    for script in payload['scripts']:
        try:
            check_time()
            context = load_context({**script, 'values': before, 'event': 'mvu', 'args': None}, deadline)
            inactive[script['id']] = json.loads(context.eval('__kt_card_worker.inactiveEvents()'))
            has = context.eval('__kt_card_worker.hasMvu')
            call = context.eval('__kt_card_worker.mvu')
            for name, handlers in listeners.items():
                if has(name):
                    handlers.append((script['id'], context, call))
        except (VmFailure, quickjs.JSException) as exc:
            raise ValueError(f'MVU listener {script["id"]} could not register; update not applied') from exc

    def emit(name, state, detail):
        for number, (script_id, context, call) in enumerate(listeners[name], 1):
            try:
                check_time()
                assert_js_numbers(state)
                assert_js_numbers(detail)
                if name == _ENDED:
                    detail['forwardDisplay'] = number < len(listeners[name])
                call(name, json.dumps(state, allow_nan=False), json.dumps(detail, allow_nan=False))
                # Both state and the optional transient display/command projection cross here.
                result = read_result(context, deadline, limit=144 * 1024)
                if result.get('status') != 'ok':
                    raise VmFailure('script_error')
                state = validated_script_values(state, result['values'])
                if name == _PARSED:
                    selected = result.get('commands')
                    if not isinstance(selected, list):
                        raise ValueError('Expected a list of retained commands')
                    rows = iter(zip(detail['indices'], detail['commands'], strict=True))
                    keep = []
                    for command in selected:
                        index = next((i for i, row in rows if row == command), None)
                        if index is None:
                            raise ValueError('Command listeners may only remove literal commands')
                        keep.append(index)
                    detail.update(commands=selected, indices=keep)
                elif name == _ENDED and detail['forwardDisplay']:
                    detail['display'] = result['display']
            except (ValueError, RecursionError, quickjs.JSException) as exc:
                raise ValueError(f'MVU listener {script_id} failed at {name}; update not applied') from exc
        return state

    def filter_commands(state, commands, text):
        detail = {'commands': commands, 'text': text, 'indices': list(range(len(commands)))}
        return emit(_PARSED, state, detail), detail['indices']

    def changed(state, parts, old, new):
        return emit(_UPDATED, state, {'path': _path(parts), 'old': old, 'next': new})

    state = emit(_STARTED, before, None)
    observer = changed if listeners[_UPDATED] else None
    update = payload['update']
    if isinstance(update, str):
        state = apply_literal_update(state, update, observe=observer,
                                     command_filter=filter_commands if listeners[_PARSED] else None)
    else:
        changes = [MvuChange.model_validate(x) for x in update]
        if listeners[_PARSED]:
            # A typed call has no original message. Render real, reversible literal commands
            # for the filter instead of inventing empty source text or an ambiguous path.
            lines = [f'_.{c.op}({json.dumps(_path(c.path), ensure_ascii=False)}, {json.dumps(c.value, ensure_ascii=False)});' for c in changes]
            body = '\n'.join(lines)
            parsed = read_update(body)
            if [p.change for p in parsed] != changes:
                raise ValueError('This typed path cannot be represented for the command-parsed listener')
            state, keep = filter_commands(state, [p.command for p in parsed], f'<UpdateVariable>\n{body}\n</UpdateVariable>')
            changes = [changes[i] for i in keep]
        state = apply_changes(state, changes, observe=observer)
    state = emit(_ENDED, state, {'before': before, 'display': state})
    return {'status': 'ok', 'values': state, 'inactive': inactive}
