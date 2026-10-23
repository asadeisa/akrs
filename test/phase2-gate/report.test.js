// P2-W11: the release gate report names its evidence, and the names stay true. Every test file it cites exists, every gate row carries a
// result, the dogfood status is stated as it is (the MCP arm is not claimed as passed) and the public report carries no local-only material.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const report = await readFile(new URL('../../docs/validation/v2.0.0-release-gate.md', import.meta.url), 'utf8');
const cited = [...new Set([...report.matchAll(/`((?:test|\.github)\/[A-Za-z0-9_./-]+)`/g)].map((match) => match[1]))];

test('every test file the gate report cites exists', async () => {
  assert.ok(cited.length >= 40, `the report cites ${cited.length} files`);
  for (const path of cited) {
    if (path.endsWith('/')) continue;
    await assert.doesNotReject(access(`${REPOSITORY}${path}`), `${path} is cited but missing`);
  }
});

test('every gate row has a result and every automated gate passes', () => {
  const rows = report.split('\n').filter((line) => line.startsWith('| ') && !/^\| (?:#|Gate|Check|Requirement|Item|Area) /.test(line));
  assert.ok(rows.length >= 20, `${rows.length} gate rows were found`);
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    assert.ok(/Pass|Passed|Waived|deferred/i.test(cells.at(-1)), `a gate row has no result: ${row.slice(0, 80)}`);
  }
});

test('the owner dogfood status is stated honestly: CLI arm passed, frontier waived, MCP arm deferred and never claimed as passed', () => {
  assert.match(report, /CLI arm, weak executor[^\n]*passed/);
  assert.match(report, /Frontier executor: waived/);
  assert.match(report, /MCP arm: not run\.\*\* It is deferred until after the v2\.0\.0 release/);
  assert.match(report, /It is \*\*not\*\* claimed as passed/);
  for (const line of report.split('\n')) {
    const at = line.indexOf('MCP arm');
    if (at === -1) continue;
    const after = line.slice(at).replace(/not(?:\*\*)? claimed as passed/g, '');
    assert.equal(/\bpassed\b/i.test(after), false, `a line claims the MCP arm passed: ${line.slice(0, 100)}`);
  }
});

test('the public report carries no local-only planning material', () => {
  for (const forbidden of ['plans/', 'EXECUTION-STATE', 'TRACEABILITY', 'AMENDMENT', 'DOGFOOD-2026']) {
    assert.equal(report.includes(forbidden), false, `the report mentions ${forbidden}`);
  }
});
