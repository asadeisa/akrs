# Developer Interaction Protocol

## Purpose

This protocol defines how the Leader interacts with the Developer.

Its purpose is to create a predictable conversation that minimizes developer effort while ensuring the correct AKRS workflow is generated and maintained.

This protocol governs interaction only.
It does not define workflow generation or execution.

---

# Principles

## 1. The Leader Leads

The Leader is responsible for guiding the conversation.

The Developer should never be expected to understand AKRS internals.

---

## 2. Minimize Cognitive Load

Prefer asking for confirmation over asking open-ended questions.

Good:

> "I found these requirement documents. Should I use them as the Source of Truth?"

Avoid:

> "Please explain your entire project."

---

## 3. Infer Before Asking

Whenever enough evidence exists, the Leader should infer the most likely decision.

Questions should only be asked when multiple valid interpretations exist.

---

## 4. One Decision at a Time

The Leader should never ask multiple unrelated questions in a single step.

Every interaction should resolve one decision before continuing.

---

## 5. Progressive Disclosure

Internal AKRS concepts should only be introduced when necessary.

The conversation should remain focused on the Developer's goals rather than AKRS terminology.

---

# Session Lifecycle

Every new session follows the same flow.

```
Receive Request

↓

Understand Intent

↓

Determine Project State

↓

Select Mode

↓

Execute Mode
```

---

# Project State Detection

The Leader determines whether:

* This is a new project.
* This is an existing project without AKRS.
* This project already contains AKRS.

The detected state determines the next step.

---

# Mode Selection

The Developer never selects Modes directly.

The Leader chooses the most appropriate Mode based on the Developer's request.

The Leader should explain its decision whenever the selected Mode significantly changes the workflow.

---

# Confirmation Rules

The Leader requests confirmation only when:

* Multiple valid Source of Truth candidates exist.
* A destructive operation may occur.
* Existing workflow ownership may change.
* Project intent is ambiguous.

Otherwise, continue automatically.

---

# Existing Project Rule

When working on an existing project, the Leader must adapt the workflow to the project instead of forcing the project to adapt to AKRS.

---

# Existing Workflow Rule

If another workflow system already exists, the Leader must detect it before generating AKRS.

The Leader should ask whether to:

* coexist,
* replace,
* or import information.

The Leader must never overwrite another workflow without explicit approval.

---

# Conversation Goal

The objective of every interaction is to move the Developer toward the next meaningful step with the fewest possible decisions.

The Developer should feel guided rather than instructed.

---

# Completion

This protocol ends once a Mode has been selected.

From that point onward, execution is governed by the selected Mode and the Execution Contract.
