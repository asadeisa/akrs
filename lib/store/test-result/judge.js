// The gates of `test result` (P2-W07), pure: facts in, reasons out. index.js reads the facts under the repository lock; nothing
// here touches the filesystem. Each reason is a member of RESULT_GUARD_REASONS (AKRS-T006).

const budgetMet = (measurement, value) => (measurement.direction === 'min' ? value >= measurement.budget : value <= measurement.budget);

// facts: {
//   verdict, document: { checks, measurements, evidence: [{ path, type }], findings, user_acceptance },
//   contract, packet: { blocked, blockers, checks: [{ name }], weak }, runnable,
//   lease: { state }, runs: { latest: { id, record }|null, current: boolean }, files: Map(path -> { bytes, sha256 } | null),
// }
// -> [{ reason, subject, pointer, message }] (empty when every gate holds)
export function judgeResult(facts) {
  const { verdict, document, contract, packet, runnable, lease, runs, files } = facts;
  const pass = verdict === 'pass';
  const found = [];
  const refuse = (reason, subject, pointer, message) => found.push({ reason, subject, pointer, message });

  // the Tester packet
  if (pass && packet.blocked) {
    refuse('packet_blocked', packet.blockers[0] ?? null, null, `The Tester packet is blocked (${packet.blockers.join(', ')}), so there is nothing to pass.`);
  }

  // the run and the lease
  if (runnable) {
    const { latest, current } = runs;
    if (pass) {
      if (latest === null) {
        refuse('run_missing', null, null, 'The contract has a scenario to run and no run exists: run `akrs test run` first.');
      } else {
        if (!current) refuse('run_stale', latest.id, null, `The latest run ${latest.id} belongs to another snapshot or contract than the one tested now: run the scenario again.`);
        else if (latest.record.status === 'failed') refuse('run_failed', latest.id, null, `The referenced run ${latest.id} has a failed hard step or budget, so it cannot support a pass.`);
        else if (latest.record.status === 'blocked') refuse('run_blocked', latest.id, null, `The referenced run ${latest.id} could not run in full, so it cannot support a pass.`);
        if (lease.state === 'stale') refuse('lease_stale', null, null, 'The Tester lease is over an older snapshot of the Plan: run the scenario again.');
        else if (lease.state !== 'fresh') refuse('lease_missing', null, null, 'The Tester lease created by `akrs test run` is gone or unreadable: run the scenario again.');
      }
    } else if (packet.weak && !current) {
      refuse('run_required', null, null, 'This Tester executor is weak: run `akrs test run` on the current snapshot before recording any result.');
    }
  }

  // checks
  const declared = new Set(packet.checks.map(({ name }) => name));
  document.checks.forEach((check, index) => {
    if (!declared.has(check.name)) refuse('check_undeclared', check.name, `/checks/${index}/name`, `No Road of the Plan declares the check ${check.name}.`);
  });
  if (pass) {
    document.checks.forEach((entry, index) => {
      if (entry.passed !== true) refuse('check_failed', entry.name, `/checks/${index}`, `The declared check ${entry.name} did not pass, so the verdict cannot be a pass.`);
    });
  }

  // measurements
  const slots = new Map(contract.measurements.map((measurement) => [measurement.name, measurement]));
  document.measurements.forEach((entry, index) => {
    const slot = slots.get(entry.name);
    const pointer = `/measurements/${index}`;
    if (slot === undefined) {
      refuse('measurement_undeclared', entry.name, `${pointer}/name`, `The contract declares no measurement ${entry.name}.`);
      return;
    }
    if (entry.unit !== slot.unit) refuse('measurement_inconsistent', entry.name, `${pointer}/unit`, `The measurement ${entry.name} is declared in ${slot.unit}, not ${entry.unit}.`);
    else if (entry.within_budget !== budgetMet(slot, entry.value)) {
      refuse('measurement_inconsistent', entry.name, `${pointer}/within_budget`, `The value ${entry.value} ${slot.unit} is ${budgetMet(slot, entry.value) ? 'within' : 'not within'} the declared ${slot.direction} budget of ${slot.budget} ${slot.unit}.`);
    } else if (pass && !budgetMet(slot, entry.value)) {
      refuse('measurement_over_budget', entry.name, `${pointer}/value`, `The measurement ${entry.name} (${entry.value} ${slot.unit}) is over the declared ${slot.direction} budget of ${slot.budget} ${slot.unit}, so the verdict cannot be a pass.`);
    }
  });
  if (pass) {
    for (const slot of contract.measurements) {
      if (!document.measurements.some((entry) => entry.name === slot.name)) refuse('measurement_missing', slot.name, '/measurements', `A pass needs the declared measurement ${slot.name}.`);
    }
  }

  // evidence
  document.evidence.forEach((entry, index) => {
    if (!contract.evidence_types.includes(entry.type)) {
      refuse('evidence_undeclared', entry.path, `/evidence/${index}/type`, `The contract declares no evidence of type ${entry.type}.`);
    } else if (files.get(entry.path) === null || files.get(entry.path) === undefined) {
      refuse('evidence_missing', entry.path, `/evidence/${index}/path`, `The evidence ${entry.path} is not a regular file.`);
    }
  });
  if (pass) {
    for (const type of contract.evidence_types) {
      if (!document.evidence.some((entry) => entry.type === type)) refuse('evidence_type_missing', type, '/evidence', `A pass needs evidence of the declared type ${type}.`);
    }
  }

  // findings and acceptance
  if (pass) {
    document.findings.forEach((entry, index) => {
      if (entry.status === 'open') refuse('finding_open', entry.id, `/findings/${index}`, `The finding ${entry.id} is still open, so the verdict cannot be a pass.`);
    });
  }
  const answer = document.user_acceptance.answer;
  if ((pass && answer !== 'yes') || (!pass && answer !== 'no')) {
    refuse('acceptance_contradicts', answer, '/user_acceptance/answer', `A ${verdict} result cannot carry the acceptance answer ${answer}.`);
  }
  return found;
}
