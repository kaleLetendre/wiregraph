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

3. **Leave in place:** this project's graph data lives in `<TARGET>/.wiregraph/`
   (`graph.db` + `state.json`) — left intact so re-init is instant. There is no
   daemon to stop. To fully remove wiregraph from the project, use
   `/wiregraph-remove` (it deletes that folder, the directive block, and the
   `.gitignore` entry), or just `rm -rf "<TARGET>/.wiregraph"`.

Confirm what was removed and what was intentionally left.
