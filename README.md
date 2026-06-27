# AKRS — Adaptive Knowledge Routing System

> Deliver the smallest correct knowledge, to the correct agent, at the correct moment.

---

## What AKRS Is

AKRS is a **knowledge-routing architecture** for AI agents.

It is not a framework. It is not a memory system. It is not a documentation tool.

Its single purpose is to reduce the decision space an AI agent faces before reasoning begins — so that even small, inexpensive execution models can perform reliable software engineering work.

---

## The Core Idea

Large software projects create three problems for AI agents:

- Too much context
- Too many possible files
- Too many possible solutions

Large models often survive this. Small execution models usually do not.

AKRS solves this by transforming **many possible answers** into **one obvious execution path** — before execution begins.

---

## How It Works

AKRS separates two jobs that should never mix:

| Role | Job |
|------|-----|
| **Leader** | Understands the project. Plans once. Creates the workflow. |
| **Worker** | Follows prepared routes. Executes. Never redesigns. |

The Leader generates a workflow — a set of structured files that route the Worker through **only the knowledge required for the current task**. Nothing more.

Every execution follows one path:

```
Prompt → Mode Selection → Router → Memory → Road → Execution
```

Each layer answers exactly one question:

- **Router** → Where should I go next?
- **Memory** → Which knowledge do I need?
- **Road** → Exactly what should I read?
- **Task** → Exactly what should I build?

---

## Core Principles

- Knowledge has exactly **one owner**. Everything else references it.
- Knowledge is **never duplicated**.
- Knowledge is **only loaded when required**.
- Every file answers **one purpose**. If it solves two, split it.
- Planning and execution are **different jobs**. They never share the same path.

---

## Current Status

**Version 0 — Specification Phase**

This is a markdown-based workflow specification. The architecture is defined; the tooling is not yet built.

Roadmap (in order):

1. Markdown workflow spec ← *we are here*
2. CLI generation
3. Automatic validation
4. MCP enforcement

The architecture remains stable. Only implementation evolves.

---

## Repository Structure

```
akrs/
├── README.md              ← this file
├── LICENSE
├── docs/
│   ├── Constitution.md              ← core philosophy and architecture rules
│   ├── Execution-Contract.md        ← rules that govern Worker agents
│   ├── Appendix to the AKRS Constitution.md   ← how a Leader generates a workflow
│   └── AKRS-Implementation-File-Map.md        ← full file tree for an example project
```

---

## License

MIT — see [LICENSE](LICENSE)
