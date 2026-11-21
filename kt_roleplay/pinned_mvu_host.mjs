// The pinned calculation owns only a detached MVU frame, never the KT save.
import { bridge } from './pinned_mvu_globals.mjs';
import lodash from 'lodash';
import { createEmptyGameData, loadInitVarData } from './vendor/magvarupdate/src/function/initvar/variable_init.ts';
import { cleanUpMetadata, generateSchema } from './vendor/magvarupdate/src/function/schema.ts';
import { updateVariables } from './vendor/magvarupdate/src/function/update_variables.ts';
import { variable_events } from './vendor/magvarupdate/src/variable_def.ts';
import 'kt:mvu-author';

globalThis.__ktPinnedMvu = async raw => {
  const { entries, values, update } = JSON.parse(raw);
  const frame = createEmptyGameData();
  if (update === null) {
    bridge.setEntries(entries);
    if (!await loadInitVarData(frame, ['card'])) throw new Error('No supported [InitVar] data');
  } else {
    frame.stat_data = values;
  }
  frame.schema = generateSchema(lodash.cloneDeep(frame.stat_data), frame.schema);
  if (update === null) {
    cleanUpMetadata(frame.stat_data);
    await eventEmit(variable_events.VARIABLE_INITIALIZED, frame, 0);
  } else if (update !== '') {
    await updateVariables(update, frame);
  }
  return JSON.stringify(bridge.result(frame));
};
