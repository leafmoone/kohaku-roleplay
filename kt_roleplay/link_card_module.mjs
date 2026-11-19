// Bundle only the virtual files and edges supplied by the approved card snapshot.
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
const bundle = await rolldown({
  input: entry,
  platform: 'neutral',
  transform: { define: { require: 'undefined' } },
  plugins: [{
    name: 'reviewed-card-modules',
    resolveId(specifier, importer) {
      if (!importer && specifier === entry) return entry;
      const index = edges[Number(importer?.slice(prefix.length))]?.[specifier];
      if (Number.isInteger(index)) return prefix + index;
      throw new Error('Unapproved module');
    },
    load(id) {
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
