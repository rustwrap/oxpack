"use strict";
/* @rustwrap/eslint self-test: exercises config translation, the ESLint Node API, CLI, formatters, exit codes. */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { ESLint, CLIEngine, Linter, loadESLint } = require("../lib/index.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  PASS " + name); } else { fail++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
function section(s) { console.log("\n— " + s + " —"); }
function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rustwrap-test-"));
  for (const [rel, content] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  return dir;
}
const BIN = path.join(__dirname, "..", "bin", "rustwrap-eslint.js");

(async () => {
  section("ESLint API: lintFiles finds errors honoring .eslintrc.json");
  {
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error", "no-unused-vars": "warn" } }),
      "src/a.ts": "export const a = 1; debugger;",
      "src/clean.ts": "export const ok = 1;",
    });
    const eslint = new ESLint({ cwd: dir });
    const results = await eslint.lintFiles(["src/**/*.ts"]);
    const all = results.flatMap((r) => r.messages);
    ok("found no-debugger error", all.some((m) => m.ruleId === "no-debugger" && m.severity === 2), JSON.stringify(all));
    ok("returns a result per file (incl clean)", results.length === 2, "len=" + results.length);
    ok("clean file has 0 messages", (results.find((r) => r.filePath.endsWith("clean.ts")) || {}).errorCount === 0);
  }

  section("rule severity from config respected (warn vs error)");
  {
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "warn" } }),
      "a.ts": "export const a = 1; debugger;",
    });
    const eslint = new ESLint({ cwd: dir });
    const [r] = await eslint.lintFiles(["a.ts"]);
    ok("no-debugger downgraded to warning", r.messages.some((m) => m.ruleId === "no-debugger" && m.severity === 1));
    ok("0 errors", r.errorCount === 0);
  }

  section("plugin presets resolve through ESLint extends");
  {
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({ extends: ["plugin:local/recommended"] }),
      "node_modules/eslint-plugin-local/index.js": `module.exports = {
        configs: { recommended: { plugins: ["local"], rules: { "local/hit": "error" } } },
        rules: {
          hit: {
            create(context) {
              return { DebuggerStatement(node) { context.report({ node, message: "preset hit" }); } };
            }
          }
        }
      };`,
      "node_modules/eslint-plugin-local/package.json": JSON.stringify({ name: "eslint-plugin-local", main: "index.js" }),
      "a.tsx": "export const a = 1; debugger;",
    });
    const eslint = new ESLint({ cwd: dir });
    const [r] = await eslint.lintFiles(["a.tsx"]);
    ok("plugin preset rule executes", !!r && r.messages.some((m) => m.ruleId === "local/hit"));
  }

  section("unsupported native options fall back to the configured ESLint plugin");
  {
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({
        plugins: ["@typescript-eslint"],
        rules: {
          "@typescript-eslint/ban-types": ["error", { types: { Function: false }, extendDefaults: true }],
          "no-console": ["error", { allow: ["warn"] }],
        },
      }),
      "node_modules/@typescript-eslint/eslint-plugin/index.js": `module.exports = {
        rules: {
          "ban-types": {
            meta: {
              schema: [{
                type: "object",
                properties: { types: { type: "object" }, extendDefaults: { type: "boolean" } },
                additionalProperties: true
              }]
            },
            create(context) {
              const allowed = (context.options[0] && context.options[0].types) || {};
              return {
                TSTypeReference(node) {
                  const name = node.typeName && node.typeName.name;
                  if ((name === "Function" || name === "String") && allowed[name] !== false) {
                    context.report({ node, message: "Don't use " + name + " as a type" });
                  }
                }
              };
            }
          }
        }
      };`,
      "node_modules/@typescript-eslint/eslint-plugin/package.json": JSON.stringify({ name: "@typescript-eslint/eslint-plugin", main: "index.js" }),
      "a.ts": "export const fn: Function = () => {};\nexport const text: String = 'x';\nconsole.warn('allowed');",
    });
    const eslint = new ESLint({ cwd: dir });
    const [r] = await eslint.lintFiles(["a.ts"]);
    ok("explicit Function exemption is preserved", !r.messages.some((m) => /Function/.test(m.message)));
    ok("remaining plugin rule behavior is preserved", r.messages.some((m) => m.ruleId === "@typescript-eslint/ban-types" && /String/.test(m.message)));
    ok("unrelated rule options are preserved", !r.messages.some((m) => m.ruleId === "no-console"));
  }

  section("legacy extends materializes ESLint recommended rules");
  {
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({ extends: ["eslint:recommended"] }),
      "a.js": "missingGlobal = 1;",
    });
    const eslint = new ESLint({ cwd: dir, quiet: true });
    const [r] = await eslint.lintFiles(["a.js"]);
    ok("recommended no-undef keeps error severity under --quiet", r.messages.some((m) => m.ruleId === "no-undef" && m.severity === 2), JSON.stringify(r.messages));
  }

  section("missing native core rules run through the ESLint core bridge");
  {
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({
        parserOptions: { ecmaVersion: 2020, ecmaFeatures: { jsx: true }, sourceType: "module" },
        rules: {
          semi: ["error", "always"],
          "no-restricted-syntax": ["error", { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "XSS" }],
        },
      }),
      "a.jsx": "export const C = () => <div dangerouslySetInnerHTML={{ __html: 'x' }} />",
    });
    const eslint = new ESLint({ cwd: dir });
    const [r] = await eslint.lintFiles(["a.jsx"]);
    ok("core bridge preserves semi rule id", r.messages.some((m) => m.ruleId === "semi"));
    ok("core bridge preserves selector rule behavior", r.messages.some((m) => m.ruleId === "no-restricted-syntax" && m.message === "XSS"), JSON.stringify(r.messages));
  }

  section("multiple installed ESLint plugins load through Oxlint JS plugins");
  {
    const plugin = (message) => `module.exports = {
      meta: { name: "eslint-plugin-${message}" },
      rules: {
        hit: {
          create(context) {
            return { DebuggerStatement(node) { context.report({ node, message: "${message}" }); } };
          }
        }
      }
    };`;
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({ plugins: ["first", "second"], rules: { "first/hit": "error", "second/hit": "warn" } }),
      "node_modules/eslint-plugin-first/index.js": plugin("first"),
      "node_modules/eslint-plugin-first/package.json": JSON.stringify({ name: "eslint-plugin-first", main: "index.js" }),
      "node_modules/eslint-plugin-second/index.js": plugin("second"),
      "node_modules/eslint-plugin-second/package.json": JSON.stringify({ name: "eslint-plugin-second", main: "index.js" }),
      "a.js": "debugger;",
    });
    const eslint = new ESLint({ cwd: dir });
    const [r] = await eslint.lintFiles(["a.js"]);
    ok("first plugin rule executes", r.messages.some((m) => m.ruleId === "first/hit" && m.severity === 2));
    ok("second plugin rule executes", r.messages.some((m) => m.ruleId === "second/hit" && m.severity === 1));
  }

  section("ESLint 9 ESM flat config and plugins are materialized");
  {
    const dir = tmp({
      "package.json": JSON.stringify({ type: "module" }),
      "eslint.config.mjs": `import plugin from "./node_modules/eslint-plugin-local/index.js";
        export default [
          { ignores: ["ignored.js"] },
          { files: ["**/*.js"], plugins: { local: plugin }, rules: { "local/hit": "error" } }
        ];`,
      "node_modules/eslint-plugin-local/index.js": `export default {
        meta: { name: "eslint-plugin-local" },
        rules: {
          hit: {
            create(context) {
              return { DebuggerStatement(node) { context.report({ node, message: "flat plugin" }); } };
            }
          }
        }
      };`,
      "node_modules/eslint-plugin-local/package.json": JSON.stringify({ name: "eslint-plugin-local", type: "module", main: "index.js" }),
      "a.js": "debugger;",
      "ignored.js": "debugger;",
    });
    const eslint = new ESLint({ cwd: dir });
    const results = await eslint.lintFiles(["*.js"]);
    ok("flat-config plugin executes", results.some((r) => r.filePath.endsWith("a.js") && r.messages.some((m) => m.ruleId === "local/hit")));
    ok("flat-config global ignore applies", !results.some((r) => r.filePath.endsWith("ignored.js")));
  }

  section("isPathIgnored and deferred fixes match ESLint API behavior");
  {
    const dir = tmp({
      ".eslintignore": "ignored.js\n",
      ".eslintrc.json": JSON.stringify({ rules: { "prefer-const": "error" } }),
      "ignored.js": "debugger;",
      "fix.js": "let value = 1; console.log(value);",
    });
    const eslint = new ESLint({ cwd: dir, fix: true });
    ok("isPathIgnored returns true", await eslint.isPathIgnored(path.join(dir, "ignored.js")));
    const [result] = await eslint.lintFiles(["fix.js"]);
    ok("lintFiles does not write deferred fixes", fs.readFileSync(path.join(dir, "fix.js"), "utf8").startsWith("let "));
    ok("lintFiles returns fixed output", result.output && result.output.startsWith("const "));
    await ESLint.outputFixes([result]);
    ok("outputFixes writes returned output", fs.readFileSync(path.join(dir, "fix.js"), "utf8").startsWith("const "));
  }

  section("loadFormatter (stylish/json) + outputFixes API");
  {
    const dir = tmp({ ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error" } }), "a.ts": "debugger; export const x=1;" });
    const eslint = new ESLint({ cwd: dir });
    const results = await eslint.lintFiles(["a.ts"]);
    const jsonFmt = await eslint.loadFormatter("json");
    const parsed = JSON.parse(jsonFmt.format(results));
    ok("json formatter outputs results array", Array.isArray(parsed) && parsed[0].messages.length >= 1);
    const stylishFmt = await eslint.loadFormatter("stylish");
    ok("stylish formatter mentions error", /error/.test(stylishFmt.format(results)));
    ok("outputFixes is static fn", typeof ESLint.outputFixes === "function");
    ok("getErrorResults filters warnings", ESLint.getErrorResults([{ filePath: "x", messages: [{ severity: 1 }, { severity: 2 }], errorCount: 1, warningCount: 1 }])[0].messages.length === 1);
  }

  section("lintText");
  {
    const dir = tmp({ ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error" } }) });
    const eslint = new ESLint({ cwd: dir });
    const results = await eslint.lintText("export const a = 1; debugger;", { filePath: path.join(dir, "v.ts") });
    ok("lintText returns 1 result with source", results.length === 1 && results[0].source != null);
    ok("lintText found the debugger", results[0].messages.some((m) => m.ruleId === "no-debugger"));
  }

  section("CLIEngine (legacy) + Linter + loadESLint");
  {
    const dir = tmp({ ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error" } }), "a.ts": "debugger; export const x=1;" });
    const engine = new CLIEngine({ cwd: dir });
    const report = engine.executeOnFiles(["a.ts"]);
    ok("CLIEngine report has errorCount", report.errorCount >= 1, "errs=" + report.errorCount);
    const linter = new Linter();
    const msgs = linter.verify("debugger; export const x=1;", { rules: { "no-debugger": "error" } }, "x.ts");
    ok("Linter.verify returns messages", Array.isArray(msgs) && msgs.some((m) => m.ruleId === "no-debugger"));
    const Loaded = await loadESLint();
    ok("loadESLint resolves ESLint class", Loaded === ESLint);
  }

  section("CLI: exit codes + formats");
  {
    const dir = tmp({ ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error", "no-unused-vars": "warn" } }), "a.ts": "export const a = 1; debugger;", "warnonly.ts": "export function f(){ var unusedVar = 1; return 2; }" });
    let code = 0; let out = "";
    try { out = execFileSync(process.execPath, [BIN, "a.ts"], { cwd: dir, encoding: "utf8" }); } catch (e) { code = e.status; out = (e.stdout || "") + (e.stderr || ""); }
    ok("CLI exits 1 on error", code === 1, "code=" + code);
    ok("CLI default(stylish) prints error", /error/.test(out) && /no-debugger/.test(out), out.slice(0, 120));
    // json format
    let jout = "";
    try { jout = execFileSync(process.execPath, [BIN, "-f", "json", "a.ts"], { cwd: dir, encoding: "utf8" }); } catch (e) { jout = e.stdout || ""; }
    ok("CLI json format parses", (() => { try { return JSON.parse(jout)[0].messages.length >= 1; } catch (_) { return false; } })());
    // clean file exits 0
    let cleanCode = 0;
    try { execFileSync(process.execPath, [BIN, "--no-eslintrc", "warnonly.ts"], { cwd: dir, encoding: "utf8" }); } catch (e) { cleanCode = e.status; }
    ok("CLI exits 0 when no errors", cleanCode === 0, "code=" + cleanCode);
  }

  section("CLI: --fix-dry-run returns output without writing files");
  {
    const dir = tmp({
      ".eslintrc.json": JSON.stringify({ rules: { "prefer-const": "error" } }),
      "a.js": "let value = 1; console.log(value);",
    });
    let output = "";
    let code = 0;
    try { output = execFileSync(process.execPath, [BIN, "--fix-dry-run", "-f", "json", "a.js"], { cwd: dir, encoding: "utf8" }); }
    catch (e) { code = e.status; output = e.stdout || ""; }
    const parsed = JSON.parse(output);
    ok("--fix-dry-run exits cleanly after fixes", code === 0);
    ok("--fix-dry-run includes fixed output", parsed[0].output && parsed[0].output.startsWith("const "));
    ok("--fix-dry-run leaves the file unchanged", fs.readFileSync(path.join(dir, "a.js"), "utf8").startsWith("let "));
  }

  section("CLI: glob brace expansion + --quiet + --max-warnings");
  {
    const dir = tmp({ ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "warn" } }), "src/a.ts": "export const a=1; debugger;", "src/b.tsx": "export const b=2; debugger;" });
    // brace glob like the repo uses
    let out = "", code = 0;
    try { out = execFileSync(process.execPath, [BIN, "src/**/*.{ts,tsx}"], { cwd: dir, encoding: "utf8" }); } catch (e) { code = e.status; out = e.stdout || ""; }
    ok("brace glob expands + lints both", /a\.ts/.test(out) && /b\.tsx/.test(out), out.slice(0, 120));
    ok("warnings alone exit 0", code === 0, "code=" + code);
    // --max-warnings 1 -> 2 warnings should fail
    let mwCode = 0;
    try { execFileSync(process.execPath, [BIN, "--max-warnings", "1", "src/**/*.{ts,tsx}"], { cwd: dir, encoding: "utf8" }); } catch (e) { mwCode = e.status; }
    ok("--max-warnings exceeded exits 1", mwCode === 1, "code=" + mwCode);
    // --quiet hides warnings
    let qout = "";
    try { qout = execFileSync(process.execPath, [BIN, "--quiet", "src/**/*.{ts,tsx}"], { cwd: dir, encoding: "utf8" }); } catch (e) { qout = e.stdout || ""; }
    ok("--quiet suppresses warning output", !/no-debugger/.test(qout));
  }

  section(".eslintignore honored");
  {
    const dir = tmp({ ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error" } }), ".eslintignore": "ignored.ts\n", "ignored.ts": "debugger; export const x=1;", "kept.ts": "debugger; export const y=1;" });
    let out = "", code = 0;
    try { out = execFileSync(process.execPath, [BIN, "ignored.ts", "kept.ts"], { cwd: dir, encoding: "utf8" }); } catch (e) { code = e.status; out = e.stdout || ""; }
    ok("ignored file skipped", !/ignored\.ts/.test(out), out.slice(0, 160));
    ok("non-ignored file still linted", /kept\.ts/.test(out));
  }

  section("tsconfig: parserOptions.project resolved + passed; standard tsconfig left to oxlint");
  {
    const { buildOxlintConfig, findTsconfig } = require("../lib/config.js");
    // (a) non-standard tsconfig name referenced via parserOptions.project -> resolved + returned.
    const dirA = tmp({
      ".eslintrc.json": JSON.stringify({ parserOptions: { project: "./tsconfig.eslint.json" }, rules: { "no-debugger": "error" } }),
      "tsconfig.eslint.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "a.ts": "export const a = 1;",
    });
    const ra = buildOxlintConfig({ cwd: dirA });
    ok("parserOptions.project resolved to its tsconfig", !!ra.tsconfig && ra.tsconfig.endsWith("tsconfig.eslint.json"), String(ra.tsconfig));
    // (b) plain standard tsconfig.json with no project -> undefined (oxlint auto-discovers per file).
    const dirB = tmp({
      ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "a.ts": "export const a = 1;",
    });
    const rb = buildOxlintConfig({ cwd: dirB });
    ok("standard tsconfig.json not force-overridden", rb.tsconfig === undefined, String(rb.tsconfig));
    ok("findTsconfig still discovers the file when asked", findTsconfig(dirB) === path.join(dirB, "tsconfig.json"));
    // (c) explicit option wins.
    const rc = buildOxlintConfig({ cwd: dirB, tsconfig: "tsconfig.json" });
    ok("explicit tsconfig option honored", !!rc.tsconfig && rc.tsconfig.endsWith("tsconfig.json"));
    // (d) CLI --tsconfig runs without error and still lints.
    const dirC = tmp({
      ".eslintrc.json": JSON.stringify({ rules: { "no-debugger": "error" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "a.ts": "debugger; export const a = 1;",
    });
    let cliOut = "", cliCode = 0;
    try { cliOut = execFileSync(process.execPath, [BIN, "--tsconfig", "tsconfig.json", "a.ts"], { cwd: dirC, encoding: "utf8" }); }
    catch (e) { cliCode = e.status; cliOut = (e.stdout || "") + (e.stderr || ""); }
    ok("CLI --tsconfig lints (no-debugger error, exit 1)", cliCode === 1 && /no-debugger/.test(cliOut), "code=" + cliCode + " out=" + cliOut.slice(0, 160));
  }

  console.log(`\n@rustwrap/eslint self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
