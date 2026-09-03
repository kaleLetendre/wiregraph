---
description: Show wiregraph's token-savings dashboard — global across every indexed project, or --local for just this one (deterministic — printed verbatim)
argument-hint: "[--local] (no args aggregates every graph on this machine; --local scopes to the active project)"
allowed-tools: Bash
---

Print wiregraph's measured-impact dashboard and show the output **verbatim**.

Two scopes, chosen by the argument:

- **no args** → the **global** dashboard: savings aggregated across every graph
  you've init'd or linked on this machine.
- **`--local`** → **only the current project** (the active workspace, resolved on
  its own from any subdirectory — no path needed).

This is a deterministic report — **do not** reformat, summarize, recompute, or add
interpretation. The script already explains and labels the numbers (the local view
labels them as counterfactual estimates); just run the matching command and relay
exactly what it prints.

If this invocation's arguments (`$ARGUMENTS`) contain `--local`, run the local report:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/metrics.mjs report
```

Otherwise (no args — the global default), run the global dashboard:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/metrics.mjs global
```

The global project set comes from wiregraph's own registry (the graphs it recorded
at init/link time — no filesystem scan); a graph deleted without `/wiregraph-remove`
is pruned lazily on read. If the script prints "No measured activity … yet" or
"No activity recorded yet," relay that line as-is.
