// Bundle approved card edges and, when chosen, a fixed installed opening runtime.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
let rolldown;
try {
  ({ rolldown } = await import('rolldown'));
} catch {
  process.exit(20);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { sources, edges } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const prefix = '\0kt-card:';
const entry = prefix + '0';
const zodLink = 'kt:installed-zod-classic';
const zodId = '\0kt-runtime:zod-classic';
const zodRoot = fileURLToPath(new URL('../node_modules/zod/', import.meta.url));
const usesZod = edges.some(scope => scope[zodLink] === -1);
let zodSource;
if (usesZod) {
  let manifest, notice;
  try {
    manifest = JSON.parse(readFileSync(join(zodRoot, 'package.json'), 'utf8'));
    notice = readFileSync(join(zodRoot, 'LICENSE'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(21);
    throw error;
  }
  if (manifest.version !== '4.6.7' || !notice || notice.includes('*/')) {
    throw new Error('Invalid installed Zod runtime');
  }
  zodSource = `/*! @license Zod 4.6.7\n${notice}\n*/\n` +
    `import { coerce, enum as enumType, object, record, string } from 'kt:zod-entry';
const z = Object.freeze({ coerce, enum: enumType, object, record, string });
export default Object.freeze({ ...z, z });`;
}
function isZodFile(path) {
  if (!usesZod || !path || !isAbsolute(path) || !path.endsWith('.js')) return false;
  const name = relative(zodRoot, path);
  return !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep);
}
const bundle = await rolldown({
  input: entry,
  platform: 'neutral',
  transform: { define: { require: 'undefined' } },
  plugins: [{
    name: 'reviewed-card-modules',
    resolveId(specifier, importer) {
      if (!importer && specifier === entry) return entry;
      if (usesZod && importer === zodId && specifier === 'kt:zod-entry') return join(zodRoot, 'index.js');
      if (isZodFile(importer) && /^\.\.?\//.test(specifier)) {
        const dependency = resolve(dirname(importer), specifier);
        if (isZodFile(dependency)) return dependency;
      }
      const index = importer?.startsWith(prefix) && edges[Number(importer.slice(prefix.length))]?.[specifier];
      if (index === -1 && specifier === zodLink) return zodId;
      if (Number.isInteger(index) && index >= 0) return prefix + index;
      throw new Error('Unapproved module');
    },
    load(id) {
      if (usesZod && id === zodId) return zodSource;
      if (isZodFile(id)) return;
      const source = id.startsWith(prefix) && sources[Number(id.slice(prefix.length))];
      if (typeof source === 'string') return source;
      throw new Error('Unknown virtual module');
    },
  }],
});
try {
  const { output } = await bundle.generate({ format: 'esm', minify: true, polyfillRequire: false });
  if (output.length !== 1 || output[0].type !== 'chunk' || output[0].imports.length || output[0].dynamicImports.length) {
    throw new Error('Module output has unresolved dependencies');
  }
  process.stdout.write(output[0].code);
} finally {
  await bundle.close();
}
