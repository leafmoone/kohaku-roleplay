import lodash from 'lodash';
import * as YAML from 'yaml';
import * as z from 'zod';

const listeners = new Map();
let entries, schema;
let rejected = false;
const reject = () => { rejected = true; };
const quiet = () => {};
Object.assign(globalThis, {
  _: lodash, YAML, z,
  console: { warn: reject, error: reject, info: quiet, log: quiet },
  toastr: { warning: reject, error: reject },
  substitudeMacros: text => text,
  SillyTavern: { saveChat() { throw new Error('Candidate cannot write session data'); } },
  $: value => {
    if (typeof value === 'function') return value();
    if (value === '#mvu_notification_error') return { prop: key => key === 'checked' };
    throw new Error('No browser DOM in a pinned MVU calculation');
  },
  getLorebookEntries: name => {
    if (name !== 'card') throw new Error('Unexpected lorebook');
    return entries;
  },
  registerVariableSchema: (next, scope) => {
    if (scope.type !== 'message') throw new Error('Unexpected MVU scope');
    schema = next;
  },
  eventOn: (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  },
  eventEmit: async (name, ...args) => {
    if (name === 'mag_command_parsed_for_zod') args = [...args.slice(0, 3), reject];
    for (const callback of listeners.get(name) || []) await callback(...args);
    // The helper clears leftovers in its next event. Do not allow that to
    // turn an unhandled input into a successful transaction.
    if (name === 'mag_command_parsed_for_zod' && args[1].length) reject();
  },
});

export const bridge = {
  setEntries(value) { entries = value; },
  result(frame) {
    if (rejected || !schema?.safeParse(frame).success) return {status:'rejected'};
    return {status:'ok', values:frame.stat_data};
  },
};
