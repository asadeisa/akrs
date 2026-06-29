# AKRS Constitution

### The Official Specification for Workflow Generation

Version: Draft 2

---

# Purpose

This document defines the complete specification for generating an AKRS workflow.

It is **not** part of any software project.

It is **not** read by Worker agents.

Its purpose is to teach a Leader model how to analyze a project and generate a correct AKRS workflow.

Every generated workflow must follow this specification.

---

# What AKRS Is

AKRS exists to make AI agents execute real software tasks using the minimum required knowledge.

The objective is **not** reducing tokens.

The objective is reducing the agent's decision space before reasoning begins.

The smaller the decision space becomes, the more focused, predictable and reliable even small execution models become.

---

# Core Philosophy

Knowledge should never be duplicated.

Knowledge should never be loaded blindly.

Knowledge should only be discovered when required.

Every file answers one purpose.

Every layer answers one question.

Every piece of knowledge has exactly one owner.

Everything else references it.

---

# What AKRS Solves

Large software projects create three problems.

• Too much context.

• Too many possible files.

• Too many possible solutions.

Large models often survive this.

Small execution models usually do not.

AKRS reduces these possibilities before execution begins.

The goal is transforming

Many possible answers

into

One obvious execution path.

---

# Primary Goal

Allow an intelligent planning model to understand the project once.

Allow inexpensive execution models to execute repeatedly.

Leader models think.

Worker models execute.

---

# Architecture Principle

Planning and execution are different jobs.

Planning discovers.

Execution follows.

These are different navigation problems.

They should never use the same navigation path.

---

# Roles

## Leader

The Leader owns the workflow.

The Leader understands the project.

The Leader is responsible for:

• analyzing the project

• discovering architecture

• creating plans

• creating phases

• creating tasks

• creating memories

• creating Roads

• updating routing

• maintaining synchronization

The Leader is the only authority allowed to modify workflow architecture.

---

## Worker

The Worker never discovers project knowledge.

The Worker follows prepared routes.

The Worker executes.

The Worker does not redesign.

The Worker stays inside assigned scope.

---

# Execution Contract

The Leader is responsible for providing sufficient knowledge.

The Worker is responsible for executing only the provided scope.

If the current Road is sufficient,

↓

Execute.

If the Road is insufficient,

↓

Expand knowledge through the Router.

↓

Return to the Road.

↓

Continue execution.

The Worker never redesigns the Road.

The Leader owns planning.

The Worker owns execution.

---

# Decision Space

AKRS does not try to make models smarter.

AKRS removes unnecessary choices.

Every unnecessary file creates additional possibilities.

Every additional possibility increases reasoning complexity.

Reducing possibilities increases execution quality.

---

# Context Philosophy

More context is not always better.

Correct context is better.

Missing context is dangerous.

Unrelated context is also dangerous.

The objective is only the knowledge required for the current task.

---

# Navigation

Every execution follows one route.

Prompt

↓

Mode Selection

↓

Router

↓

Memory

↓

Road

↓

Execution

Workers never jump randomly between layers.

---

# Road

A Road is an execution contract.

It defines:

• what to read

• what not to read

• expected files

• execution scope

The Worker follows the Road.

The Worker never redesigns it.

---

# Router

The Router never explains anything.

It only answers:

> Where should I go next?

Nothing more.

---

# Memory

Memory files are indexes.

Not documentation.

Not specifications.

Not implementation.

They only point toward knowledge.

---

# Planning

Planning requires understanding.

Execution requires precision.

These responsibilities must remain separated.

---

# Execution

Execution always reads the smallest possible amount of information.

Everything outside the assigned Road is considered unnecessary unless proven otherwise.

---

# Developer Fast Path

Some developers already understand their projects.

The architecture should never force unnecessary navigation.

Mode 0 exists for these developers.

Mode 0 bypasses secondary routing.

Only:

• project memory

• required source files

are needed.

Nothing else.

---

# Mode Selection

Before routing begins,

the system selects an execution mode.

The mode is determined from:

• existing task

• prompt intent

• developer override

The selected mode determines the allowed navigation path.

---

# Execution Modes

Mode 0

Developer Fast Path

---

Mode 1

Quick local execution.

Small isolated changes.

---

Mode 2

Normal execution.

Existing task.

Existing Road.

---

Mode 3

Planning.

Creates new tasks.

Creates new Roads.

Generates Tasks and Roads on demand, one request at a time.

Never generates Tasks or Roads in advance.

Uses planning navigation.

---

Mode 4

Architecture.

Cross-plan changes.

Leader only.

---

# Existing Task

If a task already exists,

↓

Follow it.

Never redesign it.

---

# No Existing Task

Determine user intent.

↓

Select execution mode.

↓

Generate the required route.

---

# Blind Assumptions

Reasoning always contains assumptions.

The problem is not assumptions.

The problem is blind assumptions.

Blind assumptions occur when required knowledge exists but is missing from the current Road.

This is a routing failure.

Not a reasoning failure.

---

# Blind Assumption Check

Before execution begins,

the Worker asks one question.

> Can this task be completed using only the current Road?

YES

↓

Execute.

NO

↓

Router

↓

Required Memory

↓

Return to Road

↓

Continue execution.

The question is asked only once.

No recursive routing.

No execution reports.

---

# Scope

Workers execute.

Workers do not explore.

Workers do not redesign architecture.

Workers stay inside assigned scope.

---

# Simplicity Rule

Every file answers one purpose.

If a file begins solving multiple purposes,

split it.

---

# Routing Rule

Every layer answers only one question.

Router

↓

Where next?

Memory

↓

Which knowledge?

Road

↓

Exactly what should I read?

Task

↓

Exactly what should I build?

---

# Long-Term Vision

Today

Markdown workflow.

Later

CLI generation.

Later

Automatic validation.

Later

MCP enforcement.

The architecture remains stable.

Only implementation evolves.

---

# Leader Generation Rules

The Leader does not generate documentation.

The Leader generates navigation.

Every generated file must exist for one reason only.

The Leader must prefer references over explanations.

The Leader must reduce reading effort, not increase it.

If information already exists,

reference it.

Never duplicate it.

---

# File Generation Rules

## Router

Purpose

Navigation only.

Must contain

• routes

• references

Must never contain

• explanations

• implementation

• documentation

• architecture descriptions

---

## Memory

Purpose

Knowledge index.

Must contain

• summaries

• references

• ownership

• relationships

Must never contain

• tutorials

• implementation details

• duplicated documentation

Memory is not a wiki.

---

## Road

Purpose

Execution contract.

Must contain

• context scope

• expected files

• change scope

• execution boundaries

Must never contain

• architecture explanations

• project documentation

• implementation tutorials

Roads should remain minimal.

---

## Task

Purpose

Execution instructions.

Must contain

• objective

• constraints

• references

• expected output

Tasks must reference knowledge.

Tasks must never duplicate knowledge.

---

## Phase

Purpose

Organize related work.

Must contain

• objectives

• outputs

• dependencies

Must never explain implementation.

---

## Plan

Purpose

Represent one business capability.

Plans organize work.

Plans do not teach implementation.

---

## Dependency Memory

Purpose

Impact analysis.

Contains relationships only.

Never implementation.

---

# Leader Decision Rules

Before creating a file,

the Leader asks:

Does this knowledge already exist?

↓

YES

Reference it.

↓

NO

Create one owner.

Every concept must have exactly one owner.

---

# Generation Order

Generation happens in two phases.

Initial Generation builds the skeleton once.

Confirm Source of Truth

↓

Analyze Project

↓

Identify Plans

↓

Identify Phases

↓

Identify Shared Knowledge

↓

Build Memory

↓

Build Router

↓

Validate Skeleton

Initial Generation never creates Tasks.

Initial Generation never creates Roads.

On-Demand Generation builds work only when it is requested.

Generate Task

↓

Generate Road

↓

Validate

Tasks and Roads are generated on demand, never in advance.

---

# Workflow Validation

Before considering the workflow complete,

the Leader verifies:

• Every concept has one owner.

• No duplicated knowledge exists.

• Every file has one purpose.

• Every task has a Road.

• Every Road defines clear scope.

• Memory files are indexes.

• Router contains only routing.

• Workers can execute without repository scanning.

• Scope boundaries are explicit.

• Navigation follows architecture.

If any answer is NO,

the workflow is incomplete.

---

# Common Generation Mistakes

Never generate workflows that:

• duplicate the same knowledge

• explain implementation inside Memory

• explain Features inside Router

• turn Memory into documentation

• turn Road into documentation

• repeat project descriptions inside Tasks

• repeat information across Plans and Phases

• mix planning with execution

• allow Workers to redesign architecture

• create files solving multiple purposes

When unsure,

prefer references.

Never explanations.

---

# Success Definition

AKRS succeeds when:

• Workers read fewer files.

• Workers stay inside scope.

• Workers follow prepared Roads.

• Blind assumptions decrease.

• Knowledge has one owner.

• Navigation becomes predictable.

• Small execution models perform reliable engineering work.

The goal is not replacing powerful models.

The goal is allowing powerful models to think once,

so inexpensive execution models can execute many times.

---

# Failure Definition

AKRS fails when:

• Workers repeatedly leave assigned scope.

• Routing becomes larger than execution.

• Knowledge becomes duplicated.

• Roads become unreliable.

• Memory becomes documentation.

• Router becomes documentation.

• Workers need repository scanning.

• Planning and execution become mixed.

If these conditions appear,

the architecture must be simplified before expanding.

---

# Final Principle

AKRS is not a documentation system.

AKRS is not a memory system.

AKRS is not a planning framework.

AKRS is a knowledge routing architecture.

Its purpose is simple:

Deliver the smallest correct knowledge,

to the correct agent,

at the correct moment.
