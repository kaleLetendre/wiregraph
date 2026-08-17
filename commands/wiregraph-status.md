---
description: wiregraph doctor — check the project's graph, freshness, the directive, and the auto-update posture
argument-hint: "(no args — checks the active project)"
allowed-tools: Bash, Read
---

Diagnose wiregraph for the active project and give a one-line fix for anything
that's off. **Target** = `${CLAUDE_PROJECT_DIR}` or cwd; call it `<TARGET>`.

Do the steps in order:

1. **Run one READ tool first — before `graph_status`.** Call `find_symbol` with any
   symbol name you expect this project to have. The answer is irrelevant; what matters is
   that a read tool ran. The self-heal (re-index the files that changed since the last
   index) fires only inside a READ tool — `find_symbol`, `get_source`, `trace_*`,
   `path_between` — and it is the read tool's FAILURE that sets the flag `graph_status`
   reports as `SELF-HEAL FAILING`. `graph_status` does not self-heal and never sets that
   flag; it only prints one another tool already set, in the same server process. So a
   session that calls `graph_status` first can never see the failure this command exists
   to catch, and the graph would be reported healthy while every read served pre-edit
   code.

   - answer is prefixed `⚠ wiregraph could NOT re-index your changed files` → the
     self-heal is failing. The reason follows on the same line; step 2 prints it again
     and names which of the two causes it is. Do not stop here.
   - anything else → the self-heal is working; carry on.

2. **Graph health + freshness.** Call the `graph_status` MCP tool. It reports whether
   this project is indexed (counts), the last full build, the auto-update posture, the
   compartment **mode**, and whether any file's on-disk content differs from what was
   indexed (the read tools self-heal these on demand, so "stale" here is informational).
   Map its output to a fix:

   - `No wiregraph for this project` → run `/wiregraph-init`
   - `schema is v… but this version expects v…` → run `/wiregraph-rebuild`
   - `schema is v…, NEWER than this plugin` → update the plugin via `/plugin`; do **NOT**
     rebuild — that downgrades the graph and loses data
   - `STALE: N changed source file(s)` → run `/wiregraph-update`
   - `⚠ LAST BUILD DROPPED GRAPH CONTENT:` → the last build refused part of the graph, and
     the indented lines under it name exactly what: a spec skipped on a title collision, a
     dropped resource id, a compartment named in a spec's role list that does not exist, or
     the WIRE fan-out cap. This is the one finding that coexists with `Fresh:` — the graph
     is up to date AND knowingly incomplete, so a trace over the missing part reads clean.
     Relay those lines verbatim, fix the cause (usually a spec edit), then run
     `/wiregraph-rebuild`. The full list for that run is in `<TARGET>/.wiregraph/refresh.log`.
   - `SELF-HEAL FAILING:` → the read tools could not re-index the user's changed files,
     so every `find_symbol`/`trace_*` answer may predate their edits. The message names
     the cause; both causes are fixed by `/wiregraph-rebuild`:
     the declared/inferred **partition** changed since the last full build, or **the
     contract specs in force changed since the last full build** (a spec added, deleted,
     moved between contracts dirs, or retitled — this one fires in GLOBAL mode too).
   - `Fresh:` → nothing to do

   If the MCP tool itself is unreachable, dependencies may not be installed:
   `npm install --prefix ${CLAUDE_PLUGIN_ROOT} --legacy-peer-deps`.

3. **Report the `Mode:` line as-is.** `global` means compartments are inferred from
   `.git` / build manifests; `recursive` means they are DECLARED in
   `<TARGET>/.wiregraph/state.json` and the line names them. Mostly it is not a health
   check — there is nothing to fix — but it is what makes a compartment name in any other
   output readable, and on a recursive project a subsystem the user expected to see is
   usually one that was never declared. Mode is changed only by `/wiregraph-teardown` +
   `/wiregraph-init`. Two variants ARE actionable, and both mean the graph is not what
   the user thinks:

   - `recursive — but the DECLARATION IS UNUSABLE` → state.json still holds a
     declaration, but the build refused it (a declared directory renamed or deleted on
     disk, or a hand edit that broke it) and partitioned on INFERRED compartments
     instead. The line names the exact problems. Every compartment name the user has in
     mind is therefore absent from the graph. Fix: restore the missing directory then
     `/wiregraph-rebuild`, or re-declare via `/wiregraph-teardown` + `/wiregraph-init`.
   - `A FULL REBUILD IS PENDING` → the graph was built against a different partition
     than the one in force now, so the compartments the line names are not the ones the
     db holds. Fix: `/wiregraph-rebuild`. This appears on global projects too — a new
     manifest appearing in a subdirectory re-partitions a project with no declaration
     involved.

4. **Directive present?** Check whether the navigation directive is installed in
   `<TARGET>/CLAUDE.md` (look for the `BEGIN wiregraph (managed)` sentinel). If
   absent, the token win is reduced — suggest re-running `/wiregraph-init` (its
   directive-install step) to install it.

5. **State + posture.** Show the state file so the user can see posture and shas:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs show "<TARGET>"
   ```

   Remind them posture is changeable with
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs posture "<TARGET>" <off|conservative|balanced|aggressive>`.

6. **Hooks firing?** From the state in step 5, read `hooksLastFired` — the SessionStart
   hook stamps it every session it runs on an indexed project.
   - **absent / `null`** → If the user *just* ran `/wiregraph-init` this session, that's
     expected (SessionStart ran before the graph existed; it'll stamp on the next
     session) — say so, don't alarm. But if it stays absent across sessions, the
     plugin's hooks are NOT firing in this Claude Code: no SessionStart catch-up, no
     navigation nudges, no re-index-on-edit — the graph only self-heals on MCP reads,
     so heavy editing drifts silently. Tell them to enable the plugin's hooks (or add
     them to `<TARGET>/.claude/settings.json`) and to run `/wiregraph-update` after big
     edits until then.
   - **present** → note "hooks active (last SessionStart: `<hooksLastFired>`)".

7. **Recent background refreshes** (optional): if `<TARGET>/.wiregraph/refresh.log`
   exists, show the last few lines so the user can see auto-updates are running.

8. **Measured impact** (optional): if `<TARGET>/.wiregraph/metrics.jsonl` exists,
   point the user to **`/wiregraph-stats`** — the dedicated, deterministic
   dashboard of graph-tool usage, estimated tokens saved, and the adoption gap
   (it explains how the numbers are projected). Don't recompute it here.

9. **Contract coverage**: from the state shown in step 5, read `inferredSeams` (the
   cross-compartment seams — messaging/state/HTTP — the last full build detected) and
   both `contractsDir` and `contractsDirs`. Every full build stamps the whole discovered
   list into the plural, and in recursive mode that list is the interesting one — several
   dirs, one per governed subtree, none of which is "the" one.

   **Judge on whether a recorded dir actually HOLDS A SPEC, not on whether one exists.**
   That is `uncoveredSeams(state)` (`scripts/lib/state.mjs`), which is also the gate the
   SessionStart hook uses. A `contracts/` directory that is deliberately empty — the
   correct state under the architecture recursive mode implements, where a contract is not
   written before the code it describes — must not read as coverage, or the projects
   following that architecture most carefully are the ones that never get told.
   - `uncoveredSeams(state) > 0` — those seams aren't captured yet; recommend
     `/wiregraph-contracts` to draft contracts for them.
   - it returns 0 while seams exist — coverage is in place (nothing to do). In recursive mode also
     report how many dirs and what each governs, which is what `graph_status`'s `Mode:`
     line spells out (`contracts SCOPED to N dir(s): …`).

Summarize the health as a short checklist with any fixes needed.

Note: `graph_status` is a REPORT, not a repair — nothing in this command repairs anything
except a fix you run because a line above told you to, and every one of those is
`/wiregraph-init`, `/wiregraph-update` or `/wiregraph-rebuild`. The one write that does
happen is step 1's, and it is the point of the step: a read tool re-indexes the files that
changed since the last index, which is either the ordinary self-heal succeeding or the
refusal this command is here to surface.
