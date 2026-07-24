#!/usr/bin/env node
"use strict";
/*
 * @rustwrap/eslint CLI — an `eslint`-compatible command backed by oxlint. Parses the common ESLint flags,
 * expands globs (ESLint expands internally; oxlint does not), runs oxlint, renders an ESLint-style
 * report, and exits with ESLint semantics (0 = clean / warnings under threshold, 1 = lint errors or
 * --max-warnings exceeded, 2 = fatal).
 */
const fs = require("fs");
const path = require("path");
const { ESLint } = require("../lib/index.js");
const { getFormatter } = require("../lib/format.js");

function parse(argv) {
  const o = { patterns: [], rules: {}, env: {}, globals: {}, plugins: [], ignorePattern: [], maxWarnings: -1, exts: [], compatibilityWarnings: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--fix") o.fix = true;
    else if (a === "--fix-dry-run") o.fixDryRun = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--max-warnings") o.maxWarnings = parseInt(next(), 10);
    else if (a.startsWith("--max-warnings=")) o.maxWarnings = parseInt(a.split("=")[1], 10);
    else if (a === "-c" || a === "--config") o.config = next();
    else if (a.startsWith("--config=")) o.config = a.split("=")[1];
    else if (a === "--no-eslintrc") o.noEslintrc = true;
    else if (a === "--ext") o.exts.push(...next().split(","));
    else if (a.startsWith("--ext=")) o.exts.push(...a.split("=")[1].split(","));
    else if (a === "-f" || a === "--format") o.format = next();
    else if (a.startsWith("--format=")) o.format = a.split("=")[1];
    else if (a === "-o" || a === "--output-file") o.outputFile = next();
    else if (a === "--ignore-path") o.ignorePath = next();
    else if (a.startsWith("--ignore-path=")) o.ignorePath = a.split("=")[1];
    else if (a === "--ignore-pattern") o.ignorePattern.push(next());
    else if (a === "--tsconfig") o.tsconfig = next();
    else if (a.startsWith("--tsconfig=")) o.tsconfig = a.split("=")[1];
    else if (a === "--no-ignore") o.noIgnore = true;
    else if (a === "--no-color") process.env.NO_COLOR = "1";
    else if (a === "--color") process.env.FORCE_COLOR = "1";
    else if (a === "--report-unused-disable-directives") o.reportUnused = true;
    else if (a === "--resolve-plugins-relative-to") o.resolvePluginsRelativeTo = next();
    else if (a === "--parser") o.parser = next();
    else if (a === "--parser-options") o.parserOptions = parseJsonOption(next(), "--parser-options", o);
    else if (a === "--rule") Object.assign(o.rules, parseRule(next(), o));
    else if (a.startsWith("--rule=")) Object.assign(o.rules, parseRule(a.slice("--rule=".length), o));
    else if (a === "--env") Object.assign(o.env, parseKeyValue(next(), true));
    else if (a === "--global") Object.assign(o.globals, parseKeyValue(next(), "readonly"));
    else if (a === "--plugin") o.plugins.push(next());
    else if (a === "--rulesdir") { o.compatibilityWarnings.push(`--rulesdir '${next()}' is not supported.`); }
    else if (a === "--cache-location" || a === "--cache-strategy") { next(); o.compatibilityWarnings.push(`${a} is accepted but Oxlint does not use ESLint's cache.`); }
    else if (a === "--cache" || a === "--no-cache") o.compatibilityWarnings.push(`${a} is accepted but Oxlint does not use ESLint's cache.`);
    else if (a === "--stdin" || a === "--stdin-filename" || a === "--init" || a === "--debug" || a === "--exit-on-fatal-error") { if (a === "--stdin-filename") o.stdinFilename = next(); else if (a === "--stdin") o.stdin = true; }
    else if (a === "-v" || a === "--version") { console.log(require("../package.json").version + " (@rustwrap/eslint, eslint-compatible)"); process.exit(0); }
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else if (a.startsWith("-")) o.compatibilityWarnings.push(`Unknown ESLint flag '${a}' was ignored.`);
    else o.patterns.push(a);
  }
  return o;
}

function parseJsonOption(value, flag, options) {
  try { return JSON.parse(value); }
  catch (_) { options.compatibilityWarnings.push(`${flag} value '${value}' could not be parsed as JSON.`); return {}; }
}

function parseRule(value, options) {
  const colon = value.indexOf(":");
  if (colon < 0) return { [value]: "error" };
  const name = value.slice(0, colon);
  const configured = value.slice(colon + 1).trim();
  if (!configured) return { [name]: "error" };
  try { return { [name]: JSON.parse(configured) }; }
  catch (_) { return { [name]: configured }; }
}

function parseKeyValue(value, defaultValue) {
  const colon = value.indexOf(":");
  if (colon < 0) return { [value]: defaultValue };
  const key = value.slice(0, colon);
  const raw = value.slice(colon + 1);
  return { [key]: raw === "false" ? false : raw === "true" ? true : raw };
}

function printHelp() {
  console.log("@rustwrap/eslint — eslint-compatible CLI backed by oxlint\n\nUsage: eslint [options] [file|dir|glob]*\n\nCommon options: --fix --quiet --max-warnings <n> -c/--config <file> --no-eslintrc\n  --ext <.ts,.tsx> -f/--format <stylish|json|compact|unix|summary> -o/--output-file <file>\n  --ignore-path <file> --ignore-pattern <glob> --no-ignore --tsconfig <file> --color/--no-color");
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const cwd = process.cwd();
  const overrideConfig = {
    env: opts.env,
    globals: opts.globals,
    parser: opts.parser,
    parserOptions: opts.parserOptions,
    plugins: opts.plugins,
    rules: opts.rules,
  };
  if (opts.tsconfig) {
    overrideConfig.parserOptions = Object.assign({}, overrideConfig.parserOptions, { project: opts.tsconfig });
  }
  for (const warning of opts.compatibilityWarnings) {
    process.stderr.write(`@rustwrap/eslint compatibility warning: ${warning}\n`);
  }

  // stdin mode
  if (opts.stdin) {
    const code = fs.readFileSync(0, "utf8");
    const eslint = new ESLint({
      cwd,
      fix: !!(opts.fix || opts.fixDryRun),
      ignore: !opts.noIgnore,
      ignorePath: opts.ignorePath,
      overrideConfig,
      overrideConfigFile: opts.config,
      quiet: opts.quiet,
      reportUnusedDisableDirectives: opts.reportUnused,
      resolvePluginsRelativeTo: opts.resolvePluginsRelativeTo,
      useEslintrc: !opts.noEslintrc,
    });
    const results = await eslint.lintText(code, { filePath: opts.stdinFilename });
    return finish(results, opts);
  }

  if (opts.ignorePattern.length) {
    overrideConfig.ignorePatterns = opts.ignorePattern;
  }
  const eslint = new ESLint({
    cwd,
    errorOnUnmatchedPattern: false,
    extensions: opts.exts,
    fix: !!(opts.fix || opts.fixDryRun),
    ignore: !opts.noIgnore,
    ignorePath: opts.ignorePath,
    overrideConfig,
    overrideConfigFile: opts.config,
    quiet: opts.quiet,
    reportUnusedDisableDirectives: opts.reportUnused,
    resolvePluginsRelativeTo: opts.resolvePluginsRelativeTo,
    useEslintrc: !opts.noEslintrc,
  });
  const results = await eslint.lintFiles(opts.patterns.length ? opts.patterns : ["."]);
  if (opts.fix) await ESLint.outputFixes(results);
  finish(results, opts);
}

function finish(results, opts) {
  const fmt = getFormatter(opts.format);
  let output = fmt(results);
  if (opts.outputFile) { fs.mkdirSync(path.dirname(path.resolve(opts.outputFile)), { recursive: true }); fs.writeFileSync(opts.outputFile, output); }
  else if (output && output.trim()) process.stdout.write(output.endsWith("\n") ? output : output + "\n");

  let errorCount = 0, warningCount = 0;
  for (const r of results) { errorCount += r.errorCount; warningCount += r.warningCount; }
  // ESLint exit semantics.
  if (errorCount > 0) process.exit(1);
  if (opts.maxWarnings >= 0 && warningCount > opts.maxWarnings) {
    process.stderr.write(`@rustwrap/eslint: too many warnings (${warningCount}). Maximum allowed is ${opts.maxWarnings}.\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(2); });
