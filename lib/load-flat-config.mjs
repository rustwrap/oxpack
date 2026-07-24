import { pathToFileURL } from "node:url";

const configPath = process.argv[2];
const warnings = [];

function cloneData(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => cloneData(item, seen)).filter((item) => item !== undefined);
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const cloned = cloneData(item, seen);
    if (cloned !== undefined) out[key] = cloned;
  }
  seen.delete(value);
  return out;
}

function serializePlugin(plugin) {
  if (!plugin || typeof plugin !== "object") return {};
  return { meta: cloneData(plugin.meta || {}) };
}

function serializeBlock(block) {
  const plugins = {};
  for (const [name, plugin] of Object.entries(block.plugins || {})) plugins[name] = serializePlugin(plugin);
  return {
    name: block.name,
    basePath: block.basePath,
    files: cloneData(block.files),
    ignores: cloneData(block.ignores),
    rules: cloneData(block.rules || {}),
    plugins,
    settings: cloneData(block.settings || {}),
    languageOptions: {
      globals: cloneData(block.languageOptions && block.languageOptions.globals),
      parserOptions: cloneData(block.languageOptions && block.languageOptions.parserOptions),
      hasCustomParser: !!(block.languageOptions && block.languageOptions.parser),
    },
    linterOptions: cloneData(block.linterOptions || {}),
    processor: typeof block.processor === "string" ? block.processor : block.processor ? "<object>" : undefined,
  };
}

function flatten(value, blocks) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, blocks);
    return;
  }
  if (typeof value === "function") {
    warnings.push("Flat config functions cannot be evaluated without arguments and were skipped.");
    return;
  }
  if (typeof value !== "object") return;
  for (const extended of [].concat(value.extends || [])) {
    if (typeof extended === "string") warnings.push(`Flat config string extends '${extended}' could not be materialized.`);
    else flatten(extended, blocks);
  }
  blocks.push(serializeBlock(value));
}

try {
  const url = `${pathToFileURL(configPath).href}?rustwrap=${Date.now()}`;
  const moduleValue = await import(url);
  const exported = await (moduleValue.default === undefined ? moduleValue : moduleValue.default);
  const blocks = [];
  flatten(exported, blocks);
  process.stdout.write(JSON.stringify({ blocks, warnings }));
} catch (error) {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
}
