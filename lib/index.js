"use strict";
/*
 * @rustwrap/eslint — a drop-in ESLint Node API + CLI backed by oxlint.
 *
 * Exposes the modern `ESLint` class (lintFiles/lintText/loadFormatter/outputFixes/…), the legacy
 * `CLIEngine`, `Linter`, and `loadESLint`, all delegating to oxlint (Rust). Config is discovered
 * from the usual ESLint files and translated to oxlint's `.oxlintrc.json`.
 */
const fs = require("fs");
const path = require("path");
const fg = require("fast-glob");
const { createConfigResolver, resolveConfigGroups, translateResolvedConfig } = require("./compat-config");
const { runOxlint } = require("./runner");
const { getFormatter } = require("./format");

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"];

function expandPatterns(patterns, cwd, extensions) {
  const exts = (extensions && extensions.length ? extensions : JS_EXTS).map((e) => (e[0] === "." ? e : "." + e));
  const pats = [].concat(patterns || []);
  const files = new Set();
  for (let p of pats) {
    p = p.replace(/\\/g, "/");
    const abs = path.resolve(cwd, p);
    // Directory -> all matching files within.
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const found = fg.sync(exts.map((e) => `${p.replace(/\/$/, "")}/**/*${e}`), { cwd, absolute: true, dot: false, ignore: ["**/node_modules/**"] });
      found.forEach((f) => files.add(f));
    } else if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      files.add(abs);
    } else {
      // Glob pattern (incl. brace expansion) -> resolve via fast-glob.
      const found = fg.sync(p, { cwd, absolute: true, dot: false, ignore: ["**/node_modules/**"] });
      for (const f of found) if (exts.includes(path.extname(f))) files.add(f);
    }
  }
  return [...files];
}

class ESLint {
  constructor(options) {
    this.options = options || {};
    this.cwd = this.options.cwd || process.cwd();
  }

  async lintFiles(patterns) {
    const cwd = this.cwd;
    const o = this.options;
    const extensions = o.extensions;
    const files = expandPatterns(patterns, cwd, extensions);
    if (!files.length) {
      if (o.errorOnUnmatchedPattern !== false) throw new Error("No files matching the provided patterns were found.");
      return [];
    }
    return lintFilesWithResolvedConfigs(files, resolverOptions(o, cwd), {
      deferFixes: !!o.fix,
      fix: !!o.fix,
      quiet: !!o.quiet,
      reportUnusedDisableDirectives: o.reportUnusedDisableDirectives,
      suppressCompatibilityWarnings: !!o.suppressCompatibilityWarnings,
    });
  }

  async lintText(code, options) {
    options = options || {};
    const cwd = this.cwd;
    const filePath = options.filePath || path.join(cwd, "__stdin__.ts");
    const tmp = path.join(require("os").tmpdir(), `rustwrap-stdin-${process.pid}-${Date.now()}${path.extname(filePath) || ".ts"}`);
    fs.writeFileSync(tmp, code);
    try {
      const resolved = resolveConfigGroups([path.resolve(filePath)], Object.assign(resolverOptions(this.options, cwd), { noIgnore: true }));
      const group = resolved.groups[0];
      if (!group) return [];
      const run = runOxlint([tmp], group.oxConfig, {
        configDir: group.configDir,
        cwd,
        deferFixes: !!this.options.fix,
        fix: !!this.options.fix,
        quiet: !!this.options.quiet,
        reportUnusedDisableDirectives: this.options.reportUnusedDisableDirectives ?? group.reportUnusedDisableDirectives,
        ruleIdMap: group.ruleIdMap,
        tsconfig: group.tsconfig,
        warnings: resolved.warnings,
      });
      if (run.internalError) throw new Error(run.internalError);
      emitCompatibilityWarnings(run.warnings, this.options);
      const results = run.results;
      const r = results[0] || { filePath: tmp, messages: [], errorCount: 0, warningCount: 0, fatalErrorCount: 0, fixableErrorCount: 0, fixableWarningCount: 0, suppressedMessages: [], usedDeprecatedRules: [] };
      r.filePath = path.resolve(filePath);
      r.source = code;
      return [r];
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }

  async loadFormatter(name) {
    const fmt = getFormatter(name);
    return { format: (results) => fmt(results) };
  }

  async calculateConfigForFile(filePath) {
    const resolver = createConfigResolver(resolverOptions(this.options, this.cwd));
    const resolved = resolver.resolve(path.resolve(filePath)).config;
    return {
      env: resolved.env || {},
      globals: resolved.globals || {},
      parserOptions: resolved.parserOptions || {},
      plugins: Object.keys(resolved.plugins || {}),
      rules: resolved.rules || {},
      settings: resolved.settings || {},
    };
  }

  async isPathIgnored(filePath) {
    const resolver = createConfigResolver(resolverOptions(this.options, this.cwd));
    return resolver.resolve(path.resolve(filePath)).ignored;
  }

  getRulesMetaForResults() { return {}; }

  static async outputFixes(results) {
    // oxlint applies fixes in-place when run with --fix; lintFiles already did that when fix:true.
    // For API symmetry, write back any `output` present on results.
    for (const r of results) if (r.output != null && r.filePath) { try { fs.writeFileSync(r.filePath, r.output); } catch (_) {} }
  }

  static getErrorResults(results) {
    const out = [];
    for (const r of results) {
      const msgs = r.messages.filter((m) => m.severity === 2);
      if (msgs.length) out.push(Object.assign({}, r, { messages: msgs, warningCount: 0, fixableWarningCount: 0 }));
    }
    return out;
  }

  static get version() { return "8.57.1-rustwrap"; }
}

function resolverOptions(options, cwd) {
  const overrideConfigFile = options.overrideConfigFile;
  return {
    baseConfig: options.baseConfig,
    configFile: typeof overrideConfigFile === "string" ? overrideConfigFile : options.configFile,
    cwd,
    ignorePath: options.ignorePath,
    noEslintrc: options.useEslintrc === false || overrideConfigFile === true,
    noIgnore: options.ignore === false,
    overrideConfig: options.overrideConfig,
    resolvePluginsRelativeTo: options.resolvePluginsRelativeTo,
    tsconfig: options.tsconfig,
  };
}

function lintFilesWithResolvedConfigs(files, configOptions, runOptions) {
  const resolved = resolveConfigGroups(files, configOptions);
  const results = [];
  const warnings = new Set(resolved.warnings);
  for (const group of resolved.groups) {
    const run = runOxlint(group.files, group.oxConfig, {
      configDir: group.configDir,
      cwd: configOptions.cwd,
      deferFixes: !!runOptions.deferFixes,
      fix: !!runOptions.fix,
      noIgnore: !!configOptions.noIgnore,
      quiet: !!runOptions.quiet,
      reportUnusedDisableDirectives: runOptions.reportUnusedDisableDirectives ?? group.reportUnusedDisableDirectives,
      ruleIdMap: group.ruleIdMap,
      tsconfig: group.tsconfig,
      warnings: [...warnings],
    });
    for (const warning of run.warnings || []) warnings.add(warning);
    if (run.internalError) throw new Error(run.internalError);
    results.push(...run.results);
  }
  emitCompatibilityWarnings([...warnings], runOptions);
  const lintedFiles = files.filter((file) => !resolved.ignoredFiles.has(path.resolve(file)));
  return fillMissing(results, lintedFiles);
}

function emitCompatibilityWarnings(warnings, options) {
  if (!warnings || !warnings.length || options.suppressCompatibilityWarnings) return;
  for (const warning of new Set(warnings)) process.stderr.write(`@rustwrap/eslint compatibility warning: ${warning}\n`);
}

function fillMissing(results, files) {
  const have = new Set(results.map((r) => path.resolve(r.filePath)));
  for (const f of files) if (!have.has(path.resolve(f))) results.push({ filePath: path.resolve(f), messages: [], suppressedMessages: [], errorCount: 0, warningCount: 0, fatalErrorCount: 0, fixableErrorCount: 0, fixableWarningCount: 0, usedDeprecatedRules: [] });
  return results;
}

// Legacy CLIEngine (eslint <7) — enough for tools that still use it.
class CLIEngine {
  constructor(options) { this.options = options || {}; this._eslint = new ESLint(translateLegacy(options)); }
  executeOnFiles(patterns) {
    const cwd = this.options.cwd || process.cwd();
    const files = expandPatterns(patterns, cwd, this.options.extensions);
    const filled = lintFilesWithResolvedConfigs(files, resolverOptions(translateLegacy(this.options), cwd), {
      deferFixes: !!this.options.fix,
      fix: !!this.options.fix,
      quiet: !!this.options.quiet,
    });
    return makeReport(filled);
  }
  executeOnText(text, filename) {
    const cwd = this.options.cwd || process.cwd();
    const tmp = path.join(require("os").tmpdir(), `rustwrap-cli-${Date.now()}${path.extname(filename || ".ts") || ".ts"}`);
    fs.writeFileSync(tmp, text);
    try {
      const logicalPath = filename ? path.resolve(filename) : path.join(cwd, "input.ts");
      const resolved = resolveConfigGroups([logicalPath], Object.assign(resolverOptions(translateLegacy(this.options), cwd), { noIgnore: true }));
      const group = resolved.groups[0];
      const run = runOxlint([tmp], group ? group.oxConfig : null, {
        configDir: group && group.configDir,
        cwd,
        deferFixes: !!this.options.fix,
        fix: !!this.options.fix,
        reportUnusedDisableDirectives: group && group.reportUnusedDisableDirectives,
        ruleIdMap: group && group.ruleIdMap,
        tsconfig: group && group.tsconfig,
        warnings: resolved.warnings,
      });
      if (run.internalError) throw new Error(run.internalError);
      emitCompatibilityWarnings(run.warnings, this.options);
      const results = run.results;
      if (results[0]) results[0].filePath = filename ? path.resolve(filename) : "<text>";
      return makeReport(results.length ? results : [{ filePath: filename || "<text>", messages: [], errorCount: 0, warningCount: 0, fatalErrorCount: 0, fixableErrorCount: 0, fixableWarningCount: 0 }]);
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
  getFormatter(name) { return (results) => getFormatter(name)(results); }
  static outputFixes(report) { return ESLint.outputFixes(report.results || []); }
  static getErrorResults(results) { return ESLint.getErrorResults(results); }
}

function translateLegacy(o) {
  o = o || {};
  return {
    baseConfig: o.baseConfig,
    configFile: o.configFile,
    cwd: o.cwd,
    extensions: o.extensions,
    fix: o.fix,
    ignore: o.ignore,
    ignorePath: o.ignorePath,
    overrideConfig: o.rules ? { rules: o.rules } : undefined,
    quiet: o.quiet,
    resolvePluginsRelativeTo: o.resolvePluginsRelativeTo,
    useEslintrc: o.useEslintrc,
  };
}

function makeReport(results) {
  let errorCount = 0, warningCount = 0, fixableErrorCount = 0, fixableWarningCount = 0;
  for (const r of results) { errorCount += r.errorCount; warningCount += r.warningCount; fixableErrorCount += r.fixableErrorCount || 0; fixableWarningCount += r.fixableWarningCount || 0; }
  return { results, errorCount, warningCount, fixableErrorCount, fixableWarningCount, usedDeprecatedRules: [] };
}

// Minimal Linter (verify on text) — oxlint has no in-process verify, so shell out per call.
class Linter {
  constructor() {}
  verify(code, config, options) {
    const filename = (typeof options === "string" ? options : options && options.filename) || "input.ts";
    const tmp = path.join(require("os").tmpdir(), `rustwrap-linter-${Date.now()}${path.extname(filename) || ".ts"}`);
    fs.writeFileSync(tmp, code);
    try {
      const translated = translateResolvedConfig({
        env: config && config.env,
        globals: config && config.globals,
        parserOptions: config && config.parserOptions,
        plugins: {},
        rules: config && config.rules,
        settings: config && config.settings,
        warnings: [],
      }, { cwd: process.cwd() });
      const run = runOxlint([tmp], translated.oxConfig, {
        cwd: process.cwd(),
        reportUnusedDisableDirectives: config && config.reportUnusedDisableDirectives,
        ruleIdMap: translated.ruleIdMap,
        tsconfig: translated.tsconfig,
        warnings: translated.warnings,
      });
      emitCompatibilityWarnings(run.warnings, {});
      return (run.results[0] && run.results[0].messages) || [];
    }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
  verifyAndFix(code, config, options) {
    const filename = (options && options.filename) || "input.ts";
    const tmp = path.join(require("os").tmpdir(), `rustwrap-linter-fix-${Date.now()}${path.extname(filename) || ".ts"}`);
    fs.writeFileSync(tmp, code);
    try {
      const translated = translateResolvedConfig({
        env: config && config.env,
        globals: config && config.globals,
        parserOptions: config && config.parserOptions,
        plugins: {},
        rules: config && config.rules,
        settings: config && config.settings,
        warnings: [],
      }, { cwd: process.cwd() });
      const run = runOxlint([tmp], translated.oxConfig, {
        cwd: process.cwd(),
        deferFixes: true,
        fix: true,
        ruleIdMap: translated.ruleIdMap,
        warnings: translated.warnings,
      });
      const result = run.results[0];
      return {
        fixed: !!(result && result.output !== undefined),
        messages: result && result.messages ? result.messages : [],
        output: result && result.output !== undefined ? result.output : code,
      };
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
  getRules() { return new Map(); }
  defineRule() {} defineRules() {} defineParser() {}
  static get version() { return ESLint.version; }
}

async function loadESLint(opts) { return ESLint; }

module.exports = { ESLint, CLIEngine, Linter, loadESLint, expandPatterns };
module.exports.default = module.exports;
