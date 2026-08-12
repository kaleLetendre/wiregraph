---
description: Review a compartments-and-contracts project for drift between its documentation and reality — the tree, the whoami files, the contract index and the structure document — and fix what the spec already settles
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

Find where this project's **documentation** and its **reality** have drifted apart, and
close the gap.

The compartments-and-contracts architecture costs almost nothing to design and a great
deal to maintain. The tree, the `whoami.md` files, the contract index and the structure
document all describe the same thing, and they come apart quietly — a compartment gets
added and never reaches the index, a contract is written and never listed, a contract
names a compartment one level down and reads perfectly reasonable while it does. This
command makes that drift cheap to find and cheap to fix.

**Target** = `$1`, else `${CLAUDE_PROJECT_DIR}`, else cwd. Call it `<TARGET>`.

---

## The one rule that shapes this whole command

**A script finds the drift. You never do.**

Every comparison in this review is a set difference, a path predicate, or a `stat`.
`scripts/review.mjs` does all of them. While running this command you must **not**:

- open a `whoami.md` — nothing parses those, ever; they are prose for humans (spec §03),
  and a schema for them was considered and rejected;
- list a directory, glob for contracts, or read a contract document to decide whether
  something is a finding;
- compare any two lists yourself;
- add a finding the script did not print, or drop one it did.

**If the script did not print it, it is not a finding.** Your job starts after the
findings exist: relay them, ask the one or two questions that genuinely have two
legitimate answers, and edit the files the script names. That division is the point — a
review that burned model calls re-deriving set differences would cost more to run than
the drift costs to leave in place.

---

## Steps

### 1. Run the review

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs "<TARGET>" --no-color
```

It exits 0 whether or not it found drift — the verdict is in the text, not the exit
code, because a non-zero exit from a tool an agent runs reads as "the script broke".

Add `--structure <path>` if the project's structure document is not `project-structure.md`
at the root. If the script reports `B0` (no structure document found), say so plainly:
axes B, F and G had nothing to compare against, and the run only checked axis A.

The header block is worth relaying as-is. `parsed from the structure document: N index
row(s), …` is the honesty check on the whole run — a structure document this parser
cannot read reports **0 rows** and therefore **0 findings**, which must never be mistaken
for a clean bill of health.

### 2. Report the findings, in the script's own three classes

- **`DRIFT`** — a real disagreement whose fix direction the spec already settles. Do not
  ask about these. `compartments-and-contracts.md` §11 is explicit: the whoami files
  "live with the code, and [are] the authority where the two disagree." So **disk wins**,
  and the fix is a documentation edit. Each finding prints its own `→` direction; that
  direction is the instruction.
- **`ASK`** — a real disagreement where both sides are legitimately authoritative. Step 3.
- **`note`** — informational, or drift that has already been deliberately accounted for.
  Relay these and move on. They are not work.

Findings are aggregated: one finding carries many items. Keep that shape when you relay
them. Do not expand a five-item finding into five bullets competing for attention — the
whole design target is a handful of decisions, not a list of forty.

### 3. Ask only about the `ASK` findings — one question each

At stage 1 there is exactly one kind, and it is the spec's §05 misfiling diagnostic:
**a contract names two compartments that live at different levels.** Per §05 exactly one
of two things is wrong, and the script prints both because it cannot tell them apart:

- **MISFILED** — the communication is really between the *parents*; the row should name
  the parent as a whole and the file belongs in the parent's `contracts/`.
- **LEAKING** — something inside one side genuinely reaches past its neighbour into that
  neighbour's internals. The contract is a symptom; **the reach is the defect**.

Telling them apart means knowing whether code actually crosses that boundary — that is
the graph, and the graph is stage 2. So use `AskUserQuestion`, one question per such
contract, quoting the script's two diagnosis lines verbatim as the two options. Offer a
third option, "leave it — this is deliberate", and if the user picks it, **record the
exception where the reader already looks**: in the contract document's own text, or in
that contracts dir's `README.md`. Do **not** create an ignore file. A fourth artifact
would drift exactly like the three that already have.

### 4. Apply the settled fixes

Ask **once**, for the whole set: "apply these N documentation fixes?" — not once per
finding. Then edit only the files the findings name. The edits stage 1 can produce are:

- **the structure document** — a tree block that promises a path that does not exist, an
  annotation naming a file that is not there, a compartment or contracts dir on disk the
  tree never mentions, an index row for a contract that is not on disk, a contract on disk
  with no index row, an index row whose two sides cannot be read, a row naming three sides
  or naming something that is not a compartment;
- **a `contracts/README.md`** — an empty contracts dir with no note is indistinguishable
  from an oversight (§08). The note says which contracts belong there and which level of
  work will populate each. Writing that note is also how a deliberately unwritten contract
  stops being reported: the script treats a README naming the contract as the §08 note and
  files it under "accounted for" on every future run.
- **the compartment declaration** — `A1` / `A2` mean the declaration and the disk disagree
  about which directories are compartments. Fix it with
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/compartments.mjs declare "<TARGET>" '<json>'`,
  then tell the user a **full rebuild** is required: the compartment name is part of every
  node id. `A3` means the declaration is present but the build **refuses** it and is
  silently running on inferred compartments — that one is urgent, because every
  compartment name in every graph answer is currently fiction.

Two things you must never do to satisfy a finding:

- **Never write a contract just because the index names one.** §08 forbids it outright: a
  contract invented ahead of the code documents an interaction someone imagined, and it
  will be believed. Record the absence instead.
- **Never put anything importable in a `contracts/` directory.** A contract is a document
  (§02). The moment `contracts/` holds shared types it has become the exact coupling the
  architecture exists to prevent, wearing the name of the thing that was supposed to
  prevent it (§10).

### 5. Close with what was NOT checked

Relay the script's `NOT CHECKED AT STAGE 1` block. A review whose silence cannot be
distinguished from a clean bill of health is worse than no review — the reader has to be
able to tell "checked and clean" from "not checked at all".

---

## Scope: this is stage 1 of five

Stage 1 is **structural only**, and deliberately so: it works on a project that has
**whoami files, a structure document and no code at all**, which is the state in which the
documentation is the only thing there is to review.

| Stage | What it adds | Status |
| --- | --- | --- |
| **1** | Axes **A** (declared compartments ↔ disk), **B** (contract index ↔ contracts on disk), **F** (contracts ↔ R1/R4/R5, and the §05 diagnostic), **G** (structure doc ↔ reality) | **built — this command** |
| 2 | Axes **C** (manifest dependency lists ↔ the "must not know about" intent) and **D** (actual cross-compartment edges ↔ the contract index), plus **R3 in reverse** (two compartments with edges and no contract) and **R6** (direction is one-way where it can be) | not built — needs the graph |
| 3 | Axis **E** (contract tokens ↔ code), which **delegates to the existing `trace_contract` MCP tool**. Token matching is not to be reimplemented | not built |
| 4 | Prose review of the whoami files — one job without "and", a named denied list, no restating of contracts (§10). Judgement, so it is a model call and is deliberately outside stage 1 | not built |
| 5 | Interactive direction and apply as a first-class flow | not built — stage 1 reports, and applies what §11 already settles |

Do not attempt a stage-2 or stage-3 check by hand because the graph is available. The
whole value of the split is that stage 1 is answerable without it, and a hand-rolled
version of a check that is going to be deterministic later is exactly the model spend this
command exists to avoid.
