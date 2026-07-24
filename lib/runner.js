"use strict";
/* Runs oxlint and maps its JSON diagnostics to ESLint-shaped results. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let typeAwareAvailable;

function oxlintBin() {
  // oxlint's package.json `exports` blocks subpath resolution, so locate the package dir via its
  // package.json and join the declared bin path.
  try {
    const pkgPath = require.resolve("oxlint/package.json");
    const pkg = require(pkgPath);
    const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin && pkg.bin.oxlint) || "bin/oxlint";
    return path.join(path.dirname(pkgPath), rel);
  } catch (_) {}
  return "oxlint";
}

// oxlint diagnostic code "eslint(no-debugger)" / "typescript(no-explicit-any)" -> ESLint ruleId.
function toRuleId(code, ruleIdMap) {
  if (!code) return null;
  const m = /^([^()]+)\(([^)]+)\)$/.exec(code);
  if (!m) return code;
  const plugin = m[1], rule = m[2];
  let ruleId;
  switch (plugin) {
    case "eslint": ruleId = rule; break;
    case "typescript": ruleId = "@typescript-eslint/" + rule; break;
    case "react": ruleId = "react/" + rule; break;
    case "react-perf": ruleId = "react-perf/" + rule; break;
    case "react-hooks": ruleId = "react-hooks/" + rule; break;
    case "jsx-a11y": ruleId = "jsx-a11y/" + rule; break;
    case "nextjs": ruleId = "@next/next/" + rule; break;
    case "node": ruleId = "n/" + rule; break;
    default: ruleId = plugin + "/" + rule;
  }
  return (ruleIdMap && (ruleIdMap[ruleId] || ruleIdMap[plugin + "/" + rule])) || ruleId;
}

function severityNum(s) { return s === "error" ? 2 : 1; }

// Run oxlint over `paths` with the given oxlint config, returning ESLint LintResult[].
function runOxlint(paths, oxConfigObj, opts) {
  opts = opts || {};
  const warnings = new Set(opts.warnings || []);
  const allowedBanTypes = collectAllowedBanTypes(oxConfigObj);
  // oxlint hard-fails config parsing on rule names it doesn't implement. We can't reliably know that
  // set ahead of time (its schema lists placeholder rules), so we run, and if it reports
  // "Rule 'X' not found", strip those rules and retry until the config is accepted.
  let cfg = oxConfigObj ? JSON.parse(JSON.stringify(oxConfigObj)) : null;
  let strippedOptions = false;
  let typeAware = !!opts.typeAware;
  let attemptedTypeAware = typeAware;
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = invoke(paths, cfg, Object.assign({}, opts, { typeAware }));
    const errText = (res.parseError || "");
    if (errText) {
      const bad = extractUnknownRules(errText);
      if (bad.length && cfg) {
        if (!attemptedTypeAware && bad.some((item) => item.plugin === "typescript") && hasTypeAwareSupport()) {
          typeAware = true;
          attemptedTypeAware = true;
          continue;
        }
        let removed = false;
        for (const item of bad) {
          if (stripRule(cfg, item.ruleId)) {
            removed = true;
            warnings.add(`Rule '${item.ruleId}' is not supported by the active Oxlint runtime and was skipped.`);
          }
        }
        if (removed) continue; // retry without the offending rules
      }
      // Unknown plugin (e.g. an eslint plugin with no oxlint equivalent) -> drop it + any rules that
      // reference it by that prefix, then retry.
      const badPlugins = extractUnknownPlugins(errText);
      if (badPlugins.length && cfg) {
        let changed = false;
        for (const pl of badPlugins) {
          if (stripPlugin(cfg, pl)) {
            changed = true;
            warnings.add(`Plugin '${pl}' is not supported by Oxlint and was skipped.`);
          }
        }
        if (changed) continue;
      }
      const failedJsPlugins = extractFailedJsPlugins(errText);
      if (failedJsPlugins.length && cfg) {
        let changed = false;
        for (const specifier of failedJsPlugins) {
          const removed = stripJsPlugin(cfg, specifier);
          if (removed) {
            changed = true;
            warnings.add(`JavaScript plugin '${specifier}' could not be loaded by Oxlint and was skipped.`);
          }
        }
        if (changed) continue;
      }
      // Oxlint supports some ESLint rules without supporting their configuration options. Strip
      // options only from the rejected rule so unrelated rules keep their configured behavior.
      const invalidOptionRules = extractInvalidOptionRules(errText);
      if (invalidOptionRules.length && cfg) {
        let changed = false;
        for (const name of invalidOptionRules) {
          if (stripRuleOptions(cfg, name)) {
            changed = true;
            warnings.add(`Options for rule '${name}' are not supported by Oxlint; the rule is running with its default options.`);
          }
        }
        if (changed) continue;
      }
      // Not an unknown-rule/plugin error (e.g. an unsupported rule option). Downgrade every rule to
      // its bare severity (drop options) once, then retry — options are best-effort, never fatal.
      if (cfg && !strippedOptions && hasRuleOptions(cfg)) {
        dropAllOptions(cfg);
        strippedOptions = true;
        warnings.add("Oxlint rejected configured rule options that could not be isolated; all remaining rule options were removed.");
        continue;
      }
      return { results: [], internalError: errText, warnings: [...warnings] };
    }
    let diagnostics = filterAllowedBanTypes((res.parsed && res.parsed.diagnostics) || [], allowedBanTypes);
    diagnostics = filterPluginRuntimeErrors(diagnostics, warnings);
    const results = groupResults(diagnostics, opts.cwd || process.cwd(), opts.ruleIdMap);
    attachOutputs(results, res.outputs);
    return { results, raw: res.parsed, warnings: [...warnings] };
  }
  return {
    results: [],
    internalError: "@rustwrap/eslint: could not produce a valid oxlint config after stripping unknown rules/options",
    warnings: [...warnings],
  };
}

function hasTypeAwareSupport() {
  if (typeAwareAvailable === undefined) {
    try {
      require.resolve("oxlint-tsgolint/package.json");
      typeAwareAvailable = true;
    } catch (_) {
      typeAwareAvailable = false;
    }
  }
  return typeAwareAvailable;
}

function hasRuleOptions(cfg) {
  const any = (rules) => rules && Object.values(rules).some((v) => Array.isArray(v) && v.length > 1);
  if (any(cfg.rules)) return true;
  if (cfg.overrides) for (const o of cfg.overrides) if (any(o.rules)) return true;
  return false;
}
function dropAllOptions(cfg) {
  const strip = (rules) => { if (!rules) return; for (const k of Object.keys(rules)) if (Array.isArray(rules[k])) rules[k] = rules[k][0]; };
  strip(cfg.rules);
  if (cfg.overrides) for (const o of cfg.overrides) strip(o.rules);
}

// One oxlint invocation. Returns { parsed } on success or { parseError } on a config-parse failure.
function invoke(paths, cfg, opts) {
  const args = [];
  let tmpCfg;
  let originals;
  let outputs;
  if (cfg) {
    const configDir = opts.configDir && fs.existsSync(opts.configDir) ? opts.configDir : os.tmpdir();
    tmpCfg = path.join(configDir, `.rustwrap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.oxlintrc.json`);
    fs.writeFileSync(tmpCfg, JSON.stringify(cfg));
    args.push("-c", tmpCfg);
  }
  if (opts.fix && opts.deferFixes) originals = snapshotFiles(paths);
  if (opts.fix) args.push("--fix");
  if (opts.quiet) args.push("--quiet");
  if (opts.ignorePath) args.push("--ignore-path", opts.ignorePath);
  for (const p of opts.ignorePattern || []) args.push("--ignore-pattern", p);
  if (opts.noIgnore) args.push("--no-ignore");
  if (opts.tsconfig) args.push("--tsconfig", opts.tsconfig);
  if (opts.typeAware) args.push("--type-aware");
  if (opts.reportUnusedDisableDirectives === true) args.push("--report-unused-disable-directives");
  else if (opts.reportUnusedDisableDirectives && opts.reportUnusedDisableDirectives !== "off") {
    args.push("--report-unused-disable-directives-severity", String(opts.reportUnusedDisableDirectives));
  }
  args.push("--disable-nested-config");
  args.push("--format", "json", "--no-error-on-unmatched-pattern");
  args.push(...paths);

  const bin = oxlintBin();
  const res = spawnSync(process.execPath, [bin, ...args], { cwd: opts.cwd || process.cwd(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (originals) {
    outputs = captureOutputs(paths, originals);
    restoreFiles(originals);
  }
  if (tmpCfg) { try { fs.unlinkSync(tmpCfg); } catch (_) {} }
  if (res.error) throw res.error;
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  // Config-parse failures are printed (to stdout or stderr) and produce no JSON.
  if (/Failed to parse (oxlint )?config/i.test(stdout + stderr) || /not found in plugin/i.test(stdout + stderr)) {
    return { parseError: (stdout + "\n" + stderr).trim() };
  }
  try { return { parsed: JSON.parse(stdout), outputs }; }
  catch (_) { return { parseError: (stderr || stdout || "oxlint failed").trim() }; }
}

function extractUnknownRules(text) {
  const out = [];
  const re = /Rule '([^']+)' not found in plugin '([^']+)'/g;
  let m;
  while ((m = re.exec(text))) {
    const plugin = m[2];
    out.push({ plugin, rule: m[1], ruleId: plugin === "eslint" ? m[1] : `${plugin}/${m[1]}` });
  }
  return out;
}

function extractUnknownPlugins(text) {
  const out = [];
  const re = /Plugin '([^']+)' not found/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function extractInvalidOptionRules(text) {
  const out = [];
  const re = /Invalid configuration for rule [`'"]([^`'"]+)[`'"]:/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function extractFailedJsPlugins(text) {
  const out = [];
  const re = /Failed to load JS plugin:\s*([^\r\n]+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

function stripRuleOptions(cfg, name) {
  let changed = false;
  const strip = (rules) => {
    if (!rules) return;
    for (const k of Object.keys(rules)) {
      if (k === name && Array.isArray(rules[k])) {
        rules[k] = rules[k][0];
        changed = true;
      }
    }
  };
  strip(cfg.rules);
  if (cfg.overrides) for (const o of cfg.overrides) strip(o.rules);
  return changed;
}

function collectAllowedBanTypes(cfg) {
  const allowed = new Set();
  if (!cfg || !cfg.rules) return allowed;
  const bare = (k) => k.replace(/^@[^/]+\//, "").replace(/^[^/]+\//, "");
  for (const [name, value] of Object.entries(cfg.rules)) {
    if (bare(name) !== "ban-types" || !Array.isArray(value)) continue;
    const options = value[1];
    if (!options || typeof options !== "object" || Array.isArray(options) || !options.types) continue;
    for (const [typeName, setting] of Object.entries(options.types)) {
      if (setting === false) allowed.add(typeName);
    }
  }
  return allowed;
}

function filterAllowedBanTypes(diagnostics, allowedTypes) {
  if (!allowedTypes.size) return diagnostics;
  return diagnostics.filter((diagnostic) => {
    if (toRuleId(diagnostic.code) !== "@typescript-eslint/ban-types") return true;
    const match = /(?:Don't|Do not) use [`'"]([^`'"]+)[`'"] as a type/.exec(diagnostic.message || "");
    return !match || !allowedTypes.has(match[1]);
  });
}

function filterPluginRuntimeErrors(diagnostics, warnings) {
  return diagnostics.filter((diagnostic) => {
    const message = diagnostic.message || "";
    if (!message.startsWith("Error running JS plugin.")) return true;
    const lines = message.split(/\r?\n/);
    const error = lines.find((line) => /^(?:TypeError|Error|ReferenceError|RangeError):/.test(line.trim()));
    const stack = lines.find((line) => /^\s+at /.test(line));
    const summary = [error && error.trim(), stack && stack.trim().replace(/:\d+:\d+\)?$/, ")")].filter(Boolean).join(" ");
    warnings.add(`A JavaScript plugin rule failed${summary ? `: ${summary}` : ""}. The incompatible rule was skipped for this run.`);
    return false;
  });
}

// Remove an unknown plugin from `plugins` and any rule keyed with that plugin prefix.
function stripPlugin(cfg, plugin) {
  let changed = false;
  if (Array.isArray(cfg.plugins)) { const before = cfg.plugins.length; cfg.plugins = cfg.plugins.filter((p) => p !== plugin); if (cfg.plugins.length !== before) changed = true; }
  const prefix = plugin + "/";
  const strip = (rules) => { if (!rules) return; for (const k of Object.keys(rules)) if (k.startsWith(prefix) || k.startsWith("@" + prefix)) { delete rules[k]; changed = true; } };
  strip(cfg.rules);
  if (cfg.overrides) for (const o of cfg.overrides) strip(o.rules);
  return changed;
}

function stripJsPlugin(cfg, specifier) {
  if (!Array.isArray(cfg.jsPlugins)) return false;
  const removedAliases = [];
  cfg.jsPlugins = cfg.jsPlugins.filter((entry) => {
    const entrySpecifier = typeof entry === "string" ? entry : entry.specifier;
    if (entrySpecifier !== specifier) return true;
    if (typeof entry === "object" && entry.name) removedAliases.push(entry.name);
    return false;
  });
  if (!removedAliases.length) return false;
  const strip = (rules) => {
    if (!rules) return;
    for (const name of Object.keys(rules)) {
      if (removedAliases.some((alias) => name.startsWith(`${alias}/`))) delete rules[name];
    }
  };
  strip(cfg.rules);
  if (cfg.overrides) for (const override of cfg.overrides) strip(override.rules);
  return true;
}

function stripRule(cfg, name) {
  let removed = false;
  const strip = (rules) => {
    if (!rules) return;
    for (const k of Object.keys(rules)) {
      if (k === name) { delete rules[k]; removed = true; }
    }
  };
  strip(cfg.rules);
  if (cfg.overrides) for (const o of cfg.overrides) strip(o.rules);
  return removed;
}

// Group flat diagnostics by file into ESLint LintResult objects.
function groupResults(diagnostics, cwd, ruleIdMap) {
  const byFile = new Map();
  for (const d of diagnostics) {
    const file = path.resolve(cwd, d.filename || "<input>");
    if (!byFile.has(file)) byFile.set(file, []);
    const label = (d.labels && d.labels[0] && d.labels[0].span) || {};
    const sev = severityNum(d.severity);
    byFile.get(file).push({
      ruleId: toRuleId(d.code, ruleIdMap),
      severity: sev,
      message: d.message || "",
      line: label.line || 1,
      column: label.column || 1,
      endLine: label.line || undefined,
      endColumn: label.column != null && label.length != null ? label.column + label.length : undefined,
      nodeType: null,
      messageId: undefined,
      fix: undefined,
    });
  }

  const results = [];
  for (const [filePath, messages] of byFile) results.push(makeResult(filePath, messages));
  return results;
}

function snapshotFiles(paths) {
  const originals = new Map();
  for (const file of paths) {
    try { originals.set(path.resolve(file), fs.readFileSync(file)); } catch (_) {}
  }
  return originals;
}

function captureOutputs(paths, originals) {
  const outputs = new Map();
  for (const file of paths) {
    const absolute = path.resolve(file);
    if (!originals.has(absolute)) continue;
    try {
      const changed = fs.readFileSync(absolute);
      if (!changed.equals(originals.get(absolute))) outputs.set(absolute, changed.toString("utf8"));
    } catch (_) {}
  }
  return outputs;
}

function restoreFiles(originals) {
  for (const [file, content] of originals) {
    try { fs.writeFileSync(file, content); } catch (_) {}
  }
}

function attachOutputs(results, outputs) {
  if (!outputs || !outputs.size) return;
  const byFile = new Map(results.map((result) => [path.resolve(result.filePath), result]));
  for (const [filePath, output] of outputs) {
    let result = byFile.get(path.resolve(filePath));
    if (!result) {
      result = makeResult(path.resolve(filePath), []);
      results.push(result);
    }
    result.output = output;
  }
}

function makeResult(filePath, messages) {
  let errorCount = 0, warningCount = 0, fatalErrorCount = 0;
  for (const m of messages) { if (m.severity === 2) { errorCount++; if (m.fatal) fatalErrorCount++; } else warningCount++; }
  return {
    filePath, messages,
    suppressedMessages: [],
    errorCount, warningCount, fatalErrorCount,
    fixableErrorCount: 0, fixableWarningCount: 0,
    source: undefined, usedDeprecatedRules: [],
  };
}

module.exports = { runOxlint, toRuleId, makeResult, groupResults };
