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

4. **Recent background refreshes** (optional): if `<TARGET>/.wiregraph/refresh.log`
   exists, show the last few lines so the user can see auto-updates are running.

5. **Measured impact** (optional): if `<TARGET>/.wiregraph/metrics.jsonl` exists,
   show the rollup:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/metrics.mjs summary "<TARGET>"
   ```

   This reports graph-tool usage, estimated tokens saved by `get_source`, trace
   coverage, and the **adoption gap** (greps that searched for a symbol the graph
   already knows). Pass `--session <id>` to scope it to one session. Make clear to
   the user these are **local estimates under a counterfactual** (chars-per-token
   proxy), not billed tokens — useful for trend and for spotting where wiregraph
   is being bypassed, not for exact accounting. No file yet just means no graph
   tools have run since this was added.

6. **Contract coverage** (multi-repo only): from `graph_stats`, note the Contracts
   count. If the graph spans **2+ repos but has 0 contracts**, cross-repo wire seams
   aren't being traced — suggest `/wiregraph-contracts` to infer them from the code.
   (Single-repo projects don't need contracts.)

Summarize the health as a short checklist with any fixes needed.
