// The health rows of `doctor` (P2-W09): one fact per check, sorted by check name. Read only; doctor never repairs.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DOCTRINE_TARGET, INSTALL_RECORD_NAME, RECOVERY_MARKER_NAME, validateInstallRecord } from '../doctrine-install.js';
import { readExecutors } from '../executors/index.js';
import { readLog } from '../log/repository.js';
import { listRoadFiles, RoadStoreError, readRoad } from '../roads/repository.js';
import { readState } from '../state/repository.js';

const row = (check, status, detail) => ({ check, status, detail });
const exists = async (path) => stat(path).then(() => true, () => false);

async function doctrineRow(repositoryRoot) {
  const record = join(repositoryRoot, DOCTRINE_TARGET, INSTALL_RECORD_NAME);
  if (await exists(join(repositoryRoot, DOCTRINE_TARGET, RECOVERY_MARKER_NAME))) return row('doctrine', 'warning', 'an interrupted doctrine install left a recovery marker: run sync');
  if (!(await exists(record))) return row('doctrine', 'not_applicable', 'no doctrine install record: the doctrine is not installed here');
  try {
    const verdict = validateInstallRecord(JSON.parse(await readFile(record, 'utf8')));
    return verdict.ok ? row('doctrine', 'ok', 'the install record verifies') : row('doctrine', 'error', `the install record is invalid at ${verdict.issues[0].path}`);
  } catch {
    return row('doctrine', 'error', 'the install record is not readable JSON');
  }
}

export async function buildHealth({ repositoryRoot, workflowRoot }) {
  const base = { repositoryRoot, workflowRoot };
  const rows = [];
  rows.push(await doctrineRow(repositoryRoot));

  const executors = await readExecutors(base);
  if (!executors.exists) rows.push(row('executors', 'not_applicable', 'no executors.json yet: the Leader classifies the executors with executor set'));
  else if (executors.meta_state !== 'declared') rows.push(row('executors', 'error', 'executors.json does not verify (hand-edited or invalid)'));
  else if (executors.unclassified) rows.push(row('executors', 'warning', 'executors.json has no leader and worker pair'));
  else rows.push(row('executors', 'ok', `${executors.executors.length} executor${executors.executors.length === 1 ? '' : 's'} classified`));

  const log = await readLog(base);
  const logProblems = log.issues.length + log.unverified.length;
  rows.push(logProblems === 0 ? row('log', log.records.length === 0 ? 'not_applicable' : 'ok', log.records.length === 0 ? 'the closure ledger is empty' : `${log.records.length} closure record${log.records.length === 1 ? '' : 's'} verify`) : row('log', 'error', `${logProblems} closure ledger problem${logProblems === 1 ? '' : 's'}: segment issues or records that do not verify`));

  const broken = [];
  let verified = 0;
  for (const { id } of await listRoadFiles(base)) {
    try {
      const found = await readRoad({ ...base, id });
      if (found !== null && found.meta_state === 'declared') verified += 1;
      else broken.push(id);
    } catch (error) {
      if (!(error instanceof RoadStoreError)) throw error;
      broken.push(id);
    }
  }
  rows.push(broken.length === 0 ? row('roads', 'ok', `${verified} Road${verified === 1 ? '' : 's'} verify`) : row('roads', 'error', `${broken.length} Road file${broken.length === 1 ? '' : 's'} do not verify: ${broken.sort().join(', ')}`));

  const state = await readState(base);
  if (!state.exists) rows.push(row('state', 'not_applicable', 'no state.json yet'));
  else rows.push(state.meta_state === 'declared' ? row('state', 'ok', 'state.json verifies') : row('state', 'error', 'state.json does not verify (hand-edited or invalid)'));

  rows.push(row('workflow', 'ok', 'the workflow root is present'));
  return rows.sort((left, right) => (left.check < right.check ? -1 : left.check > right.check ? 1 : 0));
}
