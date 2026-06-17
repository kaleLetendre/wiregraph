---
description: Initialize codegraph for a project — build the graph, install the directive + auto-update, and start using Claude at ~50% fewer tokens
argument-hint: "[target-dir] (defaults to the current project root)"
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

Set up codegraph for a project end to end: install dependencies, build the
cross-repo call graph into an embedded SQLite file, install the proven navigation
directive into the project's CLAUDE.md, and turn on balanced auto-update. After
this, just use Claude normally — code navigation/audit/refactor questions cost
~40–60% fewer tokens. There is no daemon, JVM, or background server.

**Target directory:** use `$1` if provided, else `${CLAUDE_PROJECT_DIR}` if set,
else the current working directory. Call this `<TARGET>` below and use the
realpath.

Do the steps in order; stop and report if a step fails.

1. **Install dependencies (idempotent, one-time).** Pulls the WASM SQLite store
   (`sql.js`) and the tree-sitter parsers — toolchain-free (nothing is compiled:
   sql.js is WebAssembly bundled in the package, tree-sitter ships prebuilt
   binaries). A clean install is ~1 s and needs only Node:

   ```
   npm install --prefix ${CLAUDE_PLUGIN_ROOT} --legacy-peer-deps
   ```

   If this is the FIRST run right after installing the plugin from a marketplace,
   the codegraph MCP server started before these deps existed, so its tools aren't
   available yet. After this install completes, tell the user to run
   `/reload-plugins` (once) so the MCP server restarts with the deps present — then
   the `find_symbol`/`trace_*`/etc. tools come online for the rest of the steps.

2. **Build the graph** (full, project-scoped) into `<TARGET>/.codegraph/graph.db`.
   Report the printed stats (repos, files, symbols, contracts, edge counts) back
   to the user:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/src/build.js "<TARGET>" --reset
   ```

3. **Seed state + gitignore the footprint.** Everything codegraph writes per
   project lives in one hidden folder `<TARGET>/.codegraph/` (`graph.db`,
   `state.json`, `refresh.log`). This step seeds the state (build time, per-repo
   git shas for incremental catch-up, posture → `balanced`) AND adds `.codegraph/`
   to `<TARGET>/.gitignore` so the indexed graph + machine-local state are never
   committed:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs seed "<TARGET>"
   ```

   Confirm to the user that `.codegraph/` was added to `.gitignore` (the command
   prints whether it added it, it was already present, or there's no `.git` here).

4. **Install the navigation directive** into `<TARGET>/CLAUDE.md`. First show the
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

5. **Auto-update / hooks.** The plugin ships `SessionStart`, `PreToolUse`, and
   `PostToolUse` hooks; they fire automatically whenever the codegraph plugin is
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

6. **Confirm** by calling the `graph_status` MCP tool. Then summarize: graph
   built (counts), directive installed (or declined), posture, and that the
   codegraph MCP tools (`find_symbol`, `get_source`, `trace_callers`,
   `trace_callees`, `trace_contract`, `path_between`, `graph_status`,
   `update_graph`, `query_sql`) are now queryable for this project.

Note: a project may contain several git repos (codegraph indexes them all under
this one project); cross-repo links flow through Contract nodes — see
`trace_contract` / `path_between`.
