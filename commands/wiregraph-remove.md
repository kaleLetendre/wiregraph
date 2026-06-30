---
description: Hard-uninstall wiregraph from a project — delete the graph db, the .wiregraph/ folder, the CLAUDE.md directive, and the .gitignore entry; leave everything else untouched
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash, Read, AskUserQuestion
---

Completely remove wiregraph's footprint from a project. Unlike `/wiregraph-teardown`
(which just disables auto-update and keeps the data for a quick re-init), this
**deletes** everything wiregraph created and nothing else.

**Target:** `$1` if provided, else the active project (`${CLAUDE_PROJECT_DIR}` or
cwd). Call it `<TARGET>`.

What gets removed:
- the managed directive block in `<TARGET>/CLAUDE.md` (only between the sentinels);
- the `.wiregraph/` entry in `<TARGET>/.gitignore` (only that line + its comment);
- the `<TARGET>/.wiregraph/` folder (the `graph.db` itself, `state.json`, log);
- a dangling `~/.wiregraph` symlink if it pointed at the deleted folder.

The whole graph is the one SQLite file inside `.wiregraph/`, so there is no daemon
to stop and no shared DB to scrub — deleting the folder removes this project's
graph entirely. Everything else — your source, the rest of `CLAUDE.md`, the rest
of `.gitignore` — is left untouched.

Steps:

1. **Preview** exactly what will be removed (no changes made):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remove.mjs "<TARGET>" --dry-run
   ```

   Show the output to the user and get explicit confirmation (AskUserQuestion)
   before proceeding — this is destructive.

2. **Remove:**

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remove.mjs "<TARGET>"
   ```

3. Report what was removed and confirm the rest of the project is intact. To also
   remove the plugin itself, the user can disable/uninstall it via `/plugin`.
