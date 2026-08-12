---
description: Soft-remove wiregraph's footprint from a project (directive block, hook enablement). Leaves the graph db for instant re-init.
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash, Read, AskUserQuestion
---

Cleanly back wiregraph out of a project. **Target** = `$1` or the active project
(`${CLAUDE_PROJECT_DIR}` or cwd); call it `<TARGET>`.

1. **Remove the managed CLAUDE.md block.** This only strips the text between the
   `BEGIN wiregraph (managed)` / `END wiregraph` sentinels; the rest of the file
   is untouched:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/claudemd.mjs remove "<TARGET>"
   ```

2. **Disable auto-update** so the hooks no-op even while the plugin stays
   installed:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs posture "<TARGET>" off
   ```

   If the user explicitly enabled the hooks in `<TARGET>/.claude/settings.json`,
   tell them to remove those entries too (show the file; don't edit without
   consent).

3. **Drop a compartment DECLARATION, if this project has one.** Check first:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/compartments.mjs show "<TARGET>"
   ```

   If it reports `mode: recursive`, ask the user (AskUserQuestion) whether they are
   backing out entirely or intending to re-init in the SAME recursive mode. Backing out —
   or switching to global — clear it:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/compartments.mjs clear "<TARGET>"
   ```

   Why this belongs to teardown: `/wiregraph-init` documents "switching modes later means
   teardown + re-init", and this is the half that makes that promise true. Teardown
   deliberately leaves `.wiregraph/` intact (step 4), so without this the declaration
   survives and the next init keeps partitioning on it whatever the user answers — the
   build stays recursive and init's final read-back still says `Mode: recursive`. (Init's own
   global branch clears it too; both paths, because either one can be the one taken.)

   `clear` leaves `compartmentsFingerprint` alone on purpose — the stale stamp is what
   forces the next build to be a FULL one, which is required: dropping a declaration
   re-partitions every file exactly as adding one did. Report the declaration as removed.

4. **Leave in place:** this project's graph data lives in `<TARGET>/.wiregraph/`
   (`graph.db` + `state.json`) — left intact so re-init is instant. There is no
   daemon to stop. To fully remove wiregraph from the project, use
   `/wiregraph-remove` (it deletes that folder, the directive block, and the
   `.gitignore` entry), or just `rm -rf "<TARGET>/.wiregraph"`.

   **Tell the user what the next `/wiregraph-init` will look like**, because the folder
   staying behind changes it: init's first step still reads `indexed: yes` /
   `db: present` and therefore offers a three-way reroute. The answer is
   **Re-initialize** — the only one that reaches the mode, scope and compartment
   questions. **Rebuild** would regenerate the graph in the mode being abandoned, which
   is the wrong answer for the whole reason this teardown was run.

Confirm what was removed, what was intentionally left, and — if the point of this was to
change the mode — that the next step is `/wiregraph-init`, answering **Re-initialize**.
