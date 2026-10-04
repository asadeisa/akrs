// The class-limit hook shared by road new and road update: findings for the proposed Road, never a blocked write
// (except the refused oversize_reason). The dependency depth is reported by road fit only (it is no knob).
import { CLASS_FINDING_CODES } from './policy.js';
import { evaluateFit, readTokensOf } from './fit.js';
import { resolveProfile } from './profiles.js';
import { readExecutors } from './repository.js';

// -> { findings: [], refusal: finding|null }
export async function classFitCheck({ repositoryRoot, workflowRoot, document, file = null }) {
  const executors = await readExecutors({ repositoryRoot, workflowRoot });
  const findings = [];
  let refusal = null;
  const reason = document.oversize_reason ?? null;
  if (reason !== null && (executors.leader_class === 'weak' || executors.leader_class === 'medium')) {
    refusal = {
      code: CLASS_FINDING_CODES.oversize,
      severity: 'error',
      message: `oversize_reason is refused: the Leader executor is classified ${executors.leader_class}; split the Road instead (at /oversize_reason).`,
      file,
      line: null,
      detail: { road: document.id, reason: 'oversize_leader_class', class: executors.leader_class },
    };
  }
  const cls = document.executor_class ?? null;
  if (cls === null) return { findings, refusal };
  const profile = resolveProfile(cls, executors.class_overrides);
  const reads = await readTokensOf({ repositoryRoot, workflowRoot, road: document });
  const evaluated = evaluateFit({ road: document, profile, read_tokens: reads.reduce((sum, { tokens }) => sum + tokens, 0), depth: 0 });
  for (const violation of evaluated.violations) {
    findings.push({
      code: CLASS_FINDING_CODES.fit,
      severity: reason === null ? 'error' : 'warning',
      message: `The Road does not fit the ${cls} class: ${violation.knob} is ${violation.actual} (limit ${violation.limit})${reason === null ? '; split it or state an oversize_reason' : ` — oversize_reason declared: ${reason}`}.`,
      file,
      line: null,
      detail: { road: document.id, class: cls, knob: violation.knob, limit: violation.limit, actual: violation.actual, oversize: reason !== null },
    });
  }
  return { findings, refusal };
}
