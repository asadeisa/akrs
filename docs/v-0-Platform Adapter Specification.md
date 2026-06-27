# Platform Adapter Specification

## Purpose

This specification defines how AKRS integrates with different AI platforms.

Platform Adapters provide a standardized entry point into AKRS without becoming part of the workflow itself.

Adapters improve compatibility while preserving a single Source of Truth.

---

# Principles

## 1. Adapters Are Not Knowledge

Platform Adapters must never contain project knowledge.

They must never duplicate:

* Requirements
* Architecture
* Memory
* Plans
* Tasks
* Roads

Their only responsibility is directing the Agent into AKRS.

---

## 2. One Workflow

Regardless of the platform, every adapter must activate the same AKRS workflow.

Changing platforms must never change workflow behavior.

---

## 3. Platform Independence

AKRS owns the workflow.

Platforms only provide different entry mechanisms.

The workflow must remain independent from any specific AI platform.

---

# Adapter Responsibilities

Every Platform Adapter is responsible for:

* Activating AKRS.
* Pointing the Agent to the correct startup sequence.
* Identifying the runtime environment.
* Preventing the Agent from bypassing AKRS initialization.

Nothing more.

---

# Supported Adapter Types

Examples include:

* `AGENTS.md`
* `CLAUDE.md`
* `GEMINI.md`
* `.cursor/rules`
* Other platform-specific entry files

Additional adapters may be added without modifying the AKRS architecture.

---

# Adapter Generation

Platform Adapters are generated after the AKRS workflow has been successfully created and validated.

Generation order:

```text
Generate Workflow

↓

Validate Workflow

↓

Generate Platform Adapters

↓

Workflow Ready
```

---

# Adapter Discovery

When entering an existing project, the Leader should detect available AI platform files.

Examples include:

* `AGENTS.md`
* `CLAUDE.md`
* `.cursor/`
* `.github/copilot-instructions.md`
* Other recognized platform files

The detected environment determines which adapters should be generated, updated, or preserved.

---

# Existing Adapter Rules

If an adapter already exists:

* The Leader must inspect it before modification.
* Existing instructions should be preserved whenever possible.
* Destructive replacement requires explicit Developer approval.

The Leader must never overwrite existing platform files without confirmation.

---

# Adapter Content

Adapters should remain minimal.

Typical responsibilities include:

* Identifying the project as an AKRS project.
* Directing the Agent to the Runtime Boot Protocol.
* Instructing the Agent to follow AKRS navigation.
* Preventing execution before initialization.

Adapters should avoid implementation details.

---

# Source of Truth

Platform Adapters are never considered a Source of Truth.

The authoritative workflow always remains inside the AKRS workflow structure.

Adapters are disposable.

The AKRS workflow is authoritative.

---

# Completion

Platform Adapters complete the integration between AKRS and the execution environment.

After an adapter activates AKRS, its responsibility ends.

All subsequent behavior is governed by the Runtime Boot Protocol and the active AKRS workflow.
