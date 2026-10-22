// Following the operation journal without the lock: committed operations in committed order. Committed operations never change, so each
// is parsed once; a file that is not committed yet (or torn) is looked at again on the next refresh. A journal that does not verify throws
// JournalCorruptError like every other reader.
import { compareStrings, isUlid } from '../schemas/common.js';
import { inspectOpsDirectory, listDirectory } from '../store/ops-files.js';
import { locateJournal, opsSegments, readOpFile } from '../store/journal/storage.js';

const summary = (op) => ({
  request_id: op.request_id,
  record_id: op.committed.id,
  ts: op.committed.ts,
  command: op.committed.command,
  road: op.committed.target.road,
  plan: op.committed.target.plan,
  changed: [...op.committed.changed],
  before: op.committed.before,
  after: op.committed.after,
});

export const byCommit = (left, right) => compareStrings(left.ts, right.ts)
  || compareStrings(left.record_id, right.record_id)
  || compareStrings(left.request_id, right.request_id);

export async function createOpTracker({ repositoryRoot, workflowRoot }) {
  const location = await locateJournal({ repositoryRoot, workflowRoot });
  const committed = new Map();
  return {
    // -> every committed operation known so far, in committed order
    async refresh() {
      const directory = await inspectOpsDirectory(location, opsSegments);
      const names = (await listDirectory(directory)).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)).filter(isUlid);
      for (const id of names) {
        if (committed.has(id)) continue;
        const op = await readOpFile(location, id);
        if (op !== null && op.committed !== null) committed.set(id, summary(op));
      }
      return [...committed.values()].sort(byCommit);
    },
  };
}
