---
description: Show wiregraph's measured token-savings dashboard for the active project (deterministic — printed verbatim)
argument-hint: "(no args — uses the active project)"
allowed-tools: Bash
---

Print wiregraph's measured-impact dashboard and show the output **verbatim**.

This is a deterministic report — **do not** reformat, summarize, recompute, or add
interpretation. The script already explains how the numbers are projected and labels
them as local counterfactual estimates; just run it and relay exactly what it prints.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/metrics.mjs report
```

The script resolves the active workspace on its own (no path needed) and works from
any subdirectory. If it prints "No activity recorded yet," relay that line as-is.
