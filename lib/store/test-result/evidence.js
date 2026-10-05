// Measures one evidence file of a Tester result (P2-W07, reused by the Plan close gate of P2-W08): a regular file, no link on
// the way, contained in the workflow. -> { bytes, sha256 } or null when the path names no such file.
import { sha256 } from '../transactions/files.js';
import { ChangeSetError, examine } from '../transactions/plan.js';

// `path` is the repository-relative path an evidence entry carries; `service` is the path service of the workflow.
export async function measureEvidence({ service, workflowRoot, path }) {
  const prefix = `${service.workflow_relative_path}/`;
  const relative = service.workflow_relative_path !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  try {
    const probe = await examine(workflowRoot, relative, 'evidence');
    if (probe.state.kind === 'file') return { bytes: probe.state.bytes.length, sha256: sha256(probe.state.bytes) };
  } catch (error) {
    if (!(error instanceof ChangeSetError)) throw error;
  }
  return null;
}
