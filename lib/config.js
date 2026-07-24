"use strict";
/*
 * @rustwrap/eslint config layer — discovers an ESLint configuration (eslintrc legacy or flat), and translates
 * it into the `.oxlintrc.json` shape oxlint consumes (oxlint already targets ESLint-v8 config
 * compatibility, so most of `rules`/`env`/`globals`/`settings`/`overrides` pass straight through;
 * `plugins`/`extends`/`parser` need mapping).
 */
const fs = require("fs");
const path = require("path");

const RC_NAMES = [
  ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml",
  ".eslintrc.json", ".eslintrc",
];
const FLAT_NAMES = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"];

// ESLint plugin name -> oxlint plugin id (+ the rule-prefix oxlint expects for that plugin).
const PLUGIN_MAP = {
  "@typescript-eslint": "typescript",
  "typescript": "typescript",
  "react": "react",
  "react-hooks": "react",
  "react-perf": "react-perf",
  "import": "import",
  "unicorn": "unicorn",
  "jsx-a11y": "jsx-a11y",
  "jest": "jest",
  "vitest": "vitest",
  "promise": "promise",
  "n": "node",
  "node": "node",
  "next": "nextjs",
  "@next/next": "nextjs",
  "jsdoc": "jsdoc",
  "vue": "vue",
};

// `extends` entry -> oxlint plugin(s) to enable (npm shareable configs can't be resolved, but their
// rule sets exist natively in oxlint behind these plugins).
function pluginsFromExtends(ext) {
  const out = new Set();
  for (const e of [].concat(ext || [])) {
    const s = String(e);
    if (/@typescript-eslint/.test(s)) out.add("typescript");
    if (/plugin:react\//.test(s) || /airbnb|react-app/.test(s)) out.add("react");
    if (/react-hooks/.test(s)) out.add("react");
    if (/plugin:import\//.test(s) || /airbnb/.test(s)) out.add("import");
    if (/unicorn/.test(s)) out.add("unicorn");
    if (/jsx-a11y/.test(s) || /airbnb/.test(s)) out.add("jsx-a11y");
    if (/plugin:jest\//.test(s)) out.add("jest");
    if (/plugin:vitest\//.test(s)) out.add("vitest");
    if (/plugin:promise\//.test(s)) out.add("promise");
    if (/plugin:n\/|plugin:node\//.test(s)) out.add("node");
    if (/plugin:jsdoc\//.test(s)) out.add("jsdoc");
    if (/plugin:vue\//.test(s)) out.add("vue");
  }
  return out;
}

function readRcFile(file) {
  const ext = path.extname(file);
  const raw = fs.readFileSync(file, "utf8");
  if (ext === ".js" || ext === ".cjs") { delete require.cache[require.resolve(file)]; return require(file); }
  if (ext === ".yaml" || ext === ".yml") return require("js-yaml").load(raw);
  // .json / .eslintrc / unknown -> JSON5-ish (strip comments + trailing commas)
  return JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([}\]])/g, "$1"));
}

// Walk up from `dir` to find the nearest legacy rc or flat config (or package.json#eslintConfig).
function discoverConfig(dir) {
  let d = dir;
  for (let i = 0; i < 12 && d; i++) {
    for (const n of FLAT_NAMES) { const p = path.join(d, n); if (fs.existsSync(p)) return { type: "flat", file: p }; }
    for (const n of RC_NAMES) { const p = path.join(d, n); if (fs.existsSync(p)) return { type: "eslintrc", file: p }; }
    const pkg = path.join(d, "package.json");
    if (fs.existsSync(pkg)) {
      try { const j = JSON.parse(fs.readFileSync(pkg, "utf8")); if (j.eslintConfig) return { type: "eslintrc", file: pkg, inline: j.eslintConfig }; } catch (_) {}
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// Resolve a legacy eslintrc, following local-file `extends` (npm extends are inferred, not loaded).
function loadEslintrc(file, inline, seen) {
  seen = seen || new Set();
  if (file && seen.has(file)) return {};
  if (file) seen.add(file);
  const cfg = inline || readRcFile(file);
  const baseDir = file ? path.dirname(file) : process.cwd();
  let merged = { rules: {}, env: {}, globals: {}, settings: {}, plugins: [], _pluginIds: new Set(), overrides: [], ignorePatterns: [] };
  for (const ext of [].concat(cfg.extends || [])) {
    if (typeof ext === "string" && (ext.startsWith(".") || ext.startsWith("/") || path.isAbsolute(ext))) {
      const p = path.resolve(baseDir, ext);
      if (fs.existsSync(p)) { const sub = loadEslintrc(p, null, seen); mergeInto(merged, sub); }
    }
    for (const pid of pluginsFromExtends(ext)) merged._pluginIds.add(pid);
  }
  for (const p of cfg.plugins || []) { const id = PLUGIN_MAP[p] || PLUGIN_MAP[p.replace(/^eslint-plugin-/, "")]; if (id) merged._pluginIds.add(id); }
  mergeInto(merged, {
    rules: cfg.rules || {}, env: cfg.env || {}, globals: cfg.globals || {}, settings: cfg.settings || {},
    overrides: cfg.overrides || [], ignorePatterns: [].concat(cfg.ignorePatterns || []),
  });
  const po = cfg.parserOptions || {};
  if (po.project) merged._project = resolveProjectRef(po.project, baseDir);
  return merged;
}

function mergeInto(target, src) {
  Object.assign(target.rules, src.rules || {});
  Object.assign(target.env, src.env || {});
  Object.assign(target.globals, src.globals || {});
  Object.assign(target.settings, src.settings || {});
  if (src.overrides) target.overrides.push(...src.overrides);
  if (src.ignorePatterns) target.ignorePatterns.push(...src.ignorePatterns);
  if (src._pluginIds) for (const p of src._pluginIds) target._pluginIds.add(p);
  if (src._project && !target._project) target._project = src._project;
}

// Resolve an ESLint `parserOptions.project` value (string | string[] | true) to a single tsconfig
// path relative to the config file's directory. `true` means "nearest tsconfig" — left for discovery.
function resolveProjectRef(project, baseDir) {
  if (project === true) return true;
  const first = Array.isArray(project) ? project[0] : project;
  if (typeof first !== "string") return true;
  return path.resolve(baseDir, first);
}

// Walk up from `dir` to find the nearest tsconfig.json (like tsc/webpack resolution).
function findTsconfig(dir) {
  for (let i = 0; i < 12 && dir; i++) {
    const f = path.join(dir, "tsconfig.json");
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

// Decide which tsconfig (if any) to *override* oxlint with. oxlint already auto-discovers the
// nearest tsconfig.json per file, so we only pass --tsconfig when the user is explicit: an explicit
// option/CLI flag, or `parserOptions.project` (which can point at a non-standard name/path oxlint
// wouldn't find on its own). When project===true or unset, return undefined and let oxlint discover.
function resolveTsconfig(opts, project, configDir, cwd) {
  if (opts && opts.tsconfig) { const p = path.resolve(cwd, opts.tsconfig); return fs.existsSync(p) ? p : undefined; }
  if (project && project !== true) return fs.existsSync(project) ? project : undefined;
  return undefined;
}

// Load the set of rule names oxlint actually implements from its bundled JSON schema, so we can
// drop unknown ESLint rules (oxlint hard-errors on unrecognized rule names in config).
let _knownRules = null;
function knownRules() {
  if (_knownRules) return _knownRules;
  _knownRules = new Set();
  try {
    // oxlint's `exports` blocks subpath resolution, so locate the schema via the package dir.
    const pkgPath = require.resolve("oxlint/package.json");
    const schemaPath = path.join(path.dirname(pkgPath), "configuration_schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const ref = schema.definitions && schema.definitions.OxlintRules && schema.definitions.OxlintRules.$ref;
    const defName = ref && ref.split("/").pop();
    const def = defName && schema.definitions[defName];
    if (def && def.properties) for (const name of Object.keys(def.properties)) _knownRules.add(name);
  } catch (_) { /* if unavailable, knownRules stays empty -> we keep all (best effort) */ }
  return _knownRules;
}

// oxlint accepts ESLint-style rule names for the plugins it supports (e.g. `@typescript-eslint/x`,
// `react/x`) as well as bare core rules. We therefore keep rule names AS WRITTEN, except for a few
// ESLint plugins that have no oxlint plugin but whose rule maps to an oxlint built-in. Genuinely
// unknown rules/plugins are removed at runtime by the runner's self-correcting retry loop.
const PREFIX_ALIASES = {
  // eslint-plugin-unused-imports rules are covered by oxlint's core no-unused-vars.
  "unused-imports/no-unused-vars": "no-unused-vars",
  "unused-imports/no-unused-imports": "no-unused-vars",
  "unused-imports/no-unused-imports-ts": "no-unused-vars",
  "unused-imports/no-unused-vars-ts": "no-unused-vars",
};

function toOxlintRuleName(eslintRule) {
  if (PREFIX_ALIASES[eslintRule]) return PREFIX_ALIASES[eslintRule];
  return eslintRule; // keep as written (prefixed plugin rules are understood by oxlint)
}

// Deprecated/renamed ESLint rules -> oxlint's current rule name, so a user's severity/options on the
// old name still apply. Only used when the target rule isn't already configured explicitly.
const RULE_ALIASES = {
  "no-empty-interface": "no-empty-object-type",
  "ban-ts-comment": "ban-ts-comment",
};

// Per-rule option translators for renamed rules whose option shape changed.
const OPTION_TRANSLATORS = {
  // @typescript-eslint/no-empty-interface { allowSingleExtends } -> no-empty-object-type. Restrict to
  // interfaces only (allowObjectTypes:"always") so empty `type X = {}` — which no-empty-interface
  // never flagged — is not newly reported.
  "no-empty-interface->no-empty-object-type": (opts) => {
    return { allowInterfaces: (opts && opts.allowSingleExtends) ? "with-single-extends" : "never", allowObjectTypes: "always" };
  },
};

// Build an oxlint rule value, preserving ESLint options. oxlint reads the eslint `[severity, opts]`
// array form for the rules that support options; unsupported options are handled by a retry that
// downgrades to bare severity (see runner).
function ruleEntry(severity, options) {
  if (options === undefined) return severity;
  return [severity, options];
}

// Normalize ESLint `rules` to oxlint form: keep names as written (oxlint understands prefixed plugin
// rules), preserve options, apply prefix-aliases and renamed-rule aliases. Unknown rules/plugins are
// stripped at runtime by the runner. Severity is preserved.
function normalizeRules(rules) {
  const out = {};
  const sev = (v) => (v === 2 || v === "error") ? "error" : (v === 1 || v === "warn") ? "warn" : "off";
  const bare = (k) => k.replace(/^@[^/]+\//, "").replace(/^[^/]+\//, "");
  const explicit = new Set();

  // 1) rules as written (with prefix-aliasing + options).
  for (const [name, val] of Object.entries(rules || {})) {
    const oxName = toOxlintRuleName(name);
    const severity = Array.isArray(val) ? sev(val[0]) : sev(val);
    const options = Array.isArray(val) && val.length > 1 ? val[1] : undefined;
    const incoming = ruleEntry(severity, options);

    if (out[oxName] === undefined) {
      out[oxName] = incoming;
      explicit.add(oxName);
      continue;
    }
    // A rule written under its own canonical oxlint name always wins over aliased entries.
    if (oxName === name) {
      out[oxName] = incoming;
      explicit.add(oxName);
      continue;
    }
    // Collision from aliasing (e.g. several unused-imports/* rules all map to no-unused-vars):
    // prefer the entry that carries options — that's the more specific rule (e.g. the vars rule
    // with varsIgnorePattern), so a sibling like no-unused-imports:"error" can't clobber the
    // user's intended ["warn", { varsIgnorePattern }] and turn warnings into build-breaking errors.
    const existingHasOpts = Array.isArray(out[oxName]) && out[oxName].length > 1;
    if (options !== undefined && !existingHasOpts) out[oxName] = incoming;
  }

  // 2) renamed/deprecated rules -> aliased oxlint rule (only if target not already set explicitly).
  for (const [name, val] of Object.entries(rules || {})) {
    const b = bare(name);
    const alias = RULE_ALIASES[b];
    if (!alias || alias === b || explicit.has(alias) || out[alias] !== undefined) continue;
    const severity = Array.isArray(val) ? sev(val[0]) : sev(val);
    let options = Array.isArray(val) && val.length > 1 ? val[1] : undefined;
    const xl = OPTION_TRANSLATORS[`${b}->${alias}`];
    if (xl) options = xl(options);
    out[alias] = ruleEntry(severity, options);
  }
  return out;
}

// Translate a discovered ESLint config into an `.oxlintrc.json` object oxlint can consume.
function toOxlintConfig(cfg) {
  const plugins = new Set(["typescript", "unicorn", "oxc"]); // oxlint defaults
  for (const p of cfg._pluginIds || []) plugins.add(p);
  const ox = {
    plugins: [...plugins],
    categories: { correctness: "warn" },
    rules: normalizeRules(cfg.rules),
    env: cfg.env && Object.keys(cfg.env).length ? cfg.env : { builtin: true },
  };
  if (cfg.globals && Object.keys(cfg.globals).length) ox.globals = sanitizeGlobals(cfg.globals);
  const settings = sanitizeSettings(cfg.settings);
  if (settings && Object.keys(settings).length) ox.settings = settings;
  if (cfg.ignorePatterns && cfg.ignorePatterns.length) ox.ignorePatterns = cfg.ignorePatterns;
  if (cfg.overrides && cfg.overrides.length) {
    ox.overrides = cfg.overrides.map((o) => ({ files: [].concat(o.files || []), rules: normalizeRules(o.rules), ...(o.env ? { env: o.env } : {}) }));
  }
  return ox;
}

// oxlint validates settings strictly. Map ESLint's `react.version: "detect"` to a concrete version
// and drop any settings keys oxlint doesn't understand so the config always parses.
function sanitizeSettings(settings) {
  if (!settings || typeof settings !== "object") return undefined;
  const out = {};
  if (settings.react && typeof settings.react === "object") {
    const r = Object.assign({}, settings.react);
    if (!r.version || r.version === "detect" || !/^\d+\.\d+/.test(String(r.version))) r.version = "18.0";
    out.react = { version: r.version };
  }
  if (settings.jsx_a11y || settings["jsx-a11y"]) out["jsx-a11y"] = settings["jsx-a11y"] || settings.jsx_a11y;
  // `import` resolver settings etc. are not consumed by oxlint — omit them.
  return out;
}

// oxlint accepts ESLint global values true/false/"readonly"/"writable"; coerce anything else.
function sanitizeGlobals(globals) {
  const out = {};
  for (const [k, v] of Object.entries(globals)) {
    if (v === true || v === "writable" || v === "writeable") out[k] = "writable";
    else if (v === false || v === "readonly" || v === "readable") out[k] = "readonly";
    else if (v === "off") out[k] = "off";
    else out[k] = "readonly";
  }
  return out;
}

// Returns { oxConfig, pluginFlags, source } or null when no config found / --no-eslintrc.
function buildOxlintConfig(opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const defaults = { plugins: ["typescript", "unicorn", "oxc"], categories: { correctness: "warn" } };
  if (opts.noEslintrc) return { oxConfig: defaults, source: null, tsconfig: resolveTsconfig(opts, null, cwd, cwd) };
  let found;
  if (opts.configFile) found = { type: opts.configFile.endsWith(".js") || opts.configFile.endsWith(".mjs") || opts.configFile.endsWith(".cjs") ? "flat" : "eslintrc", file: path.resolve(opts.configFile) };
  else found = discoverConfig(cwd);
  if (!found) return { oxConfig: defaults, source: null, tsconfig: resolveTsconfig(opts, null, cwd, cwd) };
  const configDir = found.file ? path.dirname(found.file) : cwd;
  if (found.type === "flat") {
    // Flat config: we can read `rules`/`plugins` heuristically but cannot fully evaluate it; enable
    // common plugins and let oxlint use its own discovery. Pass-through with defaults.
    const flat = loadFlat(found.file);
    return { oxConfig: toOxlintConfig(flat), source: found.file, tsconfig: resolveTsconfig(opts, flat._project, configDir, cwd) };
  }
  const merged = loadEslintrc(found.file, found.inline, new Set());
  return { oxConfig: toOxlintConfig(merged), source: found.file, tsconfig: resolveTsconfig(opts, merged._project, configDir, cwd) };
}

// Best-effort flat-config reader: merges `rules`/`plugins` across array entries.
function loadFlat(file) {
  let arr;
  try { delete require.cache[require.resolve(file)]; arr = require(file); arr = arr && arr.default ? arr.default : arr; } catch (_) { arr = []; }
  arr = [].concat(arr || []);
  const merged = { rules: {}, env: {}, globals: {}, settings: {}, overrides: [], ignorePatterns: [], _pluginIds: new Set() };
  for (const block of arr) {
    if (!block || typeof block !== "object") continue;
    Object.assign(merged.rules, block.rules || {});
    if (block.languageOptions && block.languageOptions.globals) Object.assign(merged.globals, block.languageOptions.globals);
    for (const name of Object.keys(block.plugins || {})) { const id = PLUGIN_MAP[name] || PLUGIN_MAP[name.replace(/^eslint-plugin-/, "")]; if (id) merged._pluginIds.add(id); }
    if (block.ignores) merged.ignorePatterns.push(...block.ignores);
    const po = block.languageOptions && block.languageOptions.parserOptions;
    if (po && po.project && !merged._project) merged._project = resolveProjectRef(po.project, path.dirname(file));
  }
  return merged;
}

module.exports = require("./compat-config");
