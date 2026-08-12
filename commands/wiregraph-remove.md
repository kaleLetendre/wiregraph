---
description: Hard-uninstall wiregraph from a project — delete the graph db, the .wiregraph/ folder, the CLAUDE.md directive and the .gitignore entry, detach every linked peer graph, and deregister it from /wiregraph-stats; your source and any contract specs are left in place
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash, Read, AskUserQuestion
---

Completely remove wiregraph's **installation** footprint from a project. Unlike
`/wiregraph-teardown` (which just disables auto-update and keeps the data for a quick
re-init), this **deletes** the graph and the managed edits wiregraph made.

**Target:** `$1` if provided, else the active project (`${CLAUDE_PROJECT_DIR}` or
cwd). Call it `<TARGET>`.

What gets removed, in the order the script does it:
- **link records in every PEER graph.** For a linked project this writes to a SECOND
  REPOSITORY: each peer drops its mirror record and rebuilds over the union without
  `<TARGET>`, so no graph is left holding a dangling link. Step 1's dry run names every
  peer it would touch — read that list out before confirming;
- the managed directive block in `<TARGET>/CLAUDE.md` (only between the sentinels);
- the `.wiregraph/` entry in `<TARGET>/.gitignore` (only that line + its comment);
- the `<TARGET>/.wiregraph/` folder (the `graph.db` itself, `state.json`, log);
- a dangling `~/.wiregraph` symlink if it pointed at the deleted folder. This is a
  legacy pointer no current version creates, so on any project initialized by a recent
  wiregraph the line never appears — its absence is not a failure;
- this graph's entry in the global registry `~/.wiregraph-projects.json`, so
  `/wiregraph-stats` stops counting it.

What is **left on disk**, because wiregraph does not own it once it is written:
- **any contract spec under `contracts/`** — including the drafts `/wiregraph-contracts`
  itself generated (`wiregraph-inferred.asyncapi.yaml`,
  `wiregraph-inferred.resource.yaml`). These are source files the user reviews and
  commits; deleting reviewed, committed specs is not something an uninstall may do. Say
  so, and name them, so the user can delete them if they want to;
- an **emptied `CLAUDE.md` or `.gitignore`** — the managed block and the ignore line are
  cut out, but a file that held nothing else stays behind as a 0- or 1-byte file rather
  than being deleted. Mention it; removing an empty file the user may have created is
  their call, not the uninstaller's.

The whole graph is the one SQLite file inside `.wiregraph/`, so there is no daemon
to stop and no shared DB to scrub — deleting the folder removes this project's
graph entirely. Your source, the rest of `CLAUDE.md`, and the rest of `.gitignore`
are untouched.

Steps:

1. **Preview** exactly what will be removed (no changes made):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remove.mjs "<TARGET>" --dry-run
   ```

   Every line is prefixed `• would `; a step with nothing to do prints `– ` and the
   reason. The one line that reaches outside `<TARGET>` is the peer detach:

   - `• would unlink from <path>` → a SECOND repository is written to. Say the path out
     loud in the confirmation question: that graph loses this one's compartments and the
     shared seam, and it rebuilds.
   - `– no linked peers (skipped)` → nothing outside `<TARGET>` is touched.

   Show the output and get explicit confirmation (AskUserQuestion) before proceeding —
   this is destructive, and for a linked project it is destructive in two places.

2. **Remove:**

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remove.mjs "<TARGET>"
   ```

3. **Report what was removed AND what survived.** Read back the `✓` lines, then check
   the two things the script deliberately does not touch, so the user is never told
   "everything wiregraph created is gone" while wiregraph-written files remain:

   - any `wiregraph-inferred.*.yaml` still in the project's contracts dir — name each
     one and offer to delete it;
   - `CLAUDE.md` / `.gitignore` left empty (0 or 1 byte) because they held only the
     managed block or the ignore line — name them and offer to delete them.

   To also remove the plugin itself, the user can disable/uninstall it via `/plugin`.
