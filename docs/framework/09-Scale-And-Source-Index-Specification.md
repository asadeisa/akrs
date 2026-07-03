# AKRS Scale & Source-Index Specification (v1.2)

### How AKRS stays minimal-read when the Source of Truth is large, or the project already exists

This is a **new v1.2 capability** and the most important one. It closes the framework's
oldest silent assumption: that the Source of Truth (SoT) is small enough to read whole. It
owns exactly one question:

> How does AKRS stay minimal-read when the Source of Truth is large, or the project already
> exists?

The guarantee it adds is absolute: **no agent — the Leader included — ever reads the whole
SoT.** Read exactly what is needed, exactly when it is needed. This document is authority for
scale mechanics; other docs point here and never restate its content.

---

## 1. The problem

v1 silently assumes the SoT is small enough to read whole. When the SoT is large — a
multi-hundred-line requirements doc, a design corpus, or an **existing repository** that *is*
the SoT — every layer inherits the overload the framework exists to prevent. A Leader that
reads a 40-page spec to plan one Task has already lost; a Worker handed "read `data.md`" when
`data.md` is 2,000 lines is back to scanning.

The root cause (developer decision D2): agents must never read a large SoT, or an existing
repo, *as-is*. The fix is not a bigger context window; it is **navigation into the SoT**, the
same discipline AKRS already applies to code.

---

## 2. The SoT Index (`akrs/SOT-INDEX.md`)

Built once in **Phase A**, by the Leader, whenever the SoT exceeds **~2 pages** OR the
project already exists. One line per section of the source:

```
<source-file> · <section/heading or line-range> · <one-line purpose> · <owning domain>
```

Example:

```
docs/data.md · §4.2 · puzzle rules & win condition · gameplay
docs/data.md · §6   · performance techniques & budgets · rendering
src/engine/  · loop.js:1-80 · frame loop + dt clamp · rendering
```

The index is the **single navigation owner of the SoT**: once it exists, Router / Memory /
Roads cite index entries (e.g. `data.md §4.2 — puzzle rules`), never "read `data.md`". If
several large sources exist, one index file per source lives under `akrs/sot/`, and
`SOT-INDEX.md` is the **root** that lists them.

The index is a **Memory-class artifact**: it points, never teaches. It carries no
requirements text, no implementation, no design rationale — only *where each thing lives*.

---

## 3. Read windows

A Road's *read order* names **file + section/anchor — a window** — never a whole file,
whenever the target exceeds **~1 page**. This applies to source code, docs, and the SoT
alike. The Worker opens only the window. Read windows are the per-Road enforcement of D2:

```
Read order:
1. akrs/memory/rendering.md            (index — whole, it is small)
2. docs/data.md §6                     (window: performance budgets only)
3. src/engine/loop.js:1-80             (window: the frame loop only)
```

A Road that says "read `src/engine/`" when the directory is large is a **routing defect** —
the same class of defect as a stale Road. Windows keep even a cheap Worker from drowning.

---

## 4. Progressive analysis (Phase A for large / existing projects)

The Leader never holds the whole SoT at once. For a large or pre-existing project, Phase A
analysis runs in bounded passes:

```
Pass 1 — Structure only        (headings / TOC / directory tree — no bodies)
  ↓
Partition into domains         (§5)
  ↓
Deep-dive ONE domain           (emit that domain's index entries, Memory, Plans)
  ↓
Repeat per domain              (one domain at a time — never all at once)
```

Analysis depth is bounded **per pass**, not per project. The Leader emits a domain's index
entries, Memory, and Plans **before** opening the next domain, so its working set stays small
no matter how large the project is. This is the Leader-side mirror of the Worker's read
windows.

---

## 5. Domain partitioning (D3)

When the SoT is large and serves different purposes, the workflow may shard:

- `akrs/plans/<domain>/` — plans per domain.
- `akrs/memory/<domain>/` — memory per domain.
- optional per-domain section in the Router.

A **global layer** holds the original thoughts:

- **`akrs/memory/GLOBAL.md`** — project intent, cross-domain contracts, and **one line per
  domain pointing down**. It is short and very important, or it does not exist at all. It
  never holds domain detail — only the intent and the pointers.

**Depth-on-demand.** Knowledge deepens as the agent descends: `GLOBAL → domain → Road`. Each
level down adds detail; a Worker descends only as far as its Road directs. This is how an
agent "increases its knowledge as it goes deeper into the task" without ever loading the
whole tree.

**Ownership stays single.** A fact lives in exactly one domain memory; `GLOBAL.md` only
points. A fact duplicated between GLOBAL and a domain, or across two domains, is a
single-owner violation.

---

## 6. Thresholds (guidance, not gates)

- **Index** when the SoT is **> ~2 pages**, or the project **pre-exists**.
- **Partition** when the SoT serves **2+ unrelated capabilities**.
- **Small project → none of this applies.** The v1 flat layout (`akrs/plans/`,
  `akrs/memory/`, one SoT read whole) is unchanged and remains the **default**. Do not index
  a one-page spec; do not shard a single-purpose project. Scale to the work, never past it.

---

## 7. Relationship to other documents

- Generation builds `SOT-INDEX.md` in Phase A when the SoT is large or the project pre-exists
  (`02-Generation-Specification.md §1, §3`).
- Boot routes all SoT reads through the index when it exists
  (`06-Runtime-Boot-Protocol.md §6`).
- Applicability of scale structure is flagged in `01-Constitution.md §12`.
- The Kernel carries the `SOT-INDEX.md` pointer and the windows-only rule
  (`08-Kernel-Specification.md`).
