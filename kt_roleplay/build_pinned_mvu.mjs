// Assemble the offline MVU candidate. This process compiles source; QuickJS runs it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const input = JSON.parse(readFileSync(0, 'utf8'));
const here = fileURLToPath(new URL('.', import.meta.url));
const upstream = resolve(here, 'vendor/magvarupdate');
const dependencies = new Map([
  ['compare-versions@6.1.1', 'compare-versions'], ['json5@2.2.3', 'json5'],
  ['jsonrepair@3.15.0', 'jsonrepair'], ['zod/v4/core', 'zod/v4/core'], ['klona@2.0.6', 'klona'],
].map(([name, target]) => [`https://testingcf.jsdelivr.net/npm/${name}/+esm`, target]));
const helper = 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
const embedded = new Map([
  ['kt:mvu-author', input.author], ['kt:mvu-helper', input.helper],
  ['@/store', 'export function useDataStore(){return {settings:{通知:{变量更新出错:true}}}}'],
  ['@/i18n', 'export function tr(key){return key}'],
  // Only canonical JSONPatch text is sent to this runtime. Never evaluate math expressions.
  ['mathjs', 'export function evaluate(){throw Error("Expressions are disabled")} export function isComplex(){return false} export function isMatrix(){return false}'],
]);
const entry = resolve(here, 'pinned_mvu_host.mjs');
const build = await rolldown({input:entry, cwd:here, platform:'browser', plugins:[{
  name:'pinned-mvu-closure',
  async resolveId(id, importer) {
    if (id === helper && importer === '\0kt:mvu-author') return '\0kt:mvu-helper';
    if (importer === '\0kt:mvu-author') throw new Error('Unexpected author module');
    if (embedded.has(id)) return '\0'+id;
    if (dependencies.has(id)) return this.resolve(dependencies.get(id), entry);
    if (id.startsWith('https://')) throw new Error('Unexpected external module');
    if (id.startsWith('@/')) return this.resolve(resolve(upstream,'src',id.slice(2)), importer);
    if (id.startsWith('@util/')) return this.resolve(resolve(upstream,'util',id.slice(6)), importer);
  },
  load(id) { if (id.startsWith('\0')) return embedded.get(id.slice(1)); },
}], onLog(level, log, report) {
  if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
  if (level === 'error') report(level, log);
}});
try {
  const {output} = await build.generate({format:'iife', codeSplitting:false, minify:true});
  if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('Expected an offline bundle');
  process.stdout.write(output[0].code);
} finally {
  await build.close();
}
