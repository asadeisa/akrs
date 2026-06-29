// Score one run directory. Usage: node score.mjs <T1..T5> <runDir>
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const task = process.argv[2];
const runDir = process.argv[3] || process.cwd();
const rd = (p) => readFileSync(p, "utf8").replace(/^﻿/, "");
const cfg = JSON.parse(rd(join(here, "tasks.json")));
const expected = cfg.tasks[task].expected;
const baseSig = cfg.baselineSignature;
let arm = "?";
try { arm = JSON.parse(rd(join(runDir, "_meta.json"))).arm; } catch { /* none */ }

const HARNESS_ARTIFACT = (p) => p.startsWith("_") || p === "metrics.json" || p.startsWith("node_modules");

function sh(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: runDir, encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || "") };
  }
}

function readSrc(rel) {
  const p = join(runDir, rel);
  return existsSync(p) ? rd(p) : "";
}

// --- 1. token + tool-call metrics from the stream-json log ---
let tokens_in = 0, tokens_out = 0, cost = 0, num_turns = 0;
const tools = {};
const filesRead = [];
try {
  const lines = rd(join(runDir, "_run.jsonl")).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant" && ev.message?.content) {
      for (const c of ev.message.content) {
        if (c.type === "tool_use") {
          tools[c.name] = (tools[c.name] || 0) + 1;
          if (c.name === "Read" && c.input?.file_path) filesRead.push(c.input.file_path);
          if ((c.name === "Grep" || c.name === "Glob") && c.input?.pattern) filesRead.push("(search)" + c.input.pattern);
        }
      }
    }
    if (ev.type === "result") {
      tokens_in = (ev.usage?.input_tokens || 0) + (ev.usage?.cache_read_input_tokens || 0) + (ev.usage?.cache_creation_input_tokens || 0);
      tokens_out = ev.usage?.output_tokens || 0;
      cost = ev.total_cost_usd || 0;
      num_turns = ev.num_turns || 0;
    }
  }
} catch { /* no log */ }

// --- 2. changed files (filter harness artifacts) ---
let changed = [];
try {
  changed = rd(join(runDir, "_changed.txt"))
    .split(/\r?\n/).filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((p) => p && !HARNESS_ARTIFACT(p));
} catch { /* none */ }
const inExpected = changed.filter((p) => expected.includes(p));
const scope_precision = changed.length ? inExpected.length / changed.length : 0;
const expected_hit = expected.filter((p) => changed.includes(p)).length / expected.length;

// --- 3. typecheck (hallucination signal) ---
const tsc = sh("npx tsc --noEmit");
const tsc_ok = tsc.ok;
const tsc_errors = (tsc.out.match(/error TS\d+/g) || []).length;
const halluc_tsc = (tsc.out.match(/Cannot find name|Cannot find module|has no exported member|does not exist on type/g) || []).length;

// --- 4. behavior probe ---
copyFileSync(join(here, "__score.ts"), join(runDir, "__score.ts"));
let probe = { import_ok: false };
const sc = sh(`npx tsx __score.ts ${task}`);
if (sc.ok) {
  const last = sc.out.trim().split(/\r?\n/).filter(Boolean).pop();
  try { probe = JSON.parse(last); } catch { /* keep default */ }
}

// --- 5. per-task pass + behavior hallucination ---
const controls = readSrc("src/ui/Controls.ts");
const vec = readSrc("src/math/Vector2.ts");
let pass = false;
let behavior_ok = null;
const sigOk = probe.signature != null && Math.abs(probe.signature - baseSig) / baseSig < 1e-3;
switch (task) {
  case "T1":
    pass = tsc_ok && /Restart/.test(controls) && /Play\s*\/\s*Pause/.test(controls);
    break;
  case "T2":
    behavior_ok = probe.initial_gravity === 500;
    pass = tsc_ok && behavior_ok && /2000/.test(controls) && /(clamp|Math\.min|Math\.max)/.test(controls);
    break;
  case "T3":
    behavior_ok = probe.drag_field === true && probe.energy_drag_on != null && probe.energy_drag_off != null && probe.energy_drag_on < probe.energy_drag_off * 0.999;
    pass = tsc_ok && behavior_ok && /Drag/.test(controls);
    break;
  case "T4":
    behavior_ok = probe.import_ok === true && sigOk;
    pass = tsc_ok && behavior_ok && /return new Vector2/.test(vec);
    break;
  case "T5":
    behavior_ok = probe.energy_ratio != null && probe.energy_ratio >= 0.9;
    pass = tsc_ok && behavior_ok;
    break;
}

// Behavior hallucination = silent wrong edit: claims done but behavior broken.
const halluc_behavior = behavior_ok === false ? 1 : 0;

const metrics = {
  task, runDir,
  tokens_in, tokens_out, cost, num_turns,
  tool_calls: tools, files_read: filesRead, num_reads: filesRead.length,
  changed, scope_precision, expected_hit,
  tsc_ok, tsc_errors, halluc_tsc,
  probe, behavior_ok, halluc_behavior,
  hallucination_total: halluc_tsc + halluc_behavior,
  pass,
};
metrics.arm = arm;
writeFileSync(join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify({ task, arm, pass, tsc_ok, behavior_ok, scope_precision: +scope_precision.toFixed(2), halluc: halluc_tsc + halluc_behavior, tokens_in, num_reads: filesRead.length }));
