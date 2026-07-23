---
description: Show wiregraph's measured token-savings dashboard for ONLY the current project (deterministic — printed verbatim)
argument-hint: "(no args — uses the active project; use /wiregraph-stats for the whole machine)"
allowed-tools: Bash
---

Print wiregraph's measured-impact dashboard for **only the current project** and show
the output **verbatim**.

This is a deterministic report — **do not** reformat, summarize, recompute, or add
interpretation. The script already explains how the numbers are projected and labels
them as local counterfactual estimates; just run it and relay exactly what it prints.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/metrics.mjs report
```

The script resolves the active workspace on its own (no path needed) and works from
any subdirectory. For savings across every graph on this machine, use
**`/wiregraph-stats`**. If it prints "No activity recorded yet," relay that line as-is.
