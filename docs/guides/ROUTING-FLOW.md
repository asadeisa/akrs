# Routing Flow

> How a single prompt becomes one obvious execution path.

AKRS funnels every request through a fixed sequence. Each step narrows the
decision space, the same way you narrow a search for a house in a city you
don't know: **city → neighborhood → street → door.**

---

## The One Route

```mermaid
flowchart LR
    P[Prompt] --> M{Mode}
    M --> R[Router]
    R --> Mem[Memory]
    Mem --> Road[Road]
    Road --> E[Execute]

    M -. "Mode 0/1 (fast path)" .-> Road

    classDef plan fill:#1f6feb,stroke:#0b3d91,color:#fff;
    classDef exec fill:#2da44e,stroke:#116329,color:#fff;
    class P,M,R,Mem plan;
    class Road,E exec;
```

Each layer answers exactly **one** question, and owns nothing else:

| Layer | The one question it answers | London analogy |
|-------|-----------------------------|----------------|
| **Prompt** | What does the developer want? | "I need my friend's house" |
| **Mode** | How much navigation is needed? | Tourist vs. local |
| **Router** | Where should execution go? | Which part of the city |
| **Memory** | Which knowledge is required? | Which neighborhood |
| **Road** | Exactly what to read and change? | The exact street + door |
| **Execute** | Build it. | Knock on the door |

---

## Modes (the funnel's first decision)

Before routing, the system picks a **Mode** from the prompt. The Mode decides
how much of the chain you actually walk.

```mermaid
flowchart TD
    Start[Prompt arrives] --> Q1{Dev names the<br/>exact file/area?}
    Q1 -- yes --> M0[Mode 0<br/>Memory + named files only]
    Q1 -- no --> Q2{Small isolated<br/>change?}
    Q2 -- yes --> M1[Mode 1<br/>single Road / file]
    Q2 -- no --> Q3{Existing Task<br/>+ Road?}
    Q3 -- yes --> M2[Mode 2<br/>full route, no new planning]
    Q3 -- no --> Q4{New work<br/>requested?}
    Q4 -- yes --> M3[Mode 3<br/>generate 1 Task + 1 Road]
    Q4 -- no --> M4[Mode 4<br/>cross-cutting · Leader only]

    classDef fast fill:#2da44e,stroke:#116329,color:#fff;
    classDef full fill:#1f6feb,stroke:#0b3d91,color:#fff;
    class M0,M1 fast;
    class M2,M3,M4 full;
```

- **Modes 0–1 are the fast path** — trivial/isolated work skips the full chain.
- **Mode 2** executes an existing Road.
- **Mode 3** is planning: the Leader generates exactly one Task + one Road.
- **Mode 4** is architecture: Leader only.

---

## The Blind-Assumption Check

The Worker asks itself **once**, before writing anything:

```mermaid
flowchart LR
    Q["Can I finish with ONLY<br/>the active Road?"] -- YES --> Exec[Execute]
    Q -- NO --> Loop[Router → required Memory → back to Road]
    Loop --> Exec
    Exec -.->|never| Guess[(guess / scan repo)]

    classDef bad fill:#cf222e,stroke:#82071e,color:#fff;
    class Guess bad;
```

Asked **once**. No recursive routing. No repo scanning. **Never guess.**
A missing piece of required knowledge is a *routing* failure to be fixed in the
Road — not something the Worker should improvise around.

---

## Runtime Priority

During execution, the order of authority is always:

```
Road  →  Memory  →  Router  →  Repository
```

The repository is consulted **only** when the active Road explicitly says so.
This is what stops a cheap model from drowning in a large codebase.

---

## The Lifecycle (zoomed out)

Routing happens inside a larger loop. Plan rarely; execute often; reconcile
always.

```mermaid
flowchart TD
    A[Phase A<br/>Generate skeleton once] --> K[Generate kernel/ folder<br/>CORE + role files]
    K --> Entry[Create AGENTS.md entry]
    Entry --> B[Phase B<br/>Generate 1 Task + 1 Road on demand]
    B --> X[Worker executes the Road]
    X --> C[Close-out:<br/>update STATE + reconcile Road + Memory]
    C -->|next request| B

    classDef lead fill:#1f6feb,stroke:#0b3d91,color:#fff;
    classDef work fill:#2da44e,stroke:#116329,color:#fff;
    class A,K,Entry,B lead;
    class X,C work;
```

- **Blue = Leader** (think once): expensive model, infrequent.
- **Green = Worker** (execute many): cheap model, constant.

---

## Why This Works

A large project gives an AI **too much context, too many files, too many
solutions**. Big models survive it by brute force; small models fail.

AKRS removes the wrong options *before* reasoning begins. By the time the Worker
acts, "many possible answers" has become "one obvious execution path" — which is
exactly the regime in which inexpensive models become reliable.

See [`FILE-STRUCTURE.md`](FILE-STRUCTURE.md) for what each file contains, and
[`../framework/01-Constitution.md`](../framework/01-Constitution.md) for the
full doctrine.
