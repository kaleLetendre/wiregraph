---
description: Remove a linked member from this graph — drops the reciprocal records from both graphs, rebuilds both over the reduced union, and offers to clean up an auto-created peer
argument-hint: "<linked-dir> (the member to remove; this graph is resolved from the cwd)"
allowed-tools: Bash, Read, AskUserQuestion
---

Remove a previously linked member from this project's wiregraph. Like `/wiregraph-link`,
this is **mutual**: it drops the reciprocal record from *both* graphs and rebuilds
*both* over the reduced union, so the wire seam between them disappears cleanly (no
orphan contracts or WIRE edges left behind — unlink is a full-reset rebuild, not a
surgical delete).

**Target:** `$1` — the linked directory to remove. Call it `<TARGET>`. The near
graph (**SELF**) is resolved from `${CLAUDE_PROJECT_DIR}` / cwd.

Do the steps in order:

1. **Preview (no writes):**

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs unlink-preview "<TARGET>"
   ```

   This shows both graphs will rebuild and the seam goes away. If `<TARGET>` was
   **auto-created** by the original link and would be left with no other members,
   the preview flags that its whole graph can be removed.

2. **Confirm** with AskUserQuestion (both graphs rebuild; the seam is lost). On
   decline, stop.

3. **Unlink:**

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs unlink "<TARGET>"
   ```

4. **Auto-created-peer cleanup.** If the output contains a line
   `PEER_CLEANUP_ELIGIBLE: <path>`, the peer graph was auto-created by the original
   link and now has no members. Ask the user (AskUserQuestion, default **yes**)
   whether to fully remove that auto-created graph. On yes:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remove.mjs "<path>"
   ```

   If the peer **pre-existed** (no such line), leave its folder untouched — only its
   link record was stripped.

5. Report what was unlinked and confirm with `graph_stats` (the member is gone).
