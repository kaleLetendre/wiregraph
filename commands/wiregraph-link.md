---
description: Link an external directory into this graph as a member, so cross-repo seams — a wire (a client and the server it only calls over HTTP) or a shared resource (a file, table or pipe both repos name by the same constant) — light up in trace_contract / path_between
argument-hint: "<dir-to-link> (the other repo; this graph is resolved from the cwd)"
allowed-tools: Bash, Read, AskUserQuestion
---

Include an external, code-disconnected directory as a **member** of this project's
wiregraph — for example a terminal/client repo and the server repo it only talks to
over HTTP, or two programs that never call each other at all and are coupled only
through a file on disk. Once linked, the seam between them shows up in
`trace_contract` and `path_between` as if they were one workspace.

**Both contract kinds are re-inferred across the union**, not just wires. The link
writes up to two drafts into EACH graph's own out-of-source
`<project>/.wiregraph/inferred/` (never into your `contracts/`):
`wiregraph-inferred.asyncapi.yaml` for **wire** seams — a route or topic both repos
name literally — and `wiregraph-inferred.resource.yaml` for **resource** seams — a
file/sentinel path, DB table, shared-memory region or named pipe both repos name
through the same shared CONSTANT, joined writer→reader. So a pair of repos whose only
coupling is a shared constant is exactly as linkable as a pair that share a route.
These specs are unscoped by construction, which is what keeps a cross-member seam
matching in every subtree of both sides.

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
   **Linked:** heading), then `trace_contract` on whichever kind was inferred:
   - a **wire** seam → trace the shared route/topic and show the producer→consumer link;
   - a **resource** seam → trace the shared constant and show the writer→reader link,
     with no call edge between the two sides. Read out that the inferred draft lists
     every compartment as BOTH writer and reader — nothing in the code says which side
     writes — so the user prunes each list in
     `<project>/.wiregraph/inferred/wiregraph-inferred.resource.yaml` before trusting
     the direction.

   Summarize what was linked and which seam kinds appeared.

Note: a seam fires only on a token both sides name the SAME way. For a wire that means a
distinctive literal route/topic (`/api/logs` written literally in each repo) — not a
dynamically-built URL and not something generic like `/health`. For a resource it means
the shared CONSTANT NAME (`GAME_STATE_PATH`), never the path literal it holds: wiregraph
is deliberately literal-blind, so a repo that only ever writes
`'/var/run/game/state.json'` is missed by design. If `trace_contract` shows nothing,
check that the route is a literal string, or that the constant is named, on BOTH sides.
Cross-member seams are a full-rebuild product, so they refresh on rebuild/`link`, not on
a single edit.
