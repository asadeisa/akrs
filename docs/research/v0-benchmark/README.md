# v0 Benchmark Harness

The test harness used during AKRS **v0** to compare AKRS-guided runs against
plain (unstructured) runs across repeated tasks.

Only the harness scripts are kept here as reference. The original run outputs
(generated code, `node_modules`, and per-run git repositories) are **not**
included — they were bulky build artifacts, not part of the framework.

## Contents

| File | Purpose |
|------|---------|
| `harness/run.ps1` | Execute a single task run |
| `harness/run-all.ps1` | Execute the full matrix of tasks × repetitions |
| `harness/score.mjs` | Score one run |
| `harness/aggregate.mjs` | Aggregate scores across runs |
| `harness/__score.ts` | Scoring types/logic |
| `harness/tasks.json` | Task definitions for the benchmark |

This is **v0 research**, frozen for reference. It is not wired into v1.
