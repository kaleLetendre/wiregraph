---
description: Show wiregraph's GLOBAL token-savings dashboard across every indexed project on this machine (deterministic — printed verbatim)
argument-hint: "(no args — aggregates all your graphs; use /wiregraph-stats-local for just this one)"
allowed-tools: Bash
---

Print wiregraph's **global** measured-impact dashboard — savings aggregated across
every graph you've init'd or linked on this machine — and show the output **verbatim**.

This is a deterministic report — **do not** reformat, summarize, recompute, or add
interpretation. The script already explains and labels the numbers; just run it and
relay exactly what it prints.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/metrics.mjs global
```

The project set comes from wiregraph's own registry (the graphs it recorded at
init/link time — no filesystem scan); a graph deleted without `/wiregraph-remove` is
pruned lazily on read. For just the current project, point the user at
**`/wiregraph-stats-local`**. If it prints "No measured activity … yet," relay that as-is.
