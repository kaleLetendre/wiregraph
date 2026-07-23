---
description: Show this graph's linked members — own root and each linked directory with their compartments, plus a mutual/one-sided health flag per link
argument-hint: "(no arguments; the graph is resolved from the cwd)"
allowed-tools: Bash, Read
---

Show the **mutual member view** of this project's wiregraph: its own root and
compartments, plus every linked external directory grouped under it with its
compartments. This is what `graph_stats` (a single-graph view) can't show — it reads
*both* graphs' configs to report link health.

The graph (**SELF**) is resolved from `${CLAUDE_PROJECT_DIR}` / cwd. Run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs list
```

Relay the output. Per linked member it shows a health flag:

- **mutual** — the peer's config names this graph back (the healthy, symmetric state);
- **one-sided** — the peer doesn't; re-run `/wiregraph-link <dir>` from here to repair;
- **directory no longer exists** — the member was moved or deleted; `/wiregraph-unlink`
  it, or restore the directory.

If there are no members, tell the user they can add one with `/wiregraph-link <dir>`
to include a code-disconnected repo (e.g. the server a client only calls over HTTP)
so cross-repo wire seams light up in `trace_contract` / `path_between`.
