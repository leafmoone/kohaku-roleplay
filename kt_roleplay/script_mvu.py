"""Process a single MVU update, with isolated card listeners and no intermediate save."""

import json
from time import perf_counter

from .mvu import MvuChange, apply_changes
from .mvu_legacy import apply_literal_update
from .script_values import assert_js_numbers, validated_script_values
from .script_vm import VmFailure, load_context, read_result

_STARTED = 'mag_variable_update_started'
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
    listeners = {name: [] for name in (_STARTED, _UPDATED, _ENDED)}
    assert_js_numbers(before)
    deadline = perf_counter() + 1.0
    def check_time():
        if perf_counter() >= deadline:
            raise ValueError('MVU listener transaction exceeded its time limit')
    for script in payload['scripts']:
        try:
            check_time()
            context = load_context({**script, 'values': before, 'event': 'mvu', 'args': None}, deadline)
            has = context.eval('__kt_card_worker.hasMvu')
            call = context.eval('__kt_card_worker.mvu')
            for name, handlers in listeners.items():
                if has(name):
                    handlers.append((script['id'], context, call))
        except (VmFailure, quickjs.JSException) as exc:
            raise ValueError(f'MVU listener {script["id"]} could not register; update not applied') from exc

    def emit(name, state, detail):
        for script_id, context, call in listeners[name]:
            try:
                check_time()
                assert_js_numbers(state)
                assert_js_numbers(detail)
                call(name, json.dumps(state, allow_nan=False), json.dumps(detail, allow_nan=False))
                result = read_result(context, deadline)
                if result.get('status') != 'ok':
                    raise VmFailure('script_error')
                state = validated_script_values(state, result['values'])
            except (ValueError, RecursionError, quickjs.JSException) as exc:
                raise ValueError(f'MVU listener {script_id} failed at {name}; update not applied') from exc
        return state

    def changed(state, parts, old, new):
        return emit(_UPDATED, state, {'path': _path(parts), 'old': old, 'next': new})

    state = emit(_STARTED, before, None)
    observer = changed if listeners[_UPDATED] else None
    update = payload['update']
    if isinstance(update, str):
        state = apply_literal_update(state, update, observe=observer)
    else:
        state = apply_changes(state, [MvuChange.model_validate(x) for x in update], observe=observer)
    state = emit(_ENDED, state, {'before': before})
    return {'status': 'ok', 'values': state}
