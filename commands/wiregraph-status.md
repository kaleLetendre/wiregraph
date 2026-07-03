---
description: wiregraph doctor — check the project's graph, freshness, the directive, and the auto-update posture
argument-hint: "(no args — checks the active project)"
allowed-tools: Bash, Read
---

Diagnose wiregraph for the active project and give a one-line fix for anything
that's off. **Target** = `${CLAUDE_PROJECT_DIR}` or cwd; call it `<TARGET>`.

1. **Graph health + freshness.** Call the `graph_status` MCP tool. It reports
   whether this project is indexed (counts), the last full build, the auto-update
   posture, and whether any file's on-disk content differs from what was indexed
   (the read tools self-heal these on demand, so "stale" here is informational).

   Map its output to a fix:
   - "No wiregraph for this project" → run `/wiregraph-init`
   - "schema is v… expects v…" → run `/wiregraph-rebuild`
   - "STALE: N changed file(s)" → run `/wiregraph-update`
   - "Fresh" → nothing to do

   If the MCP tool itself is unreachable, dependencies may not be installed:
   `npm install --prefix ${CLAUDE_PLUGIN_ROOT} --legacy-peer-deps`.

2. **Directive present?** Check whether the navigation directive is installed in
   `<TARGET>/CLAUDE.md` (look for the `BEGIN wiregraph (managed)` sentinel). If
   absent, the token win is reduced — suggest re-running `/wiregraph-init` (step 4)
   to install it.

3. **State + posture.** Show the state file so the user can see posture and shas:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs show "<TARGET>"
   ```

   Remind them posture is changeable with
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs posture "<TARGET>" <off|conservative|balanced|aggressive>`.

4. **Hooks firing?** From the state in step 3, read `hooksLastFired` — the SessionStart
   hook stamps it every session it runs on an indexed project.
   - **absent / `null`** → If the user *just* ran `/wiregraph-init` this session, that's
     expected (SessionStart ran before the graph existed; it'll stamp on the next
     session) — say so, don't alarm. But if it stays absent across sessions, the
     plugin's hooks are NOT firing in this Claude Code: no SessionStart catch-up, no
     navigation nudges, no re-index-on-edit — the graph only self-heals on MCP reads,
     so heavy editing drifts silently. Tell them to enable the plugin's hooks (or add
     them to `<TARGET>/.claude/settings.json`) and to run `/wiregraph-update` after big
     edits until then.
   - **present** → note "hooks active (last SessionStart: `<hooksLastFired>`)".

5. **Recent background refreshes** (optional): if `<TARGET>/.wiregraph/refresh.log`
   exists, show the last few lines so the user can see auto-updates are running.

6. **Measured impact** (optional): if `<TARGET>/.wiregraph/metrics.jsonl` exists,
   point the user to **`/wiregraph-stats`** — the dedicated, deterministic
   dashboard of graph-tool usage, estimated tokens saved, and the adoption gap
   (it explains how the numbers are projected). Don't recompute it here.

7. **Contract coverage**: from the state shown in step 3, read `inferredSeams` (the
   cross-compartment seams — messaging/state/HTTP — the last full build detected) and
   `contractsDir`. If `inferredSeams > 0` and there's no `contractsDir`, those seams
   aren't captured yet — recommend `/wiregraph-contracts` to draft contracts for
   them. If a `contractsDir` is present, coverage is in place (nothing to do).

Summarize the health as a short checklist with any fixes needed.
