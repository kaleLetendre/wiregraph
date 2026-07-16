---
description: Flatten a wiregraph call slice into one top-to-bottom pseudo-source file — follow the CALLS graph from a root symbol and inline each reachable body once, in reading order, so a feature spread across many files reads like a single script
argument-hint: "<Class.method | method | ClassName> · [--breadth tight|medium|full] [--depth N] [--file <hint>] [--out <path>]"
allowed-tools: Bash
---

Linearize a **vertical call slice** into one readable pseudo-source file. Starting from a
root symbol, this follows the wiregraph `CALLS` graph and inlines each reachable body
**once**, in source-reading order, with a `file:line` banner and a back-reference on
repeats. It's a **reading aid** — the output does not compile — that collapses a flow
smeared across many files (or deep call chains) into something you read top-to-bottom.

It is language-agnostic: it reads whatever wiregraph indexed (Kotlin, Java, Python,
JS/TS, …), and reads each symbol's source from the compartment root recorded in the
graph, so it works across multi-compartment workspaces.

**Target project:** the active project (`${CLAUDE_PROJECT_DIR}` or cwd). The script
auto-detects `<project>/.wiregraph/graph.db`. If the user named a different project, pass
`WIREGRAPH_PROJECT=<path>` in front of the command, or `--db <path>` to the script.

**Root (`$1`):** required. One of:
- `Class.method` — most precise (e.g. `ProcessOrderUseCase.execute`)
- `method` — a bare method name; add `--file <substring>` if it's ambiguous
- `ClassName` — a class/file; picks an entry method (`execute`/`invoke`/`run`/`main`/…)
  or, for a container, inlines every member

Pass any of the user's flags through:
- `--breadth tight|medium|full` — how far across compartment boundaries to inline.
  `tight` = root compartment only · `medium` (default) = root + compartments it calls
  directly · `full` = everything.
- `--depth N` (default 12) — max call depth.
- `--max N` (default 250) — safety cap on symbols inlined.
- `--ambiguous skip|stub|follow` (default `stub`) — how to render name-collision edges.
- `--include-tests` — follow into test sources (needed when the root is a test).
- `--file <substring>` — disambiguate which file the root lives in.
- `--out <path>` — write to a file instead of stdout.

Run it:

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/linearize.py "$1" [flags…]
```

Steps:

1. Run the command with the user's root symbol and flags. Default breadth is `medium`;
   don't add flags the user didn't ask for.
2. If it exits with **"No wiregraph graph.db found"**, the project isn't indexed — tell
   the user to run `/wiregraph-init` (or `/wiregraph-rebuild`) first, then retry.
3. If it exits with **"is not a unique method"** or **"Could not resolve root symbol"**,
   relay the suggestion: re-run as `Class.method` or add `--file <hint>`.
4. On success it prints the slice (a `// LINEARIZED SLICE` header, a call tree, then the
   inlined bodies). For a large slice, prefer `--out <path>` and report the file path plus
   the "N symbols inlined across M files" summary rather than dumping the whole thing.

Note: sibling call order is recovered by scanning each body for the callee's name (the
graph stores calls at symbol granularity, not call-site line), so calls made only through
an interface/lambda are appended after the text-ordered ones. The header labels the slice
`[TRUNCATED]` if it hit `--max`.
