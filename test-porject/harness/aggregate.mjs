// Aggregate all metrics.json under E:\akrs-runs into summary tables.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "E:\\akrs-runs";
const ARMS = ["A", "B", "C"];
const TASKS = ["T1", "T2", "T3", "T4", "T5"];
const rd = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const r2 = (x) => x == null ? "-" : (Math.round(x * 100) / 100);

const all = [];
for (const arm of ARMS) {
  for (const task of TASKS) {
    const tdir = join(ROOT, arm, task);
    if (!existsSync(tdir)) continue;
    for (const rep of readdirSync(tdir)) {
      const mp = join(tdir, rep, "metrics.json");
      if (existsSync(mp)) { try { all.push(rd(mp)); } catch { /* skip */ } }
    }
  }
}

function cell(rows) {
  return {
    n: rows.length,
    pass: mean(rows.map((r) => (r.pass ? 1 : 0))),
    halluc: rows.reduce((s, r) => s + (r.hallucination_total || 0), 0),
    scope: mean(rows.map((r) => r.scope_precision)),
    reads: med(rows.map((r) => r.num_reads)),
    tin: med(rows.map((r) => r.tokens_in)),
    tout: med(rows.map((r) => r.tokens_out)),
  };
}

let md = `# PoC results (auto-generated)\n\nRuns scored: ${all.length}\n\n`;
md += `## Pass rate by task × arm\n\n| Task | ` + ARMS.map((a) => `A:${a}`).join(" | ") + ` |\n|---|` + ARMS.map(() => "---").join("|") + `|\n`;
for (const task of TASKS) {
  md += `| ${task} | ` + ARMS.map((arm) => {
    const rows = all.filter((r) => r.task === task && r.arm === arm);
    if (!rows.length) return "-";
    const c = cell(rows);
    return `${Math.round(c.pass * 100)}% (${rows.filter((r) => r.pass).length}/${c.n})`;
  }).join(" | ") + ` |\n`;
}

md += `\n## Per arm × task detail\n\n| Arm | Task | n | pass | halluc | scope | reads(med) | tok_in(med) | tok_out(med) |\n|---|---|---|---|---|---|---|---|---|\n`;
const summary = {};
for (const arm of ARMS) {
  const armRows = all.filter((r) => r.arm === arm);
  if (!armRows.length) continue;
  for (const task of TASKS) {
    const rows = all.filter((r) => r.task === task && r.arm === arm);
    if (!rows.length) continue;
    const c = cell(rows);
    md += `| ${arm} | ${task} | ${c.n} | ${r2(c.pass)} | ${c.halluc} | ${r2(c.scope)} | ${c.reads} | ${c.tin} | ${c.tout} |\n`;
  }
  const c = cell(armRows);
  summary[arm] = c;
  md += `| **${arm}** | **ALL** | ${c.n} | **${r2(c.pass)}** | **${c.halluc}** | **${r2(c.scope)}** | ${c.reads} | ${c.tin} | ${c.tout} |\n`;
}

md += `\n## Arm totals\n\n| Arm | pass rate | hallucinations | mean scope | median reads | median tok_in |\n|---|---|---|---|---|---|\n`;
for (const arm of Object.keys(summary)) {
  const c = summary[arm];
  md += `| ${arm} | ${Math.round(c.pass * 100)}% | ${c.halluc} | ${r2(c.scope)} | ${c.reads} | ${c.tin} |\n`;
}

writeFileSync(join(ROOT, "summary.md"), md);
writeFileSync(join(ROOT, "summary.json"), JSON.stringify({ summary, all }, null, 2));
console.log(md);
