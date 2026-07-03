---
description: Initialize wiregraph for a project — build the graph, install the directive + auto-update, and start using Claude at ~50% fewer tokens
argument-hint: "[target-dir] (defaults to the current project root)"
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

Set up wiregraph for a project end to end: install dependencies, build the
cross-repo call graph into an embedded SQLite file, install the proven navigation
directive into the project's CLAUDE.md, and turn on balanced auto-update. After
this, just use Claude normally — code navigation/audit/refactor questions cost
~40–60% fewer tokens. There is no daemon, JVM, or background server.

**Target directory:** use `$1` if provided, else `${CLAUDE_PROJECT_DIR}` if set,
else the current working directory. Call this `<TARGET>` below and use the
realpath.

Do the steps in order; stop and report if a step fails.

**First — detect an existing setup and reroute if needed.** Before any of the steps
below, check whether `<TARGET>` (or a parent workspace) is already indexed:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs check "<TARGET>"
```

- `indexed: no` → this is a fresh setup; do all the steps below.
- `indexed: yes` → wiregraph is **already set up** here (the `root:` line shows where;
  `sameDir: no` means an ancestor workspace is what's indexed, not `<TARGET>` itself).
  If the `db:` line says **`missing`**, the graph was never built or was deleted —
  don't ask; go straight to **Rebuild** below.
  Re-running full init would redundantly re-confirm scope and re-prompt for the
  CLAUDE.md directive — what's almost always wanted instead is a **rebuild**. Ask with
  AskUserQuestion how to proceed, and do **not** silently re-run the full setup:
  - **Rebuild (recommended)** — regenerate the graph from scratch: call the
    `update_graph` MCP tool with `{ "full": true }` (equivalent to `/wiregraph-rebuild`),
    report the new stats, and stop. Right after refactors/renames or a stale/wrong graph.
  - **Update** — incremental catch-up only: call `update_graph` with no args, report,
    and stop. Cheapest when little has changed.
  - **Re-initialize anyway** — only if the user wants to change scope or reinstall the
    directive. Then continue with the steps below.

1. **Install dependencies (idempotent, one-time).** Pulls the WASM SQLite store
   (`sql.js`) and the tree-sitter parsers — toolchain-free (nothing is compiled:
   sql.js is WebAssembly bundled in the package, tree-sitter ships prebuilt
   binaries). A clean install is ~1 s and needs only Node:

   ```
   npm install --prefix ${CLAUDE_PLUGIN_ROOT} --legacy-peer-deps
   ```

   If this is the FIRST run right after installing the plugin from a marketplace,
   the wiregraph MCP server started before these deps existed, so its tools aren't
   available yet. After this install completes, tell the user to run
   `/reload-plugins` (once) so the MCP server restarts with the deps present — then
   the `find_symbol`/`trace_*`/etc. tools come online for the rest of the steps.

2. **Confirm scope, then build the graph.** wiregraph indexes every **compartment**
   under `<TARGET>` — a compartment is a git repo OR a package/module with its own
   manifest, so one repo can hold several. List what it would cover and confirm the
   scope is what the user meant (prevents the two footguns: indexing one compartment
   when they meant the workspace, or pointing at a huge tree like `$HOME`):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workspace.mjs repos "<TARGET>"
   ```

   Read the `scope:` line and act before building:
   - **MULTI** — 2+ compartments (a monorepo of packages, or repos side-by-side), so
     cross-compartment contracts are possible. Show the compartment list and confirm
     it's the intended set.
   - **SINGLE** — one compartment, so contracts need more than this. Ask the user
     (AskUserQuestion) whether they meant the **parent** folder (related repos/packages
     side-by-side under one parent, `/wiregraph-init` run there). Proceed with the
     single compartment only if they confirm.
   - **NO-GIT** — the whole folder is indexed as one unit (fine for a lone non-git
     project; note contracts need 2+ compartments).

   Then build (full, project-scoped) into `<TARGET>/.wiregraph/graph.db` and report
   the printed stats (repos, files, symbols, contracts, edge counts):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/src/build.js "<TARGET>" --reset
   ```

3. **Seed state + gitignore the footprint.** Everything wiregraph writes per
   project lives in one hidden folder `<TARGET>/.wiregraph/` (`graph.db`,
   `state.json`, `refresh.log`). This step seeds the state (build time, per-repo
   git shas for incremental catch-up, posture → `balanced`) AND adds `.wiregraph/`
   to `<TARGET>/.gitignore` so the indexed graph + machine-local state are never
   committed:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs seed "<TARGET>"
   ```

   Confirm to the user that `.wiregraph/` was added to `.gitignore` (the command
   prints whether it added it, it was already present, or there's no `.git` here).

4. **Infer cross-compartment contracts (MULTI scope only).** If step 2 reported
   **2+ compartments**, auto-run the wire-contract inference now so the
   cross-compartment seams light up without a second command — you don't have to
   invoke `/wiregraph-contracts` separately or remember to rebuild. **Skip this step
   entirely** for a SINGLE or NO-GIT target (there are no cross-compartment seams to
   find), and just note that contracts don't apply.

   a. **Scan (no writes)** and show the user the proposed seams + AsyncAPI YAML:

      ```
      node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs scan "<TARGET>"
      ```

   b. **If it found no seams**, say so and move on — nothing to write. (Common when
      repos are indexed together but don't actually share a route / topic / env var
      yet.)

   c. **If it found seams**, ask with AskUserQuestion whether to write the draft
      contract, making clear it's a heuristic starting point the user owns and
      should review/commit. On decline, move on — the seams are still reported.

   d. **On yes**, write the draft and rebuild so the seams become graph edges:

      ```
      node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs apply "<TARGET>"
      node ${CLAUDE_PLUGIN_ROOT}/src/build.js "<TARGET>" --reset
      ```

      Then confirm with the `trace_contract` MCP tool (which symbols in which repos
      reference the contract) and report the cross-repo edge counts now in the graph.

5. **Install the navigation directive** into `<TARGET>/CLAUDE.md`. First show the
   user what would change, then get explicit consent before writing:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/claudemd.mjs diff "<TARGET>"
   ```

   Show that block to the user and ask whether to add it (use AskUserQuestion).
   This directive is what makes Claude reach for the graph economically — it is
   the source of the token win. If they consent:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/claudemd.mjs apply "<TARGET>"
   ```

   If they decline, continue — the MCP tool descriptions still carry the economy
   guidance, but note the win is strongest with the directive installed.

6. **Auto-update / hooks.** The plugin ships `SessionStart`, `PreToolUse`, and
   `PostToolUse` hooks; they fire automatically whenever the wiregraph plugin is
   enabled. `SessionStart` catches up on out-of-session changes (and re-asserts
   the directive), `PreToolUse` on `Grep`/`Glob`/`Read` reminds Claude to prefer
   the graph (rate-limited per session so it stays cheap; the `Read` nudge only
   fires on a full read of a sizable source file), and `PostToolUse` re-indexes
   edited files. The posture written in step 3 controls them:
   - `off` — hooks do nothing (no catch-up, no navigation nudge)
   - `conservative` — SessionStart catch-up + the search/read navigation nudge
   - `balanced` (default) — + re-index each file Claude edits
   - `aggressive` — + (optional) repo git post-commit/post-merge hooks

   Tell the user the posture is `balanced` and that they can change it with
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs posture "<TARGET>" <value>`.
   If the user's Claude Code does not auto-run plugin hooks, they can enable them
   explicitly in `<TARGET>/.claude/settings.json` (offer this only if asked).

7. **Confirm** by calling the `graph_status` MCP tool. Then summarize: graph
   built (counts), directive installed (or declined), posture, and that the
   wiregraph MCP tools (`find_symbol`, `get_source`, `trace_callers`,
   `trace_callees`, `trace_contract`, `path_between`, `graph_status`,
   `update_graph`, `query_sql`) are now queryable for this project.

Note: a project may contain several git repos (wiregraph indexes them all under
this one project); cross-repo links flow through Contract nodes — see
`trace_contract` / `path_between`. Step 4 already infers those wire contracts for a
multi-repo workspace; the user can re-run `/wiregraph-contracts` any time to
re-scan and refine the draft after the workspace changes.
