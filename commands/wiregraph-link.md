---
description: Link an external directory into this graph as a member, so cross-repo wire seams (a client and the server it only calls over HTTP) light up in trace_contract / path_between
argument-hint: "<dir-to-link> (the other repo; this graph is resolved from the cwd)"
allowed-tools: Bash, Read, AskUserQuestion
---

Include an external, code-disconnected directory as a **member** of this project's
wiregraph — for example a terminal/client repo and the server repo it only talks to
over HTTP. Once linked, the wire seam between them shows up in `trace_contract` and
`path_between` as if they were one workspace.

Linking is **mutual**: it writes reciprocal records into *both* graphs' configs and
rebuilds *both*, so the seam is queryable from either side. The near graph (**SELF**)
is resolved from the current directory; you pass only the **other** directory.

**Target:** `$1` — the directory to link. Call it `<TARGET>`. SELF is resolved from
`${CLAUDE_PROJECT_DIR}` / cwd by the script (run this from inside the graph you want
to link *from*). If SELF isn't indexed yet, the script says so — run `/wiregraph-init`
here first.

Do the steps in order:

1. **Preview (no writes).** Show exactly what would change on each side:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs preview "<TARGET>"
   ```

   This prints the changes to SELF and to `<TARGET>` — including whether `<TARGET>`
   is a fresh directory that will be **auto-initialized** as a new graph (a second,
   unrelated repo written to). If it prints `REJECTED:`, stop and relay the reason
   (overlap, a nested/enclosing foreign index, or a compartment **basename
   collision** — two members can't share a compartment name, because compartment ids
   aren't path-unique). The exit code is non-zero on rejection.

2. **Confirm.** Show the preview to the user and get explicit confirmation with
   AskUserQuestion — make clear a second repo gets a `.wiregraph/` folder and both
   graphs are rebuilt. On decline, stop.

3. **Link:**

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs link "<TARGET>"
   ```

4. **Confirm the seam.** Call `graph_stats` (the member now appears under a
   **Linked:** heading) and `trace_contract` on the shared route/topic to show the
   producer→consumer seam. Summarize what was linked. Note: cross-member seams are a
   full-rebuild product, so they refresh on rebuild/`link`, not on a single edit.

Seam heuristic: the seam fires only on a distinctive literal token shared by both
sides (a real route like `/api/logs` written literally in each repo), not a
dynamically-built URL or a generic path like `/health`. If `trace_contract` shows
nothing, check the route is a literal string on both sides.
