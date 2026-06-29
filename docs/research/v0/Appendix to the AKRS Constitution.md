# AKRS Workflow Generation Specification

### Official Appendix to the AKRS Constitution

Version: Draft 1

---

# Purpose

This document complements the AKRS Constitution.

The Constitution defines the philosophy and architectural principles.

This document defines how a Leader generates an AKRS workflow from those principles.

It is the executable specification for workflow generation.

If the Constitution defines **what AKRS is**,

this document defines **how AKRS is created**.

---

# Relationship to the Constitution

The Constitution always has higher authority.

If this specification appears to contradict the Constitution,

the Constitution wins.

This document only specifies generation behavior.

It never changes architectural principles.

---

# Objective

Every competent Leader should generate substantially equivalent workflows when given the same project.

Differences in naming are acceptable.

Differences in architecture are not.

The objective is deterministic workflow generation.

---

# Source of Truth

Before analyzing a project, the Leader must identify all available knowledge sources.

Possible sources include:

• Customer requirements

• Product documentation

• Architecture documents

• Existing workflow

• Repository

• Developer explanations

• Existing project documentation

The Leader must never assume that the repository alone represents the complete project.

The Leader must never assume which sources are authoritative.

---

# Source of Truth Confirmation

Before any analysis begins,

the Leader must explicitly confirm the Source of Truth with the Developer.

This confirmation is mandatory.

It is the first action of every workflow.

The Leader presents every candidate source it has found.

The Developer confirms which sources are authoritative.

The Developer confirms which files are the canonical source of truth.

Until this confirmation exists,

analysis must not begin.

A confirmed Source of Truth is a fact.

An unconfirmed Source of Truth is an assumption.

Assumptions never start a workflow.

---

# Knowledge Priority

When multiple sources disagree,

the Leader resolves conflicts using this priority.

Highest authority

↓

Customer requirements

↓

Developer clarification

↓

Architecture documentation

↓

Existing workflow

↓

Repository

↓

Generated assumptions

Lowest authority

Assumptions never override authoritative knowledge.

---

# Workflow Generation Algorithm

Generation happens in two separate phases.

Phase A — Initial Generation — builds the stable skeleton once.

Phase B — On-Demand Generation — builds a Task and its Road only when that work is requested.

These phases must never be merged.

---

## Phase A — Initial Generation (skeleton only)

Collect Sources

↓

Confirm Source of Truth   (mandatory — see Source of Truth Confirmation)

↓

Analyze Project

↓

Identify Business Capabilities

↓

Generate Plans

↓

Identify Deliverables

↓

Generate Phases

↓

Extract Shared Knowledge

↓

Generate Memory

↓

Generate Router

↓

Generate Dependency Memory

↓

Validate Skeleton

↓

Skeleton Complete

Phase A never generates Tasks.

Phase A never generates Roads.

The order should not be changed.

---

## Phase B — On-Demand Generation (per request)

A Task and its Road are generated only when that specific work is requested.

This is Mode 3.

Receive Request

↓

Select the owning Plan and Phase

↓

Identify the single Executable Objective

↓

Generate one Task

↓

Generate exactly one Road for that Task

↓

Validate the Task and its Road

↓

Hand to Worker

Tasks are never generated in advance.

Roads are never generated in advance.

Only the requested work is generated.

---

# Plan Discovery Rules

Plans represent business capabilities.

A Plan should answer:

"What capability does this part of the software provide?"

Plans should remain independent whenever possible.

A Plan should never exist simply because files are located inside the same folder.

Folder structure is not architecture.

Business capabilities are architecture.

---

# Phase Discovery Rules

Phases organize related work inside one Plan.

A Phase represents a milestone.

Phases do not represent implementation order unless explicitly required.

Phases should group work with shared objectives.

---

# Task Discovery Rules

Tasks represent executable objectives.

A Worker should be able to execute one Task without redesigning project architecture.

Tasks should remain small.

Tasks should reference knowledge.

Tasks should never duplicate knowledge.

Tasks are generated on demand.

A Task is created only when its work is actually requested.

Tasks must never be mass-generated during Initial Generation.

Pre-generated Tasks become stale the moment requirements change.

On-demand generation is what keeps the workflow able to absorb change.

---

# Memory Discovery Rules

Memory files exist only for reusable knowledge.

Knowledge should become Memory only if multiple Tasks may require it.

Single-use knowledge should remain inside the appropriate Task or Road.

Memory is always reusable.

---

# Router Generation Rules

The Router answers only one question.

Where should execution continue?

The Router must never explain:

• implementation

• architecture

• business logic

• design decisions

The Router only points.

---

# Road Generation Rules

Every Task must have exactly one execution Road.

A Road is the execution contract.

A Road defines:

• required knowledge

• required reading order

• execution boundaries

• expected change scope

Workers never choose a Road.

The Leader chooses the Road.

---

# File Creation Rule

Before creating a new file,

the Leader asks:

Can this knowledge evolve independently?

YES

↓

Create a dedicated owner.

NO

↓

Keep it inside the existing owner.

Creating unnecessary files increases navigation complexity.

---

# Ownership Rule

Every concept has exactly one owner.

Every owner has exactly one responsibility.

If knowledge already exists,

reference it.

Never duplicate it.

---

# Allowed Assumptions

Reasoning always requires assumptions.

Assumptions are allowed only when:

• sufficient evidence exists

• no authoritative source contradicts the assumption

Assumptions must never replace known facts.

Architecture must never be invented.

The Source of Truth is never a permitted assumption.

It must always be confirmed by the Developer before analysis begins.

---

# Unknown Knowledge Rule

If required information cannot be determined,

the Leader must never fabricate an answer.

Instead, mark it as Unknown.

Unknown knowledge remains unresolved until clarified.

Unknown facts must never become documented facts.

---

# Developer Clarification Rule

If Unknown knowledge prevents reliable workflow generation,

the Leader must stop and ask the Developer.

The Developer becomes the authoritative source for that decision.

After clarification,

the Leader continues generation using the Developer's answer.

The Leader must always prefer asking over guessing.

---

# Confidence Rule

The Leader should internally evaluate confidence while analyzing the project.

Confidence levels are:

High

Medium

Low

Unknown

Low confidence should trigger additional verification.

Unknown confidence should trigger Developer clarification.

---

# Determinism Principle

The same project should produce substantially equivalent workflows.

Equivalent workflows may differ in:

• file names

• wording

• formatting

Equivalent workflows must not differ in:

• ownership

• routing

• planning structure

• execution architecture

---

# Workflow Output Contract

A generated workflow must contain:

• routing

• memory

• plans

• phases

• tasks

• roads

• validation

The concrete filenames may differ.

The responsibilities may not.

---

# Quality Targets

The Leader should maximize:

• execution predictability

• routing precision

• ownership uniqueness

• navigation consistency

• reusable knowledge

The Leader should minimize:

• duplicated knowledge

• unnecessary files

• unnecessary routing

• execution ambiguity

• blind assumptions

---

# Workflow Validation Rules

A workflow is complete only if all answers are YES.

• Every concept has one owner.

• Every Task belongs to one Phase.

• Every Phase belongs to one Plan.

• Every Task has one Road.

• Every Road has clear execution boundaries.

• Every Memory contains reusable knowledge only.

• Every Router contains routing only.

• No duplicated knowledge exists.

• No unresolved Unknown knowledge remains.

• Every assumption is justified.

• Every required clarification has been resolved.

If any answer is NO,

the workflow is incomplete.

---

# Failure Conditions

The generation process has failed if:

• the Leader invents architecture

• assumptions replace facts

• duplicate ownership appears

• routing becomes ambiguous

• multiple Roads exist for one Task

• Memory becomes documentation

• Router becomes documentation

• unresolved Unknown knowledge is silently ignored

When failure occurs,

generation must stop until corrected.

---

# Final Principle

The Constitution defines the philosophy.

This specification defines the generation process.

When uncertainty exists,

the Leader must prefer:

Evidence over assumptions.

References over duplication.

Questions over guessing.

Execution over documentation.

Deterministic architecture over creative interpretation.
