"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const micromatch = require("micromatch");

const CORE_PLUGIN_ALIAS = "eslint-js";
const CORE_PLUGIN_PATH = path.join(__dirname, "eslint-core-plugin.js");
const FLAT_CONFIG_LOADER = path.join(__dirname, "load-flat-config.mjs");
const FLAT_CONFIG_NAMES = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"];

const NATIVE_PLUGIN_MAP = {
  "@typescript-eslint": "typescript",
  typescript: "typescript",
  react: "react",
  "react-hooks": "react",
  "react-perf": "react-perf",
  import: "import",
  "import-x": "import",
  unicorn: "unicorn",
  "jsx-a11y": "jsx-a11y",
  "jsx-a11y-x": "jsx-a11y",
  jest: "jest",
  vitest: "vitest",
  promise: "promise",
  n: "node",
  node: "node",
  next: "nextjs",
  "@next/next": "nextjs",
  jsdoc: "jsdoc",
  vue: "vue",
};

const NATIVE_RULE_ALIASES = {
  "no-new-symbol": "no-new-native-nonconstructor",
};

const PREFER_ESLINT_CORE_RULES = new Set([
  "no-unsafe-optional-chaining",
]);

const TYPESCRIPT_CORE_ALIASES = new Set([
  "default-param-last",
  "init-declarations",
  "no-array-constructor",
  "no-dupe-class-members",
  "no-duplicate-imports",
  "no-empty-function",
  "no-loop-func",
  "no-loss-of-precision",
  "no-magic-numbers",
  "no-redeclare",
  "no-restricted-imports",
  "no-shadow",
  "no-throw-literal",
  "no-unused-expressions",
  "no-unused-vars",
  "no-use-before-define",
  "no-useless-constructor",
]);

let legacyRuntime;
let oxlintSchema;
let oxlintRules;

function severity(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 2 || raw === "error" || raw === "deny") return "error";
  if (raw === 1 || raw === "warn") return "warn";
  return "off";
}

function severityRank(value) {
  return severity(value) === "error" ? 2 : severity(value) === "warn" ? 1 : 0;
}

function normalizeRuleValue(value) {
  const normalizedSeverity = severity(value);
  if (!Array.isArray(value) || value.length === 1) return normalizedSeverity;
  return [normalizedSeverity, ...value.slice(1)];
}

function hasRuleOptions(value) {
  return Array.isArray(value) && value.length > 1;
}

function splitRuleId(ruleId) {
  const parts = String(ruleId).split("/");
  if (parts.length === 1) return { plugin: null, rule: ruleId };
  if (ruleId.startsWith("@")) {
    if (parts.length === 2) return { plugin: parts[0], rule: parts[1] };
    return { plugin: `${parts[0]}/${parts[1]}`, rule: parts.slice(2).join("/") };
  }
  return { plugin: parts[0], rule: parts.slice(1).join("/") };
}

function getOxlintSchema() {
  if (!oxlintSchema) {
    const packagePath = require.resolve("oxlint/package.json");
    oxlintSchema = JSON.parse(fs.readFileSync(path.join(path.dirname(packagePath), "configuration_schema.json"), "utf8"));
  }
  return oxlintSchema;
}

function knownOxlintRules() {
  if (!oxlintRules) {
    const schema = getOxlintSchema();
    oxlintRules = new Set(Object.keys((schema.definitions.DummyRuleMap && schema.definitions.DummyRuleMap.properties) || {}));
  }
  return oxlintRules;
}

function resolveSchemaNode(node, seen = new Set()) {
  if (!node || !node.$ref) return node;
  if (seen.has(node.$ref)) return node;
  seen.add(node.$ref);
  const name = node.$ref.split("/").pop();
  return resolveSchemaNode(getOxlintSchema().definitions[name], seen);
}

function schemaAllowsOptions(node, seen = new Set()) {
  node = resolveSchemaNode(node, seen);
  if (!node) return false;
  if (node.type === "array") {
    if (node.maxItems > 1 || node.minItems > 1) return true;
    if (Array.isArray(node.items) && node.items.length > 1) return true;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(node[key]) && node[key].some((item) => schemaAllowsOptions(item, seen))) return true;
  }
  return false;
}

function oxlintRuleAllowsOptions(ruleName) {
  const definition = getOxlintSchema().definitions.DummyRuleMap.properties[ruleName];
  return schemaAllowsOptions(definition);
}

function getLegacyRuntime(cwd) {
  if (legacyRuntime) return legacyRuntime;
  const riskPath = require.resolve("eslint-compat/use-at-your-own-risk");
  const eslintRoot = path.dirname(path.dirname(riskPath));
  const eslintrcPath = require.resolve("@eslint/eslintrc", { paths: [eslintRoot, path.join(__dirname, ".."), cwd] });
  const { Legacy } = require(eslintrcPath);
  const { builtinRules } = require(riskPath);
  const recommended = { rules: {} };
  const all = { rules: {} };
  for (const [name, rule] of builtinRules) {
    all.rules[name] = "error";
    if (rule.meta && rule.meta.docs && rule.meta.docs.recommended) recommended.rules[name] = "error";
  }
  legacyRuntime = { Legacy, builtinRules, recommended, all };
  return legacyRuntime;
}

function discoverFlatConfig(cwd) {
  let directory = cwd;
  for (let depth = 0; depth < 20; depth++) {
    for (const name of FLAT_CONFIG_NAMES) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) return file;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function findTsconfig(directory) {
  let current = directory;
  for (let depth = 0; depth < 20; depth++) {
    const file = path.join(current, "tsconfig.json");
    if (fs.existsSync(file)) return file;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function looksLikeFlatConfig(file) {
  if (!file || !fs.existsSync(file)) return false;
  if (/eslint\.config\.(?:js|mjs|cjs|ts)$/i.test(path.basename(file))) return true;
  try {
    if (path.extname(file) === ".json" || path.basename(file) === ".eslintrc") return false;
    const loaded = require(file);
    const value = loaded && loaded.default !== undefined ? loaded.default : loaded;
    return Array.isArray(value);
  } catch (_) {
    return false;
  }
}

function resolveProject(parserOptions, cwd) {
  const project = parserOptions && parserOptions.project;
  if (!project || project === true) return undefined;
  const first = Array.isArray(project) ? project[0] : project;
  if (typeof first !== "string") return undefined;
  const root = parserOptions.tsconfigRootDir || cwd;
  const resolved = path.resolve(root, first);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function extractLegacyConfig(config, cwd) {
  const plugins = {};
  const warnings = [];
  for (const [name, dependency] of Object.entries(config.plugins || {})) {
    if (dependency.error) {
      warnings.push(`ESLint plugin '${name}' could not be loaded: ${dependency.error.message}`);
    } else if (dependency.filePath) {
      plugins[name] = dependency.filePath;
    }
  }
  if (config.processor) warnings.push(`Processor '${config.processor}' is not supported by Oxlint.`);
  if (config.parser && config.parser.filePath && !/@typescript-eslint[\\/]parser|espree/.test(config.parser.filePath)) {
    warnings.push(`Custom parser '${config.parser.filePath}' is not supported; Oxlint's parser will be used.`);
  }
  if (config.noInlineConfig) warnings.push("noInlineConfig is not supported by Oxlint.");
  return {
    env: config.env || {},
    globals: config.globals || {},
    parserOptions: config.parserOptions || {},
    plugins,
    processor: config.processor,
    reportUnusedDisableDirectives: config.reportUnusedDisableDirectives,
    rules: config.rules || {},
    settings: config.settings || {},
    tsconfig: resolveProject(config.parserOptions, cwd),
    warnings,
  };
}

function createLegacyResolver(options) {
  const cwd = options.cwd;
  const { Legacy, builtinRules, recommended, all } = getLegacyRuntime(cwd);
  const configFile = options.configFile ? path.resolve(cwd, options.configFile) : null;
  const factory = new Legacy.CascadingConfigArrayFactory({
    baseConfig: options.baseConfig || null,
    cliConfig: options.overrideConfig || null,
    cwd,
    ignorePath: options.ignorePath,
    resolvePluginsRelativeTo: options.resolvePluginsRelativeTo || cwd,
    specificConfigPath: configFile,
    useEslintrc: options.noEslintrc !== true,
    builtInRules: builtinRules,
    getEslintRecommendedConfig: () => recommended,
    getEslintAllConfig: () => all,
  });
  return {
    type: "legacy",
    source: configFile,
    configDir: configFile ? path.dirname(configFile) : cwd,
    resolve(filePath) {
      const configArray = factory.getConfigArrayForFile(filePath, { ignoreNotFoundError: true });
      const extracted = configArray.extractConfig(filePath);
      const ignored = options.noIgnore ? false : !!(extracted.ignores && extracted.ignores(filePath));
      return { ignored, config: extractLegacyConfig(extracted, cwd) };
    },
  };
}

function loadFlatConfig(file) {
  const result = spawnSync(process.execPath, [FLAT_CONFIG_LOADER, file], {
    cwd: path.dirname(file),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Failed to load ${file}`).trim());
  return JSON.parse(result.stdout || '{"blocks":[],"warnings":[]}');
}

function normalizeIgnorePattern(pattern) {
  const normalized = String(pattern).replace(/\\/g, "/");
  return normalized.endsWith("/") ? `${normalized}**` : normalized;
}

function matchesPatterns(relativePath, patterns) {
  const values = [].concat(patterns || []);
  if (!values.length) return false;
  return values.some((entry) => {
    if (Array.isArray(entry)) {
      return entry.every((pattern) => micromatch.isMatch(relativePath, normalizeIgnorePattern(pattern), { dot: true }));
    }
    return micromatch.isMatch(relativePath, normalizeIgnorePattern(entry), { dot: true });
  });
}

function pluginPackageName(pluginId) {
  if (pluginId === "@typescript-eslint") return "@typescript-eslint/eslint-plugin";
  if (pluginId.startsWith("@")) {
    const parts = pluginId.split("/");
    return parts.length === 1 ? `${pluginId}/eslint-plugin` : `${parts[0]}/eslint-plugin-${parts.slice(1).join("-")}`;
  }
  if (pluginId.startsWith("eslint-plugin-")) return pluginId;
  return `eslint-plugin-${pluginId}`;
}

function resolveFlatPlugin(pluginId, metadata, searchPaths) {
  const candidates = [];
  const metaName = metadata && metadata.meta && metadata.meta.name;
  if (metaName) candidates.push(metaName);
  candidates.push(pluginPackageName(pluginId), pluginId);
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate, { paths: searchPaths });
    } catch (_) {}
  }
  return undefined;
}

function mergeFlatBlock(target, block, configDir, cwd) {
  Object.assign(target.rules, block.rules || {});
  Object.assign(target.settings, block.settings || {});
  Object.assign(target.globals, (block.languageOptions && block.languageOptions.globals) || {});
  Object.assign(target.parserOptions, (block.languageOptions && block.languageOptions.parserOptions) || {});
  const pluginEntries = Array.isArray(block.plugins)
    ? block.plugins.map((name) => [name, {}])
    : Object.entries(block.plugins || {});
  for (const [name, metadata] of pluginEntries) {
    const filePath = resolveFlatPlugin(name, metadata, [configDir, cwd]);
    if (filePath) target.plugins[name] = filePath;
    else target.warnings.push(`Flat-config plugin '${name}' could not be resolved to an installed package.`);
  }
  if (block.languageOptions && block.languageOptions.hasCustomParser) {
    target.warnings.push("A flat-config custom parser was ignored because Oxlint uses its own parser.");
  }
  if (block.processor) target.warnings.push(`Flat-config processor '${block.processor}' is not supported by Oxlint.`);
  if (block.linterOptions) {
    if (block.linterOptions.noInlineConfig) target.warnings.push("noInlineConfig is not supported by Oxlint.");
    if (block.linterOptions.reportUnusedDisableDirectives !== undefined) {
      target.reportUnusedDisableDirectives = block.linterOptions.reportUnusedDisableDirectives;
    }
  }
}

function createFlatResolver(options, configFile) {
  const cwd = options.cwd;
  const configDir = path.dirname(configFile);
  const loaded = loadFlatConfig(configFile);
  const externalIgnorePatterns = [];
  if (options.ignorePath && fs.existsSync(options.ignorePath)) {
    externalIgnorePatterns.push(
      ...fs.readFileSync(options.ignorePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    );
  }
  externalIgnorePatterns.push(...[].concat((options.overrideConfig && options.overrideConfig.ignorePatterns) || []));
  return {
    type: "flat",
    source: configFile,
    configDir,
    resolve(filePath) {
      const relativePath = path.relative(configDir, filePath).replace(/\\/g, "/");
      const target = {
        env: {},
        globals: {},
        parserOptions: {},
        plugins: {},
        reportUnusedDisableDirectives: undefined,
        rules: {},
        settings: {},
        warnings: [...loaded.warnings],
      };
      if (!options.noIgnore) {
        if (matchesPatterns(relativePath, ["**/node_modules/**", ".git/**", ...externalIgnorePatterns])) {
          return { ignored: true, config: target };
        }
      }
      for (const block of loaded.blocks) {
        const blockDir = block.basePath ? path.resolve(configDir, block.basePath) : configDir;
        const blockRelativePath = path.relative(blockDir, filePath).replace(/\\/g, "/");
        const ignoreOnly = block.ignores && !block.files && !Object.keys(block.rules || {}).length &&
          !Object.keys(block.plugins || {}).length && !Object.keys(block.settings || {}).length;
        if (!options.noIgnore && ignoreOnly && matchesPatterns(blockRelativePath, block.ignores)) {
          return { ignored: true, config: target };
        }
        if (block.files && !matchesPatterns(blockRelativePath, block.files)) continue;
        if (!options.noIgnore && block.ignores && matchesPatterns(blockRelativePath, block.ignores)) continue;
        mergeFlatBlock(target, block, configDir, cwd);
      }
      if (options.overrideConfig) {
        mergeFlatBlock(target, {
          rules: options.overrideConfig.rules,
          settings: options.overrideConfig.settings,
          plugins: options.overrideConfig.plugins,
          languageOptions: {
            globals: options.overrideConfig.globals,
            parserOptions: options.overrideConfig.parserOptions,
          },
          linterOptions: {
            noInlineConfig: options.overrideConfig.noInlineConfig,
            reportUnusedDisableDirectives: options.overrideConfig.reportUnusedDisableDirectives,
          },
          processor: options.overrideConfig.processor,
        }, configDir, cwd);
      }
      target.tsconfig = resolveProject(target.parserOptions, cwd);
      return { ignored: false, config: target };
    },
  };
}

function createConfigResolver(options) {
  options = Object.assign({ cwd: process.cwd() }, options || {});
  const explicit = options.configFile ? path.resolve(options.cwd, options.configFile) : null;
  const flatFile = explicit ? (looksLikeFlatConfig(explicit) ? explicit : null) : discoverFlatConfig(options.cwd);
  if (!options.noEslintrc && flatFile) return createFlatResolver(options, flatFile);
  return createLegacyResolver(options);
}

function safePluginAlias(pluginId) {
  return `js-${pluginId.replace(/^@/, "").replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function registerJsPlugin(context, pluginId, specifier) {
  const preferred = pluginId === "eslint" ? CORE_PLUGIN_ALIAS : safePluginAlias(pluginId);
  let alias = preferred;
  let suffix = 2;
  while (context.jsPlugins[alias] && context.jsPlugins[alias] !== specifier) alias = `${preferred}-${suffix++}`;
  context.jsPlugins[alias] = specifier;
  return alias;
}

function registerRule(context, oxlintName, originalName, value) {
  const existing = context.rules[oxlintName];
  if (existing === undefined || severityRank(value) >= severityRank(existing)) {
    context.rules[oxlintName] = normalizeRuleValue(value);
    context.ruleIdMap[oxlintName] = originalName;
  }
}

function nativeRuleName(originalName) {
  const { plugin, rule } = splitRuleId(originalName);
  if (!plugin) {
    if (PREFER_ESLINT_CORE_RULES.has(rule)) return null;
    const alias = NATIVE_RULE_ALIASES[rule];
    if (alias && knownOxlintRules().has(alias)) return alias;
    return knownOxlintRules().has(rule) ? rule : null;
  }
  if (plugin === "@typescript-eslint" && TYPESCRIPT_CORE_ALIASES.has(rule) && knownOxlintRules().has(rule)) {
    return rule;
  }
  const nativePlugin = NATIVE_PLUGIN_MAP[plugin];
  if (!nativePlugin) return null;
  const name = `${nativePlugin}/${rule}`;
  return knownOxlintRules().has(name) ? name : null;
}

function translateRules(rules, pluginSpecifiers, warnings) {
  const context = {
    jsPlugins: {},
    nativePlugins: new Set(),
    ruleIdMap: {},
    rules: {},
  };
  for (const [originalName, configuredValue] of Object.entries(rules || {})) {
    if (severity(configuredValue) === "off") continue;
    const { plugin } = splitRuleId(originalName);
    const nativeName = nativeRuleName(originalName);
    const canUseNative = nativeName && (!hasRuleOptions(configuredValue) || oxlintRuleAllowsOptions(nativeName));
    if (canUseNative) {
      if (nativeName.includes("/")) context.nativePlugins.add(nativeName.split("/")[0]);
      registerRule(context, nativeName, originalName, configuredValue);
      continue;
    }

    if (!plugin) {
      const alias = registerJsPlugin(context, "eslint", CORE_PLUGIN_PATH);
      registerRule(context, `${alias}/${originalName}`, originalName, configuredValue);
      continue;
    }

    const pluginPath = pluginSpecifiers[plugin];
    if (pluginPath) {
      const alias = registerJsPlugin(context, plugin, pluginPath);
      const ruleName = splitRuleId(originalName).rule;
      registerRule(context, `${alias}/${ruleName}`, originalName, configuredValue);
      continue;
    }

    if (nativeName) {
      if (nativeName.includes("/")) context.nativePlugins.add(nativeName.split("/")[0]);
      registerRule(context, nativeName, originalName, configuredValue);
      warnings.push(`Rule '${originalName}' options are not natively supported and its JavaScript plugin could not be loaded.`);
    } else {
      warnings.push(`Rule '${originalName}' is enabled but neither Oxlint nor a compatible JavaScript plugin is available.`);
    }
  }
  return context;
}

function resolveReactVersion(cwd) {
  try {
    const packagePath = require.resolve("react/package.json", { paths: [cwd] });
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
  } catch (_) {
    return "18.0";
  }
}

function sanitizeSettings(settings, cwd) {
  const out = Object.assign({}, settings || {});
  if (out.react && typeof out.react === "object") {
    out.react = Object.assign({}, out.react);
    if (!out.react.version || out.react.version === "detect") out.react.version = resolveReactVersion(cwd);
  }
  if (out.jsx_a11y && !out["jsx-a11y"]) {
    out["jsx-a11y"] = out.jsx_a11y;
    delete out.jsx_a11y;
  }
  return out;
}

function translateResolvedConfig(config, options) {
  const warnings = [...(config.warnings || [])];
  const translatedRules = translateRules(config.rules, config.plugins || {}, warnings);
  const oxConfig = {
    categories: { correctness: "off" },
    plugins: [...translatedRules.nativePlugins],
    rules: translatedRules.rules,
    env: Object.keys(config.env || {}).length ? config.env : { builtin: true },
  };
  if (Object.keys(config.globals || {}).length) oxConfig.globals = config.globals;
  const settings = sanitizeSettings(config.settings, options.cwd);
  if (Object.keys(settings).length) oxConfig.settings = settings;
  const jsPlugins = Object.entries(translatedRules.jsPlugins).map(([name, specifier]) => ({ name, specifier }));
  if (jsPlugins.length) oxConfig.jsPlugins = jsPlugins;
  return {
    oxConfig,
    reportUnusedDisableDirectives: config.reportUnusedDisableDirectives,
    ruleIdMap: translatedRules.ruleIdMap,
    tsconfig: config.tsconfig,
    warnings,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function resolveConfigGroups(files, options) {
  options = Object.assign({ cwd: process.cwd() }, options || {});
  const resolver = createConfigResolver(options);
  const groups = new Map();
  const warnings = new Set();
  const ignoredFiles = new Set();
  for (const file of files) {
    const absolute = path.resolve(file);
    const resolved = resolver.resolve(absolute);
    if (resolved.ignored) {
      ignoredFiles.add(absolute);
      continue;
    }
    if (options.tsconfig) {
      const explicitTsconfig = path.resolve(options.cwd, options.tsconfig);
      if (fs.existsSync(explicitTsconfig)) resolved.config.tsconfig = explicitTsconfig;
    }
    const translated = translateResolvedConfig(resolved.config, options);
    for (const warning of translated.warnings) warnings.add(warning);
    const key = stableStringify({
      oxConfig: translated.oxConfig,
      reportUnusedDisableDirectives: translated.reportUnusedDisableDirectives,
      ruleIdMap: translated.ruleIdMap,
      tsconfig: translated.tsconfig,
    });
    if (!groups.has(key)) {
      groups.set(key, {
        configDir: resolver.configDir,
        files: [],
        oxConfig: translated.oxConfig,
        reportUnusedDisableDirectives: translated.reportUnusedDisableDirectives,
        ruleIdMap: translated.ruleIdMap,
        tsconfig: translated.tsconfig,
      });
    }
    groups.get(key).files.push(absolute);
  }
  return {
    groups: [...groups.values()],
    ignoredFiles,
    source: resolver.source,
    warnings: [...warnings],
  };
}

function buildOxlintConfig(options) {
  options = Object.assign({ cwd: process.cwd() }, options || {});
  const filePath = options.filePath || path.join(options.cwd, "__rustwrap__.ts");
  const resolved = resolveConfigGroups([filePath], Object.assign({}, options, { noIgnore: true }));
  const group = resolved.groups[0] || translateResolvedConfig({
    env: {},
    globals: {},
    plugins: {},
    rules: {},
    settings: {},
    warnings: [],
  }, options);
  return {
    oxConfig: group.oxConfig,
    reportUnusedDisableDirectives: group.reportUnusedDisableDirectives,
    ruleIdMap: group.ruleIdMap,
    source: resolved.source,
    tsconfig: group.tsconfig,
    warnings: resolved.warnings,
  };
}

function normalizeRules(rules, plugins) {
  return translateResolvedConfig({
    env: {},
    globals: {},
    plugins: plugins || {},
    rules: rules || {},
    settings: {},
    warnings: [],
  }, { cwd: process.cwd() }).oxConfig.rules;
}

module.exports = {
  NATIVE_PLUGIN_MAP,
  buildOxlintConfig,
  createConfigResolver,
  findTsconfig,
  knownOxlintRules,
  normalizeRules,
  resolveConfigGroups,
  translateResolvedConfig,
};
