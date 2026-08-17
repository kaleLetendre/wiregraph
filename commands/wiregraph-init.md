---
description: Initialize wiregraph for a project — build the graph, install the directive + auto-update, and start using Claude at ~50% fewer tokens
argument-hint: "[target-dir] [--no-directive] (target defaults to the current project root)"
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

Set up wiregraph for a project end to end: install dependencies, build the
cross-compartment call graph into an embedded SQLite file, install the proven navigation
directive into the project's CLAUDE.md, and turn on auto-update. After
this, just use Claude normally — code navigation/audit/refactor questions cost
~40–60% fewer tokens. There is no daemon, JVM, or background server.

**Target directory:** use `$1` if provided, else `${CLAUDE_PROJECT_DIR}` if set,
else the current working directory. Call this `<TARGET>` below and use the
realpath.

This is also the ONLY command that sets the compartment **mode** (global or recursive),
so "re-initialize" is a real answer to a real question, not a redundant re-run.

Do the steps in order; stop and report if a step fails.

1. **Detect an existing setup and reroute if needed.** Before anything else, check
   whether `<TARGET>` (or a parent workspace) is already indexed:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs check "<TARGET>"
   ```

   - `indexed: no` → this is a fresh setup; go to step 2 and do everything below.
   - `indexed: yes` and `db: missing` → the graph was never built or was deleted. Don't
     ask: call the `update_graph` MCP tool with `{ "full": true }`, report the new stats,
     and stop.
   - `indexed: yes` and `db: present` → wiregraph is already set up here. The `root:`
     line shows where; `sameDir: no` means an ancestor workspace is what's indexed, not
     `<TARGET>` itself. Ask before doing anything — see below.

   **Read the current mode before you ask**, so the question can name it:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/compartments.mjs show "<TARGET>"
   ```

   Its `mode:` line says `global` or `recursive`; a recursive project also prints
   `IN FORCE: yes` or `IN FORCE: NO`.

   **`indexed: yes` does NOT mean "nothing to set up".** `/wiregraph-teardown`
   deliberately leaves `.wiregraph/` in place so re-init is instant, so a user who just
   tore the project down *in order to switch modes* arrives here reading `indexed: yes` /
   `db: present`. That user needs **Re-initialize**; a rebuild would silently regenerate
   the graph in the mode they are trying to leave and never reach the mode question at
   step 5. If the user's request mentions the mode, `recursive`, declared compartments,
   the scope, or the directive AT ALL, say that plainly and recommend Re-initialize.

   Then ask with AskUserQuestion (never silently re-run the full setup, and never
   silently rebuild):

   - **Re-initialize** — the only answer that reaches the mode, scope and compartment
     questions; take it to CHANGE THE MODE (global ↔ recursive), re-declare compartments,
     change the indexed scope, or reinstall the directive. Continue with step 2.
   - **Rebuild** — regenerate the graph from scratch **in the mode it already has**: call
     `update_graph` with `{ "full": true }` (equivalent to `/wiregraph-rebuild`), report
     the new stats, and stop. Right after refactors/renames or a stale/wrong graph, and
     only when nothing about the setup is changing.
   - **Update** — incremental catch-up only: call `update_graph` with no args, report,
     and stop. Cheapest when little has changed.

2. **Install dependencies (idempotent, one-time).** Pulls the WASM SQLite store
   (`sql.js`) and the tree-sitter parsers — toolchain-free (nothing is compiled:
   sql.js is WebAssembly bundled in the package, tree-sitter ships prebuilt
   binaries). A clean install is ~1 s and needs only Node:

   ```
   npm install --prefix ${CLAUDE_PLUGIN_ROOT} --legacy-peer-deps
   ```

   If this is the FIRST run right after installing the plugin from a marketplace,
   the wiregraph MCP server started before these deps existed, so its tools aren't
   available yet. After this install completes, tell the user to run
   `/reload-plugins` (once) so the MCP server restarts with the deps present — then
   the `find_symbol`/`trace_*`/etc. tools come online for the rest of the steps.

3. **Confirm scope.** wiregraph indexes every **compartment** under `<TARGET>` — a
   compartment is a git repo OR a package/module with its own manifest, so one repo
   can hold several. List what it would cover and confirm the scope is what the user
   meant (prevents the two footguns: indexing one compartment when they meant the
   workspace, or pointing at a huge tree like `$HOME`):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workspace.mjs repos "<TARGET>"
   ```

   **Read what is printed ABOVE that report first.** The scope lines go to stdout, but the
   compartment walk warns on stderr, so a rename you have to relay appears above the list:

   - `wiregraph: ⚠ COMPARTMENT NAME COLLISION under <root>`, then
     `"network" was claimed by 2 directories, now indexed as:` and one indented
     `- client/network   [<dir>]` per directory → two or more directories share a basename
     (`client/network` and `server/network`), so wiregraph **renamed** the colliding ones to
     their path-relative form to keep the partition correct — a compartment id is its NAME
     ALONE, so same-named compartments would otherwise collapse into one row and
     `get_source` would read the wrong file. Those renamed names are the compartment names
     now IN THE GRAPH and are exactly what the list below prints, so never show
     `client/network` as a compartment without saying why it is spelled that way. **Relay
     the consequence the warning states:** any hand-written contract spec naming the bare
     basename in `x-wiregraph-producers` / `x-wiregraph-consumers` (or a resource `writers:`
     / `readers:` list) no longer matches, and that seam goes dark — no error, no warning.
     Give both fixes: update those specs to the printed names, or **declare the compartments
     explicitly** (recursive mode, step 7), which lets the user pick the names instead of
     taking wiregraph's path-relative ones.
   - no such block → nothing was renamed; every compartment name is its directory's
     basename.

   Then read the `scope:` line and act:
   - `scope: MULTI` — 2+ compartments (a monorepo of packages, or repos side-by-side), so
     cross-compartment contracts are possible. Show the compartment list and confirm
     it's the intended set — and if the collision block appeared, say which of those names
     are renames rather than basenames.
   - `scope: SINGLE` — one compartment. **Report the count and move on; do not offer to
     re-point init at the parent folder yet.** That advice is right in global mode and
     wrong in recursive mode: a plain source tree split into subsystems with no manifest
     of its own reports SINGLE *by construction*, and it is the exact layout recursive
     mode exists to serve. The parent-folder question belongs to step 5, after the mode
     is settled.
   - `scope: NO-GIT` — the whole folder would be indexed as one unit (fine for a lone
     non-git project). Same rule: report it, decide at step 5.

   This count is **pre-declaration** and is not the last word. In recursive mode the
   declaration IS the partition, so step 7 re-runs this command and that later number is
   the one step 9 keys on.

4. **Detect the existing contracts structure — before you ask about the mode.** Which
   mode fits is mostly answered by how the repo already organizes its specs, so look
   first:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workspace.mjs contracts-dirs "<TARGET>"
   ```

   Use that command, not a hand-rolled `find`. It applies the engine's OWN rule —
   `isContractsDirName` is case-INSENSITIVE (`Contracts/` counts) and the scan skips every
   directory the walk skips (`node_modules`, `vendor`, `target`, `dist`, `build`, `.venv`,
   …). A `find -name contracts` disagrees on both counts: it classifies `Contracts/` as
   **none** and asks the mode question on a false premise, and it counts a `contracts/`
   buried under `target/` or `vendor/` as **nested** when the build will never load it.

   Classify on the `structure:` line, which is the classifier — **not** on the `dirs=`
   count beside it. The rule is DEPTH, not how many:
   - `structure: none` — no contracts dir anywhere under `<TARGET>`.
   - `structure: root-only` — every contracts dir found is `<TARGET>` itself or an
     IMMEDIATE child of it (`contracts/`, `asyncapi/`, `wire-contracts/`).
   - `structure: nested` — at least ONE contracts dir sits DEEPER than an immediate
     child, e.g. `server/contracts/`. One such dir on its own is enough: a lone
     `server/contracts/` reports `nested (dirs=1)`, and `server/contracts/` +
     `client/contracts/` — two dirs at the SAME depth — reports `nested (dirs=2)`.
     Neither `dirs=1` nor "same depth" makes a layout root-only.

   Say the classification back to the user in those terms when step 6 needs to explain a
   mismatch — it is the definition the script actually applied.

5. **Ask for the mode** (AskUserQuestion). This is the only place mode is ever set.
   Explain both in the user's terms and what each buys:

   - **Global (recommended)** — wiregraph works out the compartments itself, so there is
     nothing to maintain: a `.git` dir, or a manifest that DECLARES a module, marks a
     boundary, and each file belongs to its nearest one. (Declaring a module is what
     counts, not the filename — a Cargo virtual manifest, `[workspace]` with no
     `[package]`, is not a boundary, and neither is a `pyproject.toml` carrying only
     tool config.) Right for a single repo, a normal monorepo, or repos side-by-side.
   - **Recursive** — you declare the compartments yourself and contracts dirs are scoped
     per subtree, so boundaries that no manifest marks become real; it costs maintenance
     (add a directory, remember to declare it).

   Spell the recursive half out concretely, because it is what changes what a trace
   MEANS. You **declare** the compartments explicitly in `<TARGET>/.wiregraph/state.json`
   and that declaration IS the partition — the `.git`/manifest inference is not consulted
   at all. AND contracts dirs are found at **any depth**, each **scoped to its parent's
   subtree**: `server/contracts/` governs communication between the things under
   `server/` and matches code nowhere else. In **global** mode there is one flat contract
   namespace instead: every spec under the depth-1 contracts dir matches every file in
   the project. In **recursive** mode a route named in `client/contracts/` cannot match
   code under `server/`, and when an outer and an inner spec declare the SAME route the
   inner one owns it inside its subtree (nearest ancestor wins, exactly as compartment
   attribution does) — so that route reports as one-sided on the outer contract. That is
   deliberate: two contracts claiming one route is a real ambiguity, and the fix is a
   distinct route or a single contract, not a silent double-count.

   Recommend **global** for anything existing or simple. Say plainly that **switching
   modes later means `/wiregraph-teardown` + a fresh `/wiregraph-init`**: the compartment
   name is part of every node id, so changing the partition invalidates the whole graph
   anyway.

   **If the answer is GLOBAL and step 3 reported `scope: SINGLE`**, ask now (the question
   deferred from step 3) whether the user meant the **parent** folder — related
   repos/packages side-by-side under one parent, with `/wiregraph-init` run there.
   Cross-compartment contracts need 2+ compartments, and in global mode a single
   compartment cannot grow more without moving the target. Proceed with the single
   compartment only if they confirm. Do NOT ask this if the answer was recursive: there
   the declaration supplies the compartments, and re-pointing at the parent would index
   the wrong tree.

   **If the answer is GLOBAL, clear any existing declaration — this is what makes the
   "teardown + re-init" promise true.** `/wiregraph-teardown` deliberately leaves
   `.wiregraph/` intact so re-init is instant, which means a project that was previously
   recursive still carries `mode: recursive` and its old compartment list. Without this
   step the build would keep partitioning on that stale declaration and step 15 would read
   back `Mode: recursive` after the user answered global:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/compartments.mjs clear "<TARGET>"
   ```

   Run it only when `<TARGET>/.wiregraph/state.json` exists (on a brand-new project it
   reports `No state at <TARGET> — nothing to clear.` and exits non-zero — not an error
   worth relaying). Relay WHICH of its two outcomes happened; they are different facts:

   - it reports the declaration was **cleared** and that a full rebuild is required → the
     project really was recursive, the partition just changed under it, and step 10's
     `--reset` build is that rebuild. It leaves `compartmentsFingerprint` alone ON PURPOSE:
     the stale stamp is what makes any later incremental refuse rather than build against
     the old partition. Report that the declaration was dropped.
   - it reports there was **nothing to clear** → the project was already global; nothing
     changed. Say that in one clause and move on. Do not repeat the rebuild wording from
     the other branch — no partition moved, so nothing is owed to it.

6. **Reconcile a structure/mode mismatch — never proceed silently.** If step 4's
   `structure:` line and the mode chosen at step 5 disagree, name the mismatch in one
   sentence and offer BOTH ways out with AskUserQuestion:

   - `structure: nested` with **global** chosen — the sharper of the two: only the depth-1
     contracts dir is discovered at all, so every nested spec is simply **never loaded**
     and its seams stay dark.
   - `structure: root-only` or `structure: none` with **recursive** chosen — harmless:
     there is no nesting for the declaration to mirror, and the single root contracts dir
     scopes to `<TARGET>` and therefore governs everything, exactly as global would.

   The two answers:
   - **Continue in the selected mode** — the structure can move later.
   - **Switch to the other mode** — go back to step 5 with the other answer.

7. **Declare the compartments (recursive only).** Work out what they are and propose
   them; this is a judgement you are making on the user's behalf, so show it before you
   write it. Skip this step entirely in global mode and go to step 9.

   Seed the proposal from what you already have:
   - the compartment list printed by `workspace.mjs repos` at step 3;
   - every directory that holds a `contracts/` from step 4 — and read the tree level
     correctly. A nested contracts dir governs **its own parent's subtree**, so
     `server/contracts/` governs what is UNDER `server/` — `server/ecs`, `server/sim`,
     `server/network` — and NOT `server`'s siblings `client/` and `harness/`. The
     candidates a contracts dir points at are therefore the CHILDREN of the directory
     holding it, not that directory's siblings;
   - a read of the tree's top two or three levels for the obvious subsystem split.

   Name each compartment after its directory unless that name is already taken elsewhere
   in the tree — names must be unique, since a compartment id is the name alone.

   Show the proposed list as `path -> name` pairs and **ask** (AskUserQuestion):
   - **Declare these** — writes the declaration and re-partitions the graph;
   - **Let me adjust** — take the user's edits and re-propose before writing;
   - **Switch to global** — abandon the declaration and go back to step 5.

   Ask rather than guess whenever the split is not obvious — a wrong declaration is not a
   silent approximation, it re-partitions every symbol in the graph.

   On approval, write it (paths are RELATIVE to `<TARGET>`):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/compartments.mjs declare "<TARGET>" '[{"path":"server/ecs","name":"ecs"},{"path":"client/network","name":"client_network"}]' --new
   ```

   `--new` is what lets this run on a project that has no `.wiregraph/` yet. It is for
   init and nothing else: a bare `declare` on an unindexed directory would leave a
   half-configured footprint (mode set, no graph, never built) that later tooling reads as
   a real indexed workspace. Here it is safe because step 10 builds immediately.

   The command validates before it writes and REJECTS the declaration outright — writing
   nothing, printing `compartments: REJECTED —` — if two compartments would share a name
   (including a name equal to `<TARGET>`'s own basename, which is the fallback compartment
   every undeclared file lands in), if a path is under a directory wiregraph never walks,
   if a path doesn't exist or isn't a directory, if a path is reached through a SYMLINK
   (the walk cannot descend into one, so the compartment would always be empty), or if a
   path is absolute or escapes `<TARGET>`. Relay the rejection verbatim, fix the list with
   the user, and re-run. Use `compartments.mjs validate "<TARGET>" '<json>'` to dry-run.

   These are the SAME rules the build applies when it reads the declaration back, so
   nothing that is rejected here can reach the graph by a later hand edit of
   `state.json` — a declaration the build refuses is IGNORED WHOLESALE and the project
   falls back to inferred compartments with a loud warning, never honoured in part.
   `compartments.mjs show "<TARGET>"` prints whether the stored declaration is actually
   `IN FORCE: yes`.

   Then **report exactly what was written** — the file, and every `name [path]` pair the
   command echoed back. Also relay its closing note: declaring compartments
   **invalidates previously inferred contract specs**, because those specs record
   compartment NAME strings and are string-matched against each symbol's compartment. Any
   declared name that differs from the name the walk had been using leaves the old spec
   pointing at a compartment that no longer exists — the seam does not error, it goes
   dark. That is exactly why step 9 re-runs inference before the build.

   Finally, **re-run the scope report** — the declaration is now the partition, so this is
   the first run that reports the real compartment count:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workspace.mjs repos "<TARGET>"
   ```

   A recursive project typically flips here from `scope: SINGLE (compartments=1)` to
   `scope: MULTI (compartments=N)`. Report the new line; it is what step 9 keys on.

8. **Check every nested spec has a DISTINCT `info.title` (recursive + `structure: nested`
   only).** A contract's id is its title and nothing else, so two specs sharing one are
   ONE contract node whose scope covers both subtrees — which silently undoes the scoping
   the user just opted into. The build refuses to merge them (it keeps the outer spec,
   skips the inner one, and logs a warning naming both files by full path), but the inner
   spec's channels are then simply gone, so it is far better caught now:

   ```
   grep -rn "^[[:space:]]*title:" --include="*.asyncapi.yaml" --include="*.asyncapi.yml" --include="*.resource.yaml" --include="*.resource.yml" "<TARGET>"
   ```

   **Quote every `--include` glob.** Unquoted, zsh — the user's shell — tries to expand
   `--include=*.asyncapi.yaml` itself, fails with `no matches found`, and the command
   never runs: exit 1, ZERO output, which is indistinguishable from "no duplicate titles".

   - **Output lines, all titles distinct** — nothing to do; say so in one clause and move
     on.
   - **A title repeats across two different contracts dirs** — name both files and the
     shared title, and offer to rename one (`info.title` for AsyncAPI, top-level `title:`
     for `*.resource.yaml`). Titles are display names, so renaming is safe; suggest one
     that names the subtree, e.g. `Server Internal Wire` / `Client Internal Wire`.
   - **A title repeats WITHIN one contracts dir, or between `contracts/` and
     `.wiregraph/inferred/`** — leave it alone. Those two govern the same territory, so
     the build MERGES them on purpose (that is how a hand-applied draft and the
     link-inferred copy coexist), and "fixing" it would split one contract in two.
   - **NO output at all** — do not read this as "all distinct". It also means the command
     failed, or that there are no spec files. Check the count against the dirs step 4
     listed before concluding anything.

   Don't build yet — infer contracts first (step 9) so a single build produces the
   call graph AND the contract edges in one pass (no redundant second build).

9. **Infer cross-compartment contracts (2+ compartments only) — before the build.** Use
   the LAST `scope:` line you obtained: step 7's re-run in recursive mode, step 3's
   otherwise. If it reports `scope: MULTI`, run the contract inference now, *before*
   building, so the applied spec is on disk when the single build runs — no separate
   command, no rebuild. **Skip this step entirely** on `scope: SINGLE` or `scope: NO-GIT`
   (no cross-compartment seams to find) and go straight to step 10.

   a. **Scan (no writes)** and show the user the proposed seams + draft specs:

      ```
      node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs scan "<TARGET>"
      ```

   b. **Branch on the scan's LITERAL output, and read it to the END.** It always prints the
      WIRE block first and the RESOURCE block second, and an EMPTY block is ten lines of
      explanation, not one — so the first line is never the whole answer. A recursive
      project routinely opens with `No cross-compartment WIRE seams to infer.`, ten lines of
      common reasons, and only then `Found 1 cross-compartment RESOURCE seam(s):`. Branching
      on that first line skips the write and loses the resource spec.

      - `No cross-compartment WIRE seams` **and** `No cross-compartment RESOURCE seams` →
        nothing was found. Say so and go to step 10 — nothing to write. (Common when
        compartments are indexed together but don't share a route / topic / env var / named
        constant yet.)
      - `Found N cross-compartment seam(s)` → wire seams, followed by the draft AsyncAPI
        spec. Go to 9c.
      - `Found N cross-compartment RESOURCE seam(s)` → resource seams, followed by the draft
        `*.resource.yaml`. Go to 9c.
      - **MIXED — one block says `Found N …` and the other says `No cross-compartment …
        seams`.** This is the ordinary case, and it counts as FOUND: go to 9c. Show the
        block that found something and do not read the other block's explainer as the
        verdict.
      - `Seams considered and NOT proposed` / `Named constants considered and DECLINED` →
        the tail of either block: everything the scan deliberately did not propose, with the
        reason for each. Nothing is dropped silently, so read these back when the user asks
        why theirs was not proposed.

   c. **If either block found seams**, ask with AskUserQuestion whether to write the draft
      contract(s), making clear it's a heuristic starting point the user owns and should
      review/commit:

      - **Write the draft(s)** — they land in the contracts home and step 10's build lights
        up their edges in the same pass;
      - **Not now** — nothing is written; the seams are still reported, and
        `/wiregraph-contracts` re-scans any time.

      On decline, go to step 10.

   d. **On yes**, write the draft (no build here — step 10 picks it up):

      ```
      node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs apply "<TARGET>"
      ```

      If a `*.resource.yaml` was written, say that its writer/reader roles are
      UNRESOLVED — every compartment is listed on both sides and the user prunes them —
      and that pruning is all that is required to own it: authorship is decided by
      CONTENT, so a spec whose roles are no longer the machine's all-both placeholder is
      treated as hand-written and a later `/wiregraph-contracts apply` will not overwrite
      it. Prune `writers:` BEFORE adding `single_writer: true`, or it reports an immediate
      violation against a placeholder.

10. **Build the graph — once.** Full, project-scoped, into `<TARGET>/.wiregraph/graph.db`.
    If step 9 wrote a spec, this single build auto-detects it and produces the call
    graph AND the cross-compartment contract edges in the same pass (that's why the
    build comes after inference — it avoids a second full walk of the workspace):

    ```
    node ${CLAUDE_PLUGIN_ROOT}/src/build.js "<TARGET>" --reset
    ```

    Report the printed stats (compartments, files, symbols, contracts, edge counts). If
    a spec was applied in step 9, confirm the seams lit up with the `trace_contract` MCP
    tool and report the cross-compartment edge counts now in the graph. You don't need a
    contract name to do that: call `trace_contract` with `contract` **omitted, or empty
    (`""`)** and it lists every contract in the graph with its kind and token count, then
    call it again with a substring of the one you want for its per-token detail.

11. **Seed state + gitignore the footprint.** Everything wiregraph writes per project
    lives in one hidden folder `<TARGET>/.wiregraph/` (`graph.db`, `state.json`,
    `refresh.log`). Run this **after** the build so `lastFullBuild` reflects it. It
    seeds the state (build time, per-repo git shas for incremental catch-up) AND adds
    `.wiregraph/` to `<TARGET>/.gitignore` so the indexed graph + machine-local state are
    never committed:

    ```
    node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs seed "<TARGET>"
    ```

    - `Seeded … (posture: <value>, N repos).` → **report `<value>` verbatim.** The
      command KEEPS whatever posture the state file already had and defaults to
      `balanced` only for a state file that did not exist. A project that was torn down
      (teardown sets `off`) and re-initialized comes back on `off`, and telling the user
      hooks are on when the script just printed `posture: off` is the difference between
      a graph that self-updates and one that silently does not. If it printed anything
      other than `balanced`, say so and offer to set it:
      `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs posture "<TARGET>" balanced`.
    - `.gitignore: added .wiregraph/` / `.wiregraph/ already ignored` /
      `no .git here — skipped` → relay which one happened.

    Then report the **mode** this project is now on: `global` (compartments inferred from
    `.git` / build manifests) or `recursive` with the declared compartments named. If it's
    recursive, add that the declaration lives in `<TARGET>/.wiregraph/state.json`, that
    adding a new subsystem directory later means declaring it too, and that any change to
    the declaration requires a full rebuild — wiregraph detects a changed declaration and
    escalates to one rather than applying an incremental update against the old partition.

12. **Install the navigation directive** into `<TARGET>/CLAUDE.md`. This managed block
    is the *mechanism* that makes Claude prefer the graph — it's the source of the token
    win, not an optional add-on — so it's part of setup: **install it directly, do NOT
    prompt Add/Skip.** Running `/wiregraph-init` is the opt-in; asking again here only
    invites leaving the graph silently degraded.

    ```
    node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/claudemd.mjs apply "<TARGET>"
    ```

    Then, so the edit is never a surprise, report what changed: the managed wiregraph
    block was appended to `<TARGET>/CLAUDE.md` (only between its sentinels — the rest of
    the file is untouched), and it's removable any time with `/wiregraph-teardown` or
    `/wiregraph-remove`. To see the exact block, `claudemd.mjs diff "<TARGET>"`.

    **Opt-out:** if the invocation included **`--no-directive`** (for users who
    hand-manage their CLAUDE.md), skip the write entirely and say so — note the MCP tools
    still work, but the token win is weaker without the directive.

13. **Auto-update / hooks.** The plugin ships `SessionStart`, `PreToolUse`, and
    `PostToolUse` hooks; they fire automatically whenever the wiregraph plugin is
    enabled. `SessionStart` catches up on out-of-session changes (and re-asserts
    the directive), `PreToolUse` on `Grep`/`Glob`/`Read` reminds Claude to prefer
    the graph (rate-limited per session so it stays cheap; the `Read` nudge only
    fires on a full read of a sizable source file), and `PostToolUse` re-indexes
    edited files. What they actually do is decided by the posture step 11 PRINTED —
    quote that value, don't assume `balanced`:
    - `off` — hooks do nothing (no catch-up, no navigation nudge, no re-index on edit)
    - `conservative` — SessionStart catch-up + the search/read navigation nudge
    - `balanced` (the default for a NEW state file) — + re-index each file Claude edits
    - `aggressive` — + (optional) repo git post-commit/post-merge hooks

    Tell the user which of those four they are on and that they can change it with
    `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs posture "<TARGET>" <value>`.
    If the user's Claude Code does not auto-run plugin hooks, they can enable them
    explicitly in `<TARGET>/.claude/settings.json` (offer this only if asked).

14. **Offer to re-establish prior links.** A previous `/wiregraph-remove` or
    `/wiregraph-unlink` may have torn down cross-repo links this graph had — wiregraph
    remembers them in a tombstone that survives the removal. Check for any (peers that no
    longer exist are already filtered out):

    ```
    node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs former-links "<TARGET>"
    ```

    - **No output** → nothing remembered; skip to the next step.
    - **One or more peer paths** → ask with AskUserQuestion how to restore them, in the
      user's words: **All** (re-link every listed peer), **Some** (walk them one at a
      time, asking per peer), or **None** (restore nothing). Never re-link silently.

      For each peer the user chooses, re-link it with `<TARGET>` as SELF:

      ```
      CLAUDE_PROJECT_DIR="<TARGET>" node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs link "<PEER>"
      ```

      Relay each result; a peer that fails the guard (gone, or a basename collision) is
      reported and skipped, not fatal. Whatever the choice, clear the memory afterward so
      a future init doesn't re-ask:

      ```
      node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/links.mjs forget-links "<TARGET>"
      ```

15. **Confirm** by calling the `graph_status` MCP tool — its `Mode:` line is the
    authoritative read-back of what step 5 set, so check it matches what you reported. In
    recursive mode that line also names contracts dirs and the subtree each governs
    (`contracts SCOPED to N dir(s)`). **That N counts the HAND-WRITTEN contracts dirs across
    the whole indexed union — it is not the build's loaded-dirs count**, so two differences
    from what you saw earlier are expected and neither is a fault:
    - `.wiregraph/inferred/` (written by `/wiregraph-link`, not by the user) IS loaded by
      the build but is deliberately kept out of this line, because it is wiregraph's own
      output rather than the user's coverage. A linked project therefore reads
      `SCOPED to 3 dir(s)` while step 10's build logged `loaded … from 4 dir(s)`.
    - a LINKED member's contracts dirs are counted here but were never scanned by step 4,
      which only looked under `<TARGET>`.

    So compare against step 4 only for `<TARGET>`'s OWN dirs: a dir step 4 listed that is
    missing here is one the build never loaded and is worth chasing; a higher count here, or
    a higher `from N dir(s)` on the build line, is one of the two cases above.
    Then summarize: graph built (counts), **mode** (global, or recursive with the declared
    compartments and the scoped contracts dirs), directive installed (or declined), the
    posture the seed step printed, links re-established (if any), and that the wiregraph
    MCP tools (`find_symbol`, `get_source`, `trace_callers`, `trace_callees`,
    `trace_contract`, `path_between`, `graph_status`, `update_graph`, `query_sql`) are now
    queryable for this project.

Note: mode is set **here and nowhere else** — there is no `/wiregraph-mode` command and
no state CLI for it. Changing it later is `/wiregraph-teardown` (or `/wiregraph-remove`)
followed by a fresh `/wiregraph-init` answering **Re-initialize** at step 1, because
re-partitioning invalidates every node id. One project may contain several git repos,
indexed together under this single project; the links between their compartments flow
through Contract nodes — see `trace_contract` / `path_between`. Step 9 already infers
those contracts for a multi-compartment workspace, and the user can re-run
`/wiregraph-contracts` any time to re-scan and refine the drafts after the workspace
changes.
