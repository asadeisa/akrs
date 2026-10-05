// P2-W12: the closed data schemas of the intent packets. Real packets validate; an unknown key, a missing key, a value outside its closed
// vocabulary and an embedded Worker packet that names another Road are each refused, with the path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INTENT_VALIDATORS, validateBoot, validateDone, validateDoneBlocked, validateGuardCheck, validateWork, validateWorkBlocked, validateYield, validateYieldBlocked,
} from '../../lib/schemas/intents.js';
import { FAILING, ROAD, done, edit, intent, work, workWorld } from './support.js';

const clone = (value) => structuredClone(value);
const refused = (validator, value, path, code) => {
  const result = validator(value);
  assert.equal(result.ok, false, `${path} should be refused`);
  assert.ok(result.issues.some((issue) => issue.path === path && (code === undefined || issue.code === code)), `${path}: ${JSON.stringify(result.issues)}`);
};

test('the validators are registered by data kind', () => {
  assert.deepEqual(Object.keys(INTENT_VALIDATORS).sort(), ['boot', 'done', 'done_blocked', 'guard', 'work', 'work_blocked', 'yield', 'yield_blocked']);
});

test('real packets validate and mutilated ones are refused with the path', async (t) => {
  const { repo } = await workWorld(t, { checks: [FAILING] });
  const claimed = (await work(repo)).packet.data;
  assert.equal(validateWork(claimed).ok, true);
  refused(validateWork, { ...clone(claimed), surprise: 1 }, '$.surprise', 'unknown_key');
  const noClaim = clone(claimed);
  delete noClaim.claim;
  refused(validateWork, noClaim, '$.claim', 'missing_key');
  refused(validateWork, { ...clone(claimed), claim: { action: 'stolen', previous_holder: null } }, '$.claim.action');
  refused(validateWork, { ...clone(claimed), executor: { id: 'flash', class: 'godlike', source: 'flag' } }, '$.executor.class');
  refused(validateWork, { ...clone(claimed), road: 'R-OTHER' }, '$.details.road.id', 'invalid_value');
  refused(validateWork, { ...clone(claimed), packet_version: 'akrs.work/v2' }, '$.packet_version');

  const blockedWork = (await intent(repo, ['work', '--executor', 'flash2'])).packet.data;
  assert.equal(validateWorkBlocked(blockedWork).ok, true);
  refused(validateWorkBlocked, { ...clone(blockedWork), candidates: [{ road: 'R-1', reason: 'x' }] }, '$.candidates[0].subject', 'missing_key');

  await edit(repo);
  const refusedDone = (await done(repo)).packet.data;
  assert.equal(validateDoneBlocked(refusedDone).ok, true, JSON.stringify(validateDoneBlocked(refusedDone).issues));
  refused(validateDoneBlocked, { ...clone(refusedDone), attempts: { failures: -1, limit: 2 } }, '$.attempts.failures');
  refused(validateDoneBlocked, { ...clone(refusedDone), blockers: [{ reason: 'x', subject: null }] }, '$.blockers[0].fix', 'missing_key');

  const yielded = (await intent(repo, ['yield', ROAD, '--executor', 'flash', '--reason', 'too big'])).packet.data;
  assert.equal(validateYield(yielded).ok, true);
  refused(validateYield, { ...clone(yielded), needs_split: false }, '$.needs_split');
  refused(validateYield, { ...clone(yielded), lease: { holder: 'flash', released: 'yes' } }, '$.lease.released');
  const noLease = (await intent(repo, ['yield', ROAD, '--executor', 'flash', '--reason', 'again'])).packet.data;
  assert.equal(validateYieldBlocked(noLease).ok, true);
  refused(validateYieldBlocked, { ...clone(noLease), holder: 'not an id' }, '$.holder');
});

test('a finished done validates through the finish schema plus its own keys only', async (t) => {
  const { repo } = await workWorld(t);
  assert.equal((await work(repo)).packet.status, 'ok');
  await edit(repo);
  const finished = (await done(repo)).packet.data;
  assert.equal(validateDone(finished).ok, true, JSON.stringify(validateDone(finished).issues));
  const noHandoff = clone(finished);
  delete noHandoff.handoff;
  refused(validateDone, noHandoff, '$.handoff');
  refused(validateDone, { ...clone(finished), holder: 7 }, '$.holder');
  refused(validateDone, { ...clone(finished), transition: 'activate' }, '$.closure', 'invalid_value');
  refused(validateDone, { ...clone(finished), kind: 'road_lifecycle' }, '$.kind');
});

test('boot and guard data are closed too', async (t) => {
  const { repo } = await workWorld(t);
  const boot = (await intent(repo, ['boot'])).packet.data;
  assert.equal(validateBoot(boot).ok, true);
  refused(validateBoot, { ...clone(boot), role: 'worker' }, '$.role');
  refused(validateBoot, { ...clone(boot), questions_for_user: [{ kind: 'trivia', subject: 'x', text: 'y' }] }, '$.questions_for_user[0].kind');
  refused(validateBoot, { ...clone(boot), kernel: { core: null } }, '$.kernel.leader', 'missing_key');
  const guard = (await intent(repo, ['guard', 'src/x.js', '--executor', 'flash'])).packet.data;
  assert.equal(validateGuardCheck(guard).ok, true);
  refused(validateGuardCheck, { ...clone(guard), decision: 'deny' }, '$.reason', undefined);
  refused(validateGuardCheck, { ...clone(guard), decision: 'maybe' }, '$.decision');
});
