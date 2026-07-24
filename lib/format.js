"use strict";
/* ESLint-compatible output formatters rendered from LintResult[]. */
const path = require("path");

const c = (process.stdout.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR
  ? { dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", under: "\x1b[4m", bold: "\x1b[1m", reset: "\x1b[0m", green: "\x1b[32m" }
  : { dim: "", red: "", yellow: "", under: "", bold: "", reset: "", green: "" };

function stylish(results) {
  let out = "\n";
  let errors = 0, warnings = 0;
  for (const r of results) {
    if (!r.messages.length) continue;
    out += `${c.under}${r.filePath}${c.reset}\n`;
    for (const m of r.messages) {
      const sev = m.severity === 2 ? `${c.red}error${c.reset}` : `${c.yellow}warning${c.reset}`;
      if (m.severity === 2) errors++; else warnings++;
      const loc = `${c.dim}${m.line}:${m.column}${c.reset}`;
      out += `  ${loc}  ${sev}  ${m.message}  ${c.dim}${m.ruleId || ""}${c.reset}\n`;
    }
    out += "\n";
  }
  const total = errors + warnings;
  if (total > 0) {
    const color = errors > 0 ? c.red : c.yellow;
    out += `${color}${c.bold}\u2716 ${total} problem${total === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})${c.reset}\n`;
  }
  return total > 0 ? out : "";
}

function compact(results) {
  const lines = [];
  for (const r of results) for (const m of r.messages) {
    lines.push(`${r.filePath}: line ${m.line}, col ${m.column}, ${m.severity === 2 ? "Error" : "Warning"} - ${m.message} (${m.ruleId || ""})`);
  }
  const total = lines.length;
  if (total) lines.push(`\n${total} problem${total === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function unix(results) {
  const lines = [];
  for (const r of results) for (const m of r.messages) {
    lines.push(`${r.filePath}:${m.line}:${m.column}: ${m.message} [${m.severity === 2 ? "Error" : "Warning"}/${m.ruleId || ""}]`);
  }
  return lines.join("\n");
}

function json(results) { return JSON.stringify(results); }

function summary(results) {
  const byRule = new Map();
  let errors = 0, warnings = 0;
  for (const r of results) for (const m of r.messages) {
    if (m.severity === 2) errors++; else warnings++;
    const k = m.ruleId || "(unknown)";
    byRule.set(k, (byRule.get(k) || 0) + 1);
  }
  const rows = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
  let out = "\nESLint Summary\n";
  for (const [rule, n] of rows) out += `  ${String(n).padStart(5)}  ${rule}\n`;
  out += `\n  ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}\n`;
  return out;
}

const FORMATTERS = { stylish, json, compact, unix, summary };

function getFormatter(name) {
  return FORMATTERS[name || "stylish"] || stylish;
}

module.exports = { getFormatter, stylish, json, compact, unix, summary };
