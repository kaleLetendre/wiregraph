---
description: Infer cross-repo wire contracts from code and write a draft AsyncAPI spec, so wiregraph can trace how your services connect
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash, Read, AskUserQuestion
---

Discover the **wire seams** between repos in this workspace — endpoints one repo
defines and another repo calls — and propose an AsyncAPI **contract** that links
them, so `trace_contract` / `path_between` can follow producer→consumer across
repos. wiregraph reads these seams out of the code (shared HTTP routes today); you
don't have to hand-write specs.

A contract is just **the defined communication between two compartments** — here,
two repos talking over HTTP. (The same idea covers a library/SDK's API surface or a
shared-state boundary; see `docs/contracts.md`.) The inference is a **heuristic**:
it's a draft to review and commit, not the truth.

**Target:** `$1` if provided, else `${CLAUDE_PROJECT_DIR}`, else cwd; call it
`<TARGET>`. The script resolves the indexed **workspace root** on its own, so this
is safe to run from inside a sub-repo.

Do the steps in order:

1. **Scan (no writes).** Infer the cross-repo seams and show the proposal:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs scan "<TARGET>"
   ```

   Show the user the seams and the proposed AsyncAPI YAML.

2. **If it found no seams**, don't write anything. Explain the **workspace model**,
   which is what cross-repo contracts depend on: put all the related repos
   side-by-side under one parent folder (each its own git repo) and `/wiregraph-init`
   that parent — wiregraph can only see a shared route if both repos are indexed
   together. Stop here.

3. **If it found seams**, ask the user with AskUserQuestion whether to write the
   draft contract. Make clear it's a starting point they own and should review/commit.

4. **On yes**, write it:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs apply "<TARGET>"
   ```

   This creates or reuses a contracts home (`contracts/`, `asyncapi/`, or a
   `*-contracts` dir/repo) and writes `wiregraph-inferred.asyncapi.yaml` into it.

5. **Light up the edges.** The read tools self-heal, or run `/wiregraph-update` to
   re-index now. Then confirm with `trace_contract` (which symbols in which repos
   reference the contract) and `path_between` (a producer in one repo to the
   consumer in another). Summarize what was linked.

Note: cross-repo attribution relies on each repo having its own `.git`. If repos
are indexed separately rather than together in one workspace, the shared routes
won't be visible — guide the user to the workspace model above.
