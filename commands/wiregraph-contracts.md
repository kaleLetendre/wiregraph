---
description: Infer cross-compartment wire contracts from code and write a draft AsyncAPI spec, so wiregraph can trace how your services connect
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash, Read, AskUserQuestion
---

Discover the **wire seams** between compartments in this workspace — endpoints one
compartment defines and another calls — and propose an AsyncAPI **contract** that
links them, so `trace_contract` / `path_between` can follow producer→consumer across
compartments. wiregraph reads these seams out of the code (shared HTTP routes today);
you don't have to hand-write specs.

A contract is just **the defined communication between two compartments** — here,
two services talking over HTTP. (A compartment is a package/module or repo; the same
idea covers a library/SDK's API surface or a
shared-state boundary; see `docs/contracts.md`.) The inference is a **heuristic**:
it's a draft to review and commit, not the truth.

**Target:** `$1` if provided, else `${CLAUDE_PROJECT_DIR}`, else cwd; call it
`<TARGET>`. The script resolves the indexed **workspace root** on its own, so this
is safe to run from inside a sub-repo.

Do the steps in order:

1. **Scan (no writes).** Infer the cross-compartment seams and show the proposal:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs scan "<TARGET>"
   ```

   Show the user the seams and the proposed AsyncAPI YAML.

2. **If it found no seams**, don't write anything. Explain the **workspace model**,
   which is what cross-compartment contracts depend on: index 2+ compartments
   together under one parent — either related repos cloned side-by-side, OR the
   packages of a monorepo (each with its own manifest) — and `/wiregraph-init` that
   parent. If the two services are **already indexed as separate graphs**, connect
   them with `/wiregraph-link` instead of re-indexing. wiregraph can only see a
   shared route if both compartments are in one graph. Stop here.

3. **If it found seams**, ask the user with AskUserQuestion whether to write the
   draft contract. Make clear it's a starting point they own and should review/commit.

4. **On yes**, write it:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs apply "<TARGET>"
   ```

   This creates or reuses a contracts home (`contracts/`, `asyncapi/`, or a
   `*-contracts` dir/repo) and writes `wiregraph-inferred.asyncapi.yaml` into it.

5. **Light up the edges.** The read tools self-heal, or run `/wiregraph-update` to
   re-index now. Then confirm with `trace_contract` (which symbols in which
   compartments reference the contract) and `path_between` (a producer in one
   compartment to the consumer in another). Summarize what was linked.

Note: cross-compartment attribution needs the compartments in **one graph**. There
are two ways to get that: **either** index them together under one parent (related
repos side-by-side, or a monorepo's packages — a compartment boundary is a `.git`
OR a package/module manifest), **or** connect two separately-indexed graphs with
`/wiregraph-link`, which includes one as a member of the other and re-infers seams
across the union. Two repos each with their own `/wiregraph-init` and no link
between them still can't see a shared route — guide the user to link them or index
them together.
