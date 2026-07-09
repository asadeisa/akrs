#!/usr/bin/env node
// AKRS CLI — copy the framework into a project, and validate a generated workflow.
// Zero dependencies. ESM. Node >= 16.
//
// Usage:
//   npx akrs-framework init                 Copy the AKRS framework into ./docs/akrs/
//   npx akrs-framework init --force         Overwrite ./docs/akrs/ if it already exists
//   npx akrs-framework validate             Validate the workflow in ./akrs
//   npx akrs-framework validate --dir path  Validate a workflow in a custom directory
//   npx akrs-framework validate --fix        Also apply safe mechanical fixes (status mirrors)
//   npx akrs-framework validate --clean      Also delete stale ephemeral artifacts

import {
  existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync,
  statSync, rmSync, renameSync,
} from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..'); // the installed package root
const cwd = process.cwd();

const args = process.argv.slice(2);
const command = args[0];
const flag = (...names) => names.some((n) => args.includes(n));

const HELP = `
AKRS — Adaptive Knowledge Routing System

Usage
  npx akrs-framework init            Copy the AKRS framework docs into ./docs/akrs/
  npx akrs-framework init --force    Overwrite ./docs/akrs/ if it already exists
  npx akrs-framework validate        Validate the generated workflow in ./akrs
    --dir <path>   validate a workflow directory other than ./akrs
    --fix          apply safe mechanical fixes (sync mirrored Road statuses; rotate an over-threshold LOG ledger)
    --clean        delete stale ephemeral artifacts (handoffs / change files)

'validate' checks Road status/expected-files/deps, STATE (incl. parked owner decisions), the
LOG ledger (size + entry length), the kernel folder, and the ephemeral-artifact lifecycle
(handoff / change / BLOCKED / tester memory). CI green = valid.

Docs & issues: https://github.com/asadeisa/akrs
`;

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function runInit() {
  const force = flag('--force', '-f');
  const target = join(cwd, 'docs', 'akrs');

  if (existsSync(target) && !force) {
    process.stderr.write(
      `\nAKRS: "${relative(cwd, target) || target}" already exists.\n` +
        `Re-run with --force to overwrite:\n\n    npx akrs-framework init --force\n\n`,
    );
    process.exit(1);
  }

  const copies = [
    ['docs/framework', join(target, 'framework')],
    ['GETTING_STARTED.md', join(target, 'GETTING_STARTED.md')],
  ];

  mkdirSync(target, { recursive: true });
  for (const [src, dest] of copies) {
    const from = join(pkgRoot, src);
    if (!existsSync(from)) {
      process.stderr.write(`AKRS: missing in package, skipped: ${src}\n`);
      continue;
    }
    cpSync(from, dest, { recursive: true, force: true });
  }

  const rel = relative(cwd, target) || target;
  process.stdout.write(
    `\n✅ AKRS framework copied to ${rel}\n\n` +
      `Next steps:\n` +
      `  1. Read   ${join(rel, 'GETTING_STARTED.md')}\n` +
      `  2. Point your Leader model at ${join(rel, 'framework')}\n` +
      `  3. Generate your workflow (Phase A), then your first Task + Road.\n\n`,
  );
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

// A tiny word count consistent with the doctrine budgets: count whitespace
// tokens that contain an alphanumeric (so markdown table pipes / arrows / dots
// don't inflate the total).
function wordCount(text) {
  return text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
}

function listFiles(dir, pred) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!pred || pred(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const isMd = (p) => p.toLowerCase().endsWith('.md');
const inDir = (p, seg) => p.replace(/\\/g, '/').split('/').includes(seg);
const roadId = (p) => basename(p).replace(/\.md$/i, '');

function statusWord(text) {
  const m = text.match(/^\s*Status:\s*(.+)\s*$/im);
  if (!m) return null;
  const v = m[1].trim();
  if (/^ACTIVE$/i.test(v)) return { word: 'ACTIVE', raw: v, legal: true };
  if (/^QUEUED$/i.test(v)) return { word: 'QUEUED', raw: v, legal: true };
  if (/^DONE\b/i.test(v)) return { word: 'DONE', raw: v, legal: /superseded by\s+\S/i.test(v) };
  return { word: v.split(/\s+/)[0].toUpperCase(), raw: v, legal: false };
}

// Parse an "Expected files" list from a Road: items under a heading/label
// containing "Expected files", until a blank line or the next heading.
function expectedFiles(text) {
  const lines = text.split(/\r?\n/);
  const files = [];
  let capture = false;
  for (const line of lines) {
    if (/expected files/i.test(line)) { capture = true; continue; }
    if (capture) {
      if (/^\s*#{1,6}\s/.test(line)) break;                 // next heading
      if (/^\s*$/.test(line) && files.length) break;         // blank after items
      const m = line.match(/^\s*[-*]\s+(.+)$/);
      if (m) {
        let tok = m[1].replace(/`/g, '').trim().split(/\s+/)[0];
        if (tok) files.push(tok);
      } else if (files.length) break;
    }
  }
  return files;
}

function depIds(text) {
  const m = text.match(/^\s*Deps:\s*(.+)\s*$/im);
  if (!m) return [];
  return m[1].split(/[,\s]+/).map((s) => s.replace(/`/g, '').replace(/\.md$/i, '').trim())
    .filter(Boolean).filter((s) => !/^none$/i.test(s));
}

function runValidate() {
  const dir = argValue('--dir', 'akrs');
  const doFix = flag('--fix');
  const doClean = flag('--clean');
  const akrs = resolve(cwd, dir);

  const errors = [];
  const warns = [];
  const notes = [];
  const err = (file, msg) => errors.push(`${rel(file)}: ${msg}`);
  const warn = (file, msg) => warns.push(`${rel(file)}: ${msg}`);
  const rel = (p) => relative(cwd, p).replace(/\\/g, '/') || p;

  if (!existsSync(akrs)) {
    // FW-6(b): scan one directory level — if exactly one subfolder holds an akrs/, point there.
    let hint = '';
    if (!args.includes('--dir')) {
      try {
        const nested = readdirSync(cwd, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .filter((e) => existsSync(join(cwd, e.name, 'akrs')))
          .map((e) => `${e.name}/akrs`);
        if (nested.length === 1)
          hint = `\nFound ${nested[0]} — run:\n\n    npx akrs-framework validate --dir ${nested[0]}\n`;
      } catch {}
    }
    process.stderr.write(`AKRS: no workflow found at "${rel(akrs)}". ` +
      `Pass --dir <path> to point at your akrs/ directory.\n${hint}`);
    return 1;
  }

  const allMd = listFiles(akrs, isMd);
  // FW-7(a): roads/README.md and tasks/README.md are template docs, not artifacts — never lint
  // them as Roads/Tasks (they were the permanent "2 errors" noise in the v1.2 run).
  const notReadme = (p) => basename(p).toLowerCase() !== 'readme.md';
  const roadFiles = allMd.filter((p) => inDir(p, 'roads') && notReadme(p));
  const taskFiles = allMd.filter((p) => inDir(p, 'tasks') && notReadme(p));
  const memoryFiles = allMd.filter((p) => inDir(p, 'memory'));

  const roads = roadFiles.map((p) => {
    const text = read(p);
    const sw = statusWord(text);
    return { file: p, id: roadId(p), text, status: sw,
      deps: depIds(text), expected: expectedFiles(text) };
  });
  const roadById = new Map(roads.map((r) => [r.id, r]));

  const statePath = join(akrs, 'STATE.md');
  const stateText = existsSync(statePath) ? read(statePath) : null;
  const logPath = join(akrs, 'LOG.md');
  let logOverThreshold = false;
  const featuresPath = join(akrs, 'FEATURES.md');
  const featuresText = existsSync(featuresPath) ? read(featuresPath) : '';
  const overridden = (id) =>
    stateText && new RegExp(`override`, 'i').test(stateText) &&
    new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(stateText);

  // 1. every Road has a legal Status
  for (const r of roads) {
    if (!r.status) err(r.file, 'Road has no Status: line');
    else if (!r.status.legal)
      err(r.file, `illegal Status "${r.status.raw}" (want QUEUED / ACTIVE / DONE + superseded by <memory>)`);
  }

  // 2. every Expected file exists on disk (DONE Roads exempt)
  for (const r of roads) {
    if (r.status && r.status.word === 'DONE') continue;
    for (const f of r.expected) {
      if (!existsSync(resolve(cwd, f))) err(r.file, `Expected file missing on disk: ${f}`);
    }
  }

  // 3. no ACTIVE Road with an unfinished Dep (unless STATE override)
  for (const r of roads) {
    if (!(r.status && r.status.word === 'ACTIVE')) continue;
    for (const d of r.deps) {
      const dep = roadById.get(d);
      const done = dep && dep.status && dep.status.word === 'DONE';
      if (!done && !overridden(r.id))
        err(r.file, `ACTIVE but Dep "${d}" is ${dep ? 'not DONE' : 'missing'} (no STATE override)`);
    }
  }

  // 4. parallel ACTIVE Roads have disjoint Expected files
  const owner = new Map();
  for (const r of roads) {
    if (!(r.status && r.status.word === 'ACTIVE')) continue;
    for (const f of r.expected) {
      const abs = resolve(cwd, f);
      if (owner.has(abs)) err(r.file, `ACTIVE Expected file "${f}" also owned by ${rel(owner.get(abs))}`);
      else owner.set(abs, r.file);
    }
  }

  // 5. STATE.md exists, has required fields, is <= ~350 words
  if (!stateText) err(statePath, 'STATE.md is missing');
  else {
    for (const field of ['Mode', 'Role', 'Active', 'Done', 'Next', 'Open questions', 'Updated']) {
      if (!new RegExp(field.replace(' ', '\\s*'), 'i').test(stateText))
        err(statePath, `STATE.md missing required field: ${field}`);
    }
    const wc = wordCount(stateText);
    if (wc > 350) warn(statePath, `STATE.md is ${wc} words (budget ~350) — trim it, move history to LOG.md`);
  }

  // 6. every Task's Road: pointer resolves to an existing Road file
  for (const t of taskFiles) {
    const m = read(t).match(/^\s*Road:\s*(.+)\s*$/im);
    if (!m) { warn(t, 'Task has no Road: pointer'); continue; }
    const target = m[1].replace(/`/g, '').trim().split(/\s+/)[0];
    const ok = existsSync(resolve(akrs, target)) || existsSync(resolve(cwd, target)) ||
      roadById.has(roadId(target));
    if (!ok) err(t, `Road: pointer does not resolve: ${target}`);
  }

  // 7. mirrored Road statuses in index tables agree with the canonical Status
  const indexFiles = allMd.filter((p) =>
    !roadFiles.includes(p) && !inDir(p, 'kernel') &&
    basename(p) !== 'STATE.md' && basename(p) !== 'LOG.md');
  const mismatches = []; // {file, lineIdx, want, gotWord}
  for (const f of indexFiles) {
    const lines = read(f).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes('|')) return;
      for (const r of roads) {
        if (!r.status) continue;
        const idRe = new RegExp(`\\b${r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (!idRe.test(line)) continue;
        const got = line.match(/\b(QUEUED|ACTIVE|DONE)\b/);
        if (got && got[1] !== r.status.word) {
          err(f, `line ${i + 1}: mirrored status "${got[1]}" for ${r.id} disagrees with canonical "${r.status.word}"`);
          mismatches.push({ file: f, lineIdx: i, want: r.status.word, gotWord: got[1] });
        }
      }
    });
  }

  // 8. every source file named in SOT-INDEX exists
  const sotIndex = join(akrs, 'SOT-INDEX.md');
  if (existsSync(sotIndex)) {
    for (const line of read(sotIndex).split(/\r?\n/)) {
      if (!line.includes('·')) continue;
      // FW-7(b): skip the legend/header/table rows — only real source rows name a file.
      if (/^\s*(#|Format\s*:|\|)/i.test(line)) continue;
      let src = line.split('·')[0].replace(/[`*\-]/g, '').trim();
      if (!src) continue;
      const filePart = src.replace(/:\d+(-\d+)?$/, '');
      if (/\s/.test(filePart)) continue;          // a bare source path has no spaces (FW-7)
      const isDir = filePart.endsWith('/');
      const target = resolve(cwd, filePart);
      if (!existsSync(target)) err(sotIndex, `SOT-INDEX names a ${isDir ? 'directory' : 'source'} that does not exist: ${filePart}`);
    }
  }

  // 9. kernel/ shape + budget
  const kernelDir = join(akrs, 'kernel');
  if (existsSync(kernelDir)) {
    const coreP = join(kernelDir, 'CORE.md');
    if (!existsSync(coreP)) err(coreP, 'kernel/CORE.md is missing');
    if (!existsSync(join(kernelDir, 'worker.md')) && !existsSync(join(kernelDir, 'leader.md')))
      err(kernelDir, 'kernel/ has neither worker.md nor leader.md');
    if (existsSync(coreP)) {
      const coreW = wordCount(read(coreP));
      const roleFiles = listFiles(kernelDir, (p) => isMd(p) && basename(p) !== 'CORE.md');
      const largest = roleFiles.reduce((mx, p) => Math.max(mx, wordCount(read(p))), 0);
      if (coreW + largest > 350)
        warn(kernelDir, `CORE (${coreW}) + largest role (${largest}) = ${coreW + largest} words > ~350 budget`);
    }
  }

  // 10. BLOCKED.md present -> loud warning
  const blocked = join(akrs, 'BLOCKED.md');
  if (existsSync(blocked)) warn(blocked, 'BLOCKED.md exists — work is stalled; resolve it, log one line, then delete it');

  // 10b. tester-memory topic files are ephemeral (D14) -> surface so they don't persist
  for (const tm of listFiles(join(akrs, 'memory', 'tester'), isMd))
    warn(tm, 'tester-memory topic present — ephemeral; delete it once the pattern is fixed');

  // 11. stale handoff (its Plan has landed)
  const staleHandoffs = [];
  for (const h of listFiles(join(akrs, 'verify'), (p) => /-handoff\.md$/i.test(p))) {
    const plan = basename(h).replace(/-handoff\.md$/i, '');
    const planRe = new RegExp(plan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const inFeatures = featuresText && planRe.test(featuresText);
    const planRoads = roads.filter((r) => planRe.test(r.id));
    const allDone = planRoads.length > 0 && planRoads.every((r) => r.status && r.status.word === 'DONE');
    if (inFeatures || allDone) { warn(h, 'handoff is stale — its Plan has landed; delete it (or `--clean`)'); staleHandoffs.push(h); }
  }

  // 12. stale change file (its feature already in FEATURES.md)
  const staleChanges = [];
  for (const c of listFiles(join(akrs, 'changes'), isMd)) {
    const text = read(c);
    const nm = text.match(/#\s*change:\s*([^\n(]+)/i) || text.match(/name:\s*([^\n]+)/i);
    const name = nm ? nm[1].trim() : roadId(c);
    if (featuresText && new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(featuresText)) {
      warn(c, `change file is stale — "${name}" already appears in FEATURES.md; delete it (or \`--clean\`)`);
      staleChanges.push(c);
    }
  }

  // 13. Memory seam entries resolve to an existing Road OR name a Plan/Phase
  for (const mfile of memoryFiles) {
    read(mfile).split(/\r?\n/).forEach((line, i) => {
      if (!/\bseam\b/i.test(line)) return;
      const roadRef = line.match(/([\w./-]*roads\/[\w.-]+\.md)/i);
      if (roadRef) {
        if (!existsSync(resolve(akrs, roadRef[1].replace(/^.*roads\//, 'roads/'))) &&
            !roadById.has(roadId(roadRef[1])))
          err(mfile, `line ${i + 1}: seam names a Road that does not exist: ${roadRef[1]}`);
      } else if (!/\b(Plan|Phase|QUEUED)\b/.test(line)) {
        err(mfile, `line ${i + 1}: seam has no named owner (a Road, or a Plan/Phase)`);
      }
    });
  }

  // 14. FEATURES.md lines point at existing Roads/Memories
  if (featuresText) {
    featuresText.split(/\r?\n/).forEach((line, i) => {
      const refs = line.match(/\b(roads|memory)\/[\w.-]+\.md/gi) || [];
      for (const ref of refs) {
        if (!existsSync(resolve(akrs, ref)) && !roadById.has(roadId(ref)))
          err(featuresPath, `line ${i + 1}: references a file that does not exist: ${ref}`);
      }
    });
  }

  // 15. STATE parks no unasked owner/developer decision (FW-5) — ask it the same turn (04 §2.6)
  if (stateText) {
    stateText.split(/\r?\n/).forEach((line, i) => {
      if (/\b(pending|awaiting|await)\b/i.test(line) && /\b(owner|developer|decision)\b/i.test(line))
        warn(statePath, `line ${i + 1}: an owner decision looks parked in STATE ("${line.trim().slice(0, 50)}…") — ` +
          `ask it in-chat the same turn; STATE records only the answer (04 §2.6)`);
    });
  }

  // 16 + 17. LOG ledger: entry-length lint (FW-3) and rotation threshold (FW-2)
  if (existsSync(logPath)) {
    const logText = read(logPath);
    const logLines = logText.split(/\r?\n/);
    // 16. a one-line ledger entry over ~40 words (only the post-doctrine bare-date format;
    // the optional `deviations:` line is a separate line and is exempt).
    logLines.forEach((line, i) => {
      if (!/^\s*\d{4}-\d{2}-\d{2}\s*·/.test(line)) return;
      const n = wordCount(line);
      if (n > 40)
        warn(logPath, `line ${i + 1}: ledger entry is ${n} words (~40 max) — one line per close-out, no narrative`);
    });
    // 17. rotation threshold — 200 entries or 16 KB. Count both old (## date) and ledger entries.
    const entries = logLines.filter((l) => /^\s*(##\s|\d{4}-\d{2}-\d{2})/.test(l)).length;
    const bytes = Buffer.byteLength(logText, 'utf8');
    if (entries > 200 || bytes > 16 * 1024) {
      logOverThreshold = true;
      warn(logPath, `LOG.md is ${entries} entries / ${(bytes / 1024).toFixed(1)} KB — over the rotation ` +
        `threshold (200 entries / 16 KB); run \`validate --fix\` to archive it`);
    }
  }

  // --- fixes ---------------------------------------------------------------
  let fixed = 0;
  if (doFix && mismatches.length) {
    const byFile = new Map();
    for (const m of mismatches) {
      if (!byFile.has(m.file)) byFile.set(m.file, read(m.file).split(/\r?\n/));
      const lines = byFile.get(m.file);
      lines[m.lineIdx] = lines[m.lineIdx].replace(/\b(QUEUED|ACTIVE|DONE)\b/, m.want);
      fixed++;
    }
    for (const [f, lines] of byFile) writeFileSync(f, lines.join('\n'));
    // fixed mismatches are no longer errors
    for (const m of mismatches) {
      const idx = errors.findIndex((e) => e.includes(`line ${m.lineIdx + 1}`) && e.includes(rel(m.file)));
      if (idx >= 0) errors.splice(idx, 1);
    }
  }

  // FW-2: rotate an over-threshold ledger — the tool splits it so no agent ever counts entries.
  let rotated = 0;
  if (doFix && logOverThreshold) {
    let max = 0;
    for (const f of readdirSync(akrs)) {
      const mm = f.match(/^LOG-(\d+)\.md$/i);
      if (mm) max = Math.max(max, parseInt(mm[1], 10));
    }
    const archiveName = `LOG-${String(max + 1).padStart(3, '0')}.md`;
    try {
      renameSync(logPath, join(akrs, archiveName));   // rename = byte-identical archive
      writeFileSync(logPath,
        `# LOG  (ledger — append-only, one line per close-out, newest at the bottom)\n` +
        `Archived: ${archiveName} and earlier LOG-*.md — read-only; never rewritten.\n`);
      notes.push(`rotated LOG.md → ${rel(join(akrs, archiveName))} (fresh ledger started)`);
      rotated++;
      for (let i = warns.length - 1; i >= 0; i--)
        if (/over the rotation/.test(warns[i])) warns.splice(i, 1);
    } catch {}
  }

  let cleaned = 0;
  if (doClean) {
    for (const f of [...staleHandoffs, ...staleChanges]) {
      try { rmSync(f); notes.push(`deleted stale ${rel(f)}`); cleaned++; } catch {}
    }
    // drop the warnings we just resolved
    for (let i = warns.length - 1; i >= 0; i--) {
      if (/handoff is stale|change file is stale/.test(warns[i])) warns.splice(i, 1);
    }
  }

  // --- report --------------------------------------------------------------
  const out = process.stdout;
  for (const e of errors) out.write(`  ✖ ${e}\n`);
  for (const w of warns) out.write(`  ⚠ ${w}\n`);
  for (const n of notes) out.write(`  🧹 ${n}\n`);
  if (doFix) out.write(`\nFixed ${fixed} mirrored status${fixed === 1 ? '' : 'es'}.\n`);
  if (doFix && rotated) out.write(`Rotated the LOG ledger into ${rotated} archive${rotated === 1 ? '' : 's'}.\n`);
  if (doClean) out.write(`Cleaned ${cleaned} stale artifact${cleaned === 1 ? '' : 's'}.\n`);

  const ok = errors.length === 0;
  out.write(`\n${ok ? '✅' : '❌'} ${rel(akrs)}: ${errors.length} error${errors.length === 1 ? '' : 's'}, ` +
    `${warns.length} warning${warns.length === 1 ? '' : 's'}.\n`);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// dispatch (after all declarations, so const helpers are initialized)
// ---------------------------------------------------------------------------
if (command === 'validate') {
  process.exit(runValidate());
} else if (command === 'init') {
  runInit();
} else {
  process.stdout.write(HELP);
  process.exit(command ? 1 : 0);
}
