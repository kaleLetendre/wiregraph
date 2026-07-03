---
description: Visualize the project's contracts (and call graph) as a self-contained interactive HTML page, and open it in your browser
argument-hint: "[target-dir] · add --all for the full call graph, or --contract \"<name>\" for one seam"
allowed-tools: Bash
---

Render this project's graph as a **standalone, offline HTML page** — a d3
force-directed layout where each repo is its own color cluster and **Contract nodes
sit in the middle as the bridges between repos** — then open it in the default
browser. Everything is inlined (d3 included); the file makes **no network requests**
and nothing leaves the machine. It's written to `<TARGET>/.wiregraph/graph.html`
(inside the gitignored footprint).

**Target:** `$1` if it's a path, else the active project (`${CLAUDE_PROJECT_DIR}` or
cwd). Call it `<TARGET>`. Pass `--all` or `--contract "<name>"` through if the user
asked for them.

Modes (pick based on what the user wants to see):
- **default** — the **contract view, aggregated per repo**: one hub node per repo and
  one arrow per (repo → contract), so a big workspace shows which repos touch which
  contracts instead of a hairball of per-function edges. Arrow thickness = how many
  functions in that repo reference the contract; hover for the count and the fields.
- **`--functions`** — the same contract view but **per function**: every symbol that
  references a contract, one arrow each. More detail, busier — use when a repo's mass
  of references matters.
- **`--all`** — the full Symbol/Contract graph with CALLS edges (the whole codebase).
- **`--contract "<name>"`** — one contract across all repos, with the call stacks that
  reach it (callers up, callees down).

Steps:

1. Generate and open (default contract view):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/src/export-html.js --project "<TARGET>" --open
   ```

   For per-function detail use `--functions`, the full graph `--all`, or focus one
   seam with `--contract "<name>"`. The command prints the node/link counts, the
   output path, and the repo→color map.

2. **If it reports `0 nodes`** in the default (contract) view, this project has no
   cross-repo contracts to draw yet. Tell the user and offer the alternatives:
   - re-run with `--all` to visualize the full call graph instead, and/or
   - run `/wiregraph-contracts` (multi-repo workspaces) to infer the seams first.
   Don't treat an empty contract view as an error — a single-repo project simply has
   no contracts.

3. Report the path (`<TARGET>/.wiregraph/graph.html`) and that it opened in the
   browser. If the environment has no browser (headless/SSH), the command prints a
   note and the user can open the file manually — say so rather than implying it
   displayed.

Note: the page is interactive — drag nodes, scroll to zoom, click a legend swatch to
hide a repo, hover an edge for the shared tokens/fields. Re-run any time; it
overwrites the same file.
