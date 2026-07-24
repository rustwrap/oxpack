# @rustwrap/eslint

A **drop-in ESLint replacement** (CLI + Node API) backed by the Rust-based [oxlint](https://oxc.rs)
for very fast linting. Honors your existing ESLint config and ignore files — point your `eslint`
dependency at `@rustwrap/eslint` and lint **~50–80× faster**.

Compatibility is the primary requirement: target projects should not rewrite their ESLint
configuration. The wrapper resolves the effective ESLint configuration per file, groups files that
share a configuration, and uses the fastest compatible execution path:

1. Native Oxlint rules and plugins when behavior and options are supported.
2. Oxlint's JavaScript-plugin runtime for installed ESLint plugins and unsupported native variants.
3. Compatibility warnings, while continuing the lint run, for the remaining unsupported behavior.

## Measured (representative PCF control)
| | ESLint | @rustwrap/eslint |
|---|---|---|
| `src/**/*.{ts,tsx}` (~50 files) | **38.0 s**, 101 warnings | **0.48 s**, 89 warnings |

(The small warning delta is the handful of ESLint rules oxlint doesn't yet implement — see
*Limitations*. `@rustwrap/eslint` covers the large majority of correctness/style/TS/React rules.)

## Use as an ESLint override
```json
{
  "overrides": { "eslint": "npm:@rustwrap/eslint@^1" },
  "devDependencies": { "eslint": "npm:@rustwrap/eslint@^1" }
}
```
No script changes needed — `eslint …`, `pcf-scripts lint`, and tools using the ESLint Node API keep
working. `@rustwrap/eslint` ships the `eslint` bin.

## Requirements

**Node.js `^20.19.0 || ^22.13.0 || >=24`** (enforced via the package's `engines` field).

This is **not** an arbitrary floor — it is the exact intersection of the engine requirements of the
Rust toolchain this package is built on:

| Dependency | Requires | Why |
|---|---|---|
| `oxlint` (+ native binding) | `^20.19.0 \|\| >=22.12.0` | The N-API/V8 features the Rust binary uses were backported into each LTS line at Node **20.19.0** and **22.12.0**. |
| `eslint-scope` | `^20.19.0 \|\| ^22.13.0 \|\| >=24` | Follows ESLint's policy: active LTS lines only, skipping odd non-LTS majors (21.x, 23.x). |

Taking the **strictest** clause on each line yields the declared range. Reading it:

- `^20.19.0` → the **Node 20 LTS** line, from patch **.19** up (`>=20.19.0 <21`). Earlier 20.x patches
  lack the backported native feature.
- `^22.13.0` → the **Node 22 LTS** line, from patch **.13** up (`>=22.13.0 <23`). Note this is one
  patch higher than oxlint's own `22.12.0` floor, because `eslint-scope` requires `22.13.0`.
- `>=24` → **Node 24+** (the next even LTS line and beyond).
- **Excluded:** Node ≤16 (EOL), 18.x, 21.x, 22.0–22.12, and 23.x — none satisfy every dependency.

> **Node 16 / 18 are not supported.** oxlint 1.x and Rolldown 1.x dropped them; the native Rust
> binaries will not run there. The `engines` field makes this an **immediate, named `EBADENGINE`
> warning** at install (or a hard failure under `engine-strict=true`/CI) instead of a cryptic deep
> crash inside the native module.

## What it honors (config & ignore)
- **Legacy eslintrc**: `.eslintrc.json`, `.eslintrc`, `.eslintrc.js`, `.eslintrc.cjs`,
  `.eslintrc.yaml`/`.yml`, and `package.json#eslintConfig`. Auto-discovered up the directory tree;
  `--config`/`-c` and `--no-eslintrc` respected.
- **Flat config**: ESLint 9 `eslint.config.js`/`.mjs`/`.cjs`/`.ts`, including ordered `files`,
  `ignores`, rules, settings, globals, and installed plugins.
- **`extends`** — resolved through ESLint's legacy config resolver, including `eslint:recommended`,
  shareable configs, and plugin presets.
- **`plugins`** — multiple installed ESLint plugins are supported. Native Oxlint implementations are
  preferred; compatible missing rules run through Oxlint's JavaScript-plugin runtime.
- **`rules`** — passed through with severities (`off`/`warn`/`error`/numeric/array). Rules oxlint
  implements run natively. Other core and plugin rules use compatibility plugins where possible,
  preserving rule options and reported ESLint rule IDs.
- **`env`, `globals`, `settings`, `overrides`, `ignorePatterns`** — translated (incl. normalizing
  `settings.react.version: "detect"` to a concrete version).
- **`parser` / `parserOptions`** — TS/JSX is auto-detected by extension. `parserOptions.project` is
  honored for **tsconfig resolution**: oxlint auto-discovers the nearest `tsconfig.json` per file, and
  if your config points `project` at a non-standard tsconfig (e.g. `tsconfig.eslint.json`) it's passed
  through via `--tsconfig`. An explicit `--tsconfig <file>` CLI flag (and `tsconfig` Node API option)
  overrides discovery.
- **`.eslintignore`** + `--ignore-path` + `--ignore-pattern` + `--no-ignore`.

## CLI
ESLint-compatible flags: file/dir/**glob** args (incl. `src/**/*.{ts,tsx}` brace expansion — `@rustwrap/eslint`
expands globs since oxlint doesn't), `--fix`, `--quiet`, `--max-warnings <n>`, `-c/--config`,
`--no-eslintrc`, `--ext`, `-f/--format <stylish|json|compact|unix|summary>`, `-o/--output-file`,
`--ignore-path`, `--ignore-pattern`, `--no-ignore`, `--tsconfig <file>`, `--color/--no-color`, `--stdin`/`--stdin-filename`.
Other ESLint flags are accepted and ignored for drop-in tolerance.

**Exit codes** match ESLint: `0` clean (or warnings under threshold), `1` lint errors or
`--max-warnings` exceeded, `2` fatal.

## Node API
```js
const { ESLint } = require("eslint"); // -> @rustwrap/eslint
const eslint = new ESLint({ cwd, fix });
const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
const formatter = await eslint.loadFormatter("stylish");
console.log(formatter.format(results));
await ESLint.outputFixes(results);
```
Implemented: `ESLint` (`lintFiles`, `lintText`, `loadFormatter`, `calculateConfigForFile`,
`isPathIgnored`, static `outputFixes`/`getErrorResults`/`version`), legacy **`CLIEngine`**
(`executeOnFiles`/`executeOnText`/`getFormatter`), **`Linter`** (`verify`/`verifyAndFix`), and
**`loadESLint`**. Results use the ESLint `LintResult` shape (`messages[]` with
`ruleId`/`severity`/`line`/`column`, `errorCount`/`warningCount`, …).

## Engine & dependencies
- **Engine:** `oxlint` (Rust/Oxc) — does the actual linting.
- **Compat layer:** `fast-glob` (glob/brace expansion), `js-yaml` (YAML eslintrc).

## Limitations
- JavaScript plugins are limited by Oxlint's ESLint-context compatibility. A rule that calls an API
  Oxlint does not yet implement is skipped with a compatibility warning.
- Custom parsers and processors are not currently reproduced; the wrapper warns and uses Oxlint's
  JavaScript/TypeScript parser.
- `--rulesdir` is not supported. Published or local ESLint plugin packages should be used instead.
- **`--fix`** applies Oxlint and compatible-plugin fixers. The Node API defers writes until
  `ESLint.outputFixes`, matching ESLint.
- **Formatters** cover `stylish` (default), `json`, `compact`, `unix`, `summary`. Other named
  formatters fall back to `stylish`.
- Lints JS/TS/JSX only; `.json`/`.scss`/`.md` globs (which some configs include for other ESLint
  plugins) are matched but skipped.
