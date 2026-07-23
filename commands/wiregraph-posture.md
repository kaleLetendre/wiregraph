---
description: Set a project's auto-update posture (off | conservative | balanced | aggressive).
argument-hint: "<off|conservative|balanced|aggressive> [target-dir]"
allowed-tools: Bash
---

Change how aggressively wiregraph keeps a project's graph fresh. **Posture** = `$1`
(one of `off`, `conservative`, `balanced`, `aggressive`). **Target** = `$2` or the
active project (`${CLAUDE_PROJECT_DIR}` or cwd); call it `<TARGET>`.

1. Set it:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs posture "<TARGET>" <posture>
   ```

   The script validates the value (rejecting anything outside the four levels) and
   writes it to `<TARGET>/.wiregraph/state.json`. No rebuild is triggered.

2. Report the new posture and what it means:
   - `off` — hooks no-op; nothing re-indexes and there's no session-start catch-up.
   - `conservative` — catches up at session start and nudges toward the graph; no on-edit re-index.
   - `balanced` (the default) — the above, plus an incremental re-index on every edit.
   - `aggressive` — the above, plus optional git post-commit / post-merge hooks.

A linked peer graph honors its own posture for edits fanned in from another graph,
skipping only `off`.
