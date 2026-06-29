# Runtime Boot Protocol

## Purpose

This protocol defines how an AI Agent initializes an AKRS session.

It ensures every supported platform enters the workflow through the same deterministic process before any planning or execution begins.

This protocol governs session initialization only.

---

# Principles

## 1. One Entry Point

Every session must start from the platform entry file (for example: `AGENTS.md`, `CLAUDE.md`, or another supported adapter).

The adapter is only an entry point.

It is never a Source of Truth.

---

## 2. AKRS Owns the Runtime

Once AKRS is activated, runtime navigation is controlled by AKRS.

Platform-specific default behaviors must not replace AKRS navigation.

---

## 3. Deterministic Startup

Every session follows the same initialization sequence regardless of platform.

The runtime should never skip initialization steps.

---

# Boot Sequence

Every session follows this order:

```text
Platform Entry

↓

Load Constitution

↓

Load Developer Interaction Protocol

↓

Detect Environment

↓

Detect Project State

↓

Select Mode

↓

Load Required Workflow Files

↓

Start Execution
```

---

# Environment Detection

The runtime identifies the current execution environment.

Examples include:

* ChatGPT Agent
* Claude Code
* Claude CLI
* Cursor
* Gemini CLI
* Custom Environment

The detected environment determines which platform adapter is used.

---

# Project Detection

Before execution begins, the runtime determines:

* Does an AKRS workflow already exist?
* Is this an existing project?
* Is another workflow system already present?

This decision is completed before Mode Selection.

---

# File Loading Rules

The runtime loads only the files required for the selected Mode.

It must never load the complete workflow unless explicitly required.

Navigation is performed through the Router.

Knowledge is discovered through Memory.

Execution is constrained by the active Road.

---

# Runtime Priority

During execution, priority is always:

```text
Road

↓

Memory

↓

Router

↓

Repository
```

Repository exploration should occur only when explicitly required by the active Road.

---

# Platform Independence

The runtime behavior must remain identical across all supported AI platforms.

Only the platform entry file may differ.

The AKRS workflow itself must remain platform independent.

---

# Failure Handling

If initialization cannot determine:

* project state,
* execution mode,
* or required sources,

execution must stop.

The Leader should request the minimum information required before continuing.

Execution must never continue under uncertainty.

---

# Completion

This protocol ends once the required workflow files have been loaded.

From that point onward, all behavior is governed by the selected Mode and the Execution Contract.
