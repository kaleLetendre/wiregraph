---
description: Infer cross-compartment contracts from code — wire seams (shared routes/topics) and resource seams (shared files, tables, pipes) — and write draft specs, so wiregraph can trace how your services connect
argument-hint: "[target-dir] (defaults to the active project)"
allowed-tools: Bash, Read, AskUserQuestion
---

Discover the **seams** between compartments in this workspace and propose the
**contracts** that link them, so `trace_contract` / `path_between` can follow the
connection across compartments. wiregraph reads these seams out of the code; you don't
have to hand-write specs. Two kinds are inferred, and a scan reports both:

- **Wire seams** — endpoints one compartment defines and another calls (shared HTTP
  routes and message topics) → a draft **AsyncAPI 3.0** spec, producer→consumer.
- **Resource seams** — a file or sentinel path, a DB table+key, a shared-memory region,
  a named pipe that two compartments both touch, joined by the **shared constant** that
  names it → a draft **`*.resource.yaml`** spec, writer→reader. There is no request/reply
  here: a writer creates or updates the resource and readers observe it.

**There is a THIRD contract type and it is NOT inferred — say so before the user waits for
a draft that never arrives.** An **in-process contract** (`*.inproc.yaml`) joins two
compartments in ONE process across a crate or module wall, on the **exported symbol names**
that cross it (`World`, `Scheduler`), with roles **provider → consumer**. `scan` and
`apply` know nothing about the format: they will never propose one, never mention one, and
`apply` never writes one. It is **hand-written only** — step 7 has the format. If the user
came here for an `ecs` ↔ `sim` style seam between two crates in one binary, jump straight to
step 7; the scan has nothing to say about it and a scan that reports no seams is not
evidence that there is nothing to write.

A contract is just **the defined communication between two compartments**. (A compartment
is a package/module or repo; see
<https://kaleletendre.github.io/wiregraph/contracts.html>.) The inference is a
**heuristic**: it's a draft to review and commit, not the truth.

**Target:** `$1` if provided, else `${CLAUDE_PROJECT_DIR}`, else cwd; call it
`<TARGET>`. The script resolves the indexed **workspace root** on its own, so this
is safe to run from inside a sub-repo.

Do the steps in order:

1. **If this graph was last fully built by an OLDER wiregraph, run `/wiregraph-rebuild`
   before anything else.** The guard that keeps contract edges honest is a fingerprint of
   the resolved spec set, stamped at each FULL build and compared on every incremental.
   An ABSENT stamp means "no baseline", never "changed" — deliberately, so upgrading does
   not force-rebuild every project on the machine — so on a project whose last full build
   predates the stamp there is **nothing to compare against and the guard does not fire at
   all**. Until the first full rebuild under the current version, an incremental will
   happily re-derive seams over rows minted under the old rules, and the symptom is
   `trace_contract` reporting something like `0/11 tokens satisfied · 🔴 DRIFT` against
   perfectly healthy code, with no self-heal, ever.

   Check whether a baseline exists at all:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/compartments.mjs show "<TARGET>"
   ```

   Read the **`contractsFingerprint:`** line — that is the baseline this guard actually
   uses. (The output also prints `compartmentsFingerprint:`, the partition baseline. The
   two were added in different releases and are stamped by different code, so a graph can
   carry one and lack the other; do not read the compartments line as an answer about
   contracts.)

   - `contractsFingerprint: (never stamped)` → there is no contracts baseline. Run
     `/wiregraph-rebuild` before going any further.
   - `contractsFingerprint (per root, stamped at the last full build):` → a full build
     under the current rules stamped it, the guard will fire, and you can proceed.

   Two things also change on that first full rebuild. Say them before you run it, so the
   diff is expected rather than alarming:
   - **A comment no longer counts as a reference.** A token named only inside a comment
     used to mint a REFERENCES edge; it does not any more, because a comment mentioning a
     route is not an implementation of it. A legacy contract whose only reference on one
     side sat in a comment therefore flips from **satisfied** to **one-sided** at this
     rebuild. That is the true reading, not a regression — the seam was never implemented
     on that side.
   - **Rust is now indexed.** `Cargo.toml` was already a compartment boundary, but with
     no indexable files the compartment never materialised. A legacy repo containing
     `.rs` files gains a compartment and its symbols here — so compartment counts, symbol
     counts, and the set of compartments a spec can name all grow.

2. **Read the project's mode.** Call `graph_status` and read its `Mode:` line before you
   explain anything about contracts, because the mode changes what a trace MEANS:

   - `Mode: global` — compartments are inferred from `.git` / build manifests, and there
     is one flat contract namespace: every spec under the depth-1 contracts dir matches
     every file in the project. Nothing below about scoping applies.
   - `Mode: recursive` — the compartments are the explicit list in
     `<TARGET>/.wiregraph/state.json`, and contracts dirs are discovered at **any depth**,
     each **scoped to its parent's subtree**. The line names them
     (`contracts SCOPED to N dir(s): …`). Five things change in what you tell the user:
     - **"No seams found" has a different first cause.** On a global project the usual
       reason is that the compartments aren't in one graph. Here it is far more often that
       both sides of the seam are inside the **same declared compartment**, or that one of
       them is under **no declared compartment** and fell back to the root. Read the
       declared list back and ask whether the split matches the seam they expected; the
       fix is usually to declare the missing subsystem, which is `/wiregraph-teardown` +
       `/wiregraph-init`.
     - **Compartment names in a spec are the DECLARED names**, matched as plain strings
       against each symbol's compartment. They need not be any directory's basename. Take
       them from the declaration or from `graph_status`, never from the directory layout.
     - **A spec written before the declaration is stale, silently.** If a name changed
       when the compartments were declared, the old spec names a compartment that no
       longer exists: satisfied tokens flip to one-sided and the WIRE / RESOURCE edges
       vanish, with no error. Steps 3–6 regenerate the inferred drafts against the current
       names; a HAND-WRITTEN spec has to be fixed by hand.
     - **"One-sided" can mean OUT OF SCOPE, not missing.** A spec in `server/contracts/`
       matches code under `server/` and nowhere else, so a token a `client/` file names
       verbatim still mints nothing. When an outer and an inner spec declare the SAME
       route, the inner one owns it inside its subtree (nearest ancestor wins) and the
       outer legitimately reports one-sided — `trace_contract` says so on that line, in
       the words **NOT A MISSING IMPLEMENTATION**, and names the governing contract.
       Never send a user hunting for a handler on a line carrying that note. It fires ONLY
       for a contract strictly INSIDE this one's subtree: two SIBLING scopes (`client/`
       and `server/`) can declare the same token and neither takes anything from the
       other, so a one-sided line WITHOUT the note is a genuine finding.
     - **Titles must be distinct across scopes.** A contract's id is its title, so two
       specs in DIFFERENT contracts dirs sharing one would become a single node covering
       both subtrees and erase the scoping. The build refuses: it keeps the outer spec,
       skips the inner one, and logs `contract title collision ACROSS SCOPES` naming both
       files by full path. Relay that verbatim and offer to rename one title. Two specs
       governing the SAME territory — two files in one contracts dir, or `contracts/` plus
       `.wiregraph/inferred/` — still MERGE on purpose; do not "fix" that one. **Renaming
       a title is a FULL-REBUILD event**: the id changes, the old id's REFERENCES rows are
       orphaned, and the renamed contract never gets its WIRE edge. wiregraph refuses the
       next incremental and says why — take the refusal and run `/wiregraph-rebuild`.

3. **Scan (no writes).** Infer the cross-compartment seams and show the proposal:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs scan "<TARGET>"
   ```

   The scan reports the two kinds separately and ALWAYS prints the WIRE block first, then
   the RESOURCE block — so the first line is never the whole answer. Read to the end and
   show the user both, with the proposed YAML:

   - `Found N cross-compartment seam(s)` → wire seams, a draft AsyncAPI spec follows;
   - `Found N cross-compartment RESOURCE seam(s)` → resource seams, a draft
     `*.resource.yaml` follows — read out the `roles UNRESOLVED` note with it;
   - **MIXED — one block says `Found N …`, the other says `No cross-compartment … seams`**
     → the ordinary case, and it counts as FOUND: go to step 5 and show the block that
     found something. An empty block is ten lines of common reasons, so do not read the
     other block's explainer as the verdict;
   - `No cross-compartment WIRE seams` **and** `No cross-compartment RESOURCE seams` →
     nothing was found by INFERENCE; go to step 4. It does **not** mean the project has no
     seams: there are exactly two inferred kinds and no third block, so an in-process seam
     between two crates in one binary is absent from this output by construction, not by
     verdict. Never report "no contracts needed" off this line;
   - `Seams considered and NOT proposed` (wire) / `Named constants considered and DECLINED`
     (resource) → the tail of either block: everything the scan deliberately did not
     propose, with the reason for each. Read it back when the user asks why theirs was not
     proposed — a seam already declared in a HAND-WRITTEN spec is listed here rather than
     re-proposed.

4. **If it found no seams of either kind**, don't write anything. Explain the
   **workspace model**, which is what cross-compartment contracts depend on: index 2+
   compartments together under one parent — either related repos cloned side-by-side, OR
   the packages of a monorepo (each with its own manifest) — and `/wiregraph-init` that
   parent. If the two services are **already indexed as separate graphs**, connect them
   with `/wiregraph-link` instead of re-indexing. wiregraph can only see a shared route
   or a shared constant if both compartments are in one graph. The scan's own output
   lists the other common reasons (a bare string literal instead of a named constant, a
   function-local constant, the same name with two different values). Stop here — or, if
   the user wants a seam wiregraph cannot infer, go to step 7 and write it by hand. **The
   commonest such seam is an in-process one** — two crates or modules in one binary, coupled
   by exported symbols. Inference has no detector for it, so it will never appear above
   however the workspace is laid out; offer step 7's `*.inproc.yaml` rather than letting the
   user conclude the seam is invisible to wiregraph.

5. **If it found seams**, ask the user with AskUserQuestion whether to write the draft
   contract(s). Make clear it's a starting point they own and should review/commit.

   - **Write both drafts** — the wire and resource specs land in the contracts home and
     light up on the next full rebuild.
   - **Not now** — nothing is written; re-run this command whenever.

   If resource seams were found, say plainly in the question that **writer/reader roles
   are unresolved**: nothing in the code says which side writes, so every compartment is
   listed on both sides and the user has to delete the wrong half of each list.

6. **On yes**, write it:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/contracts.mjs apply "<TARGET>"
   ```

   This creates or reuses a contracts home (`contracts/`, `asyncapi/`, or a
   `*-contracts` dir/repo) and writes `wiregraph-inferred.asyncapi.yaml` and/or
   `wiregraph-inferred.resource.yaml` into it — only the formats that found something. An
   existing draft that differs is backed up under `.wiregraph/contract-backups/` first.

   In **recursive** mode `apply` still writes to the OUTERMOST contracts home,
   deliberately: inference is union-wide, so its draft spans the whole tree and belongs in
   `<TARGET>/contracts/`. It says so in a `SCOPE:` block naming the destination, and then
   lists the nested, scoped contracts dirs the draft does **not** go into — that list is
   the other dirs, never the destination it just named. If a seam really belongs to one
   subtree, move that channel into that subtree's own contracts dir by hand and give it a
   distinct title.

   The script's closing line now points at `/wiregraph-rebuild` for the same reason step 8
   does — writing a draft CHANGES THE SET OF SPECS IN FORCE, which is exactly what makes an
   incremental unsafe. Relay it as-is; there is nothing to override.

7. **Write by hand anything inference cannot see, and prune what it wrote.** All three
   formats live in the same contracts home and are read by the same pipeline. Two of them
   (`*.asyncapi.yaml`, `*.resource.yaml`) can arrive as drafts; the third (`*.inproc.yaml`)
   only ever arrives by hand.

   **First, prune the resource roles** (only if a `*.resource.yaml` was written). Open it
   and edit each resource's `writers:` / `readers:` down to the truth. Until then the seam
   derives in both directions. **Prune `writers:` BEFORE adding `single_writer: true`** —
   a fresh draft lists every participating compartment as a writer, so declaring the
   discipline on an unpruned list reports an immediate 🛑 **violation** against a
   placeholder, a finding about the draft rather than about the code.

   **Pruning is what makes the spec yours, and nothing else is required.** Authorship is
   decided by CONTENT: a spec whose roles are still the machine's placeholder — every
   participating compartment listed on BOTH sides — is a draft; one whose roles have been
   pruned is treated as HAND-WRITTEN and a later `/wiregraph-contracts apply` will not
   overwrite it. Leave `x-wiregraph-inferred: true` exactly where it is. It does not decide
   ownership, so deleting it protects nothing and changes nothing here; if the draft's own
   header comment tells you to delete it once the lists are pruned, that instruction is
   stale — say so rather than following it. An UNpruned draft is still regenerated by the
   next `apply` (the differing copy is backed up under `.wiregraph/contract-backups/`
   first), which is the point: an untouched placeholder is wiregraph's to rewrite.

   **A WIRE contract** is an AsyncAPI document — **2.x and 3.x are both read** — named
   `<name>.asyncapi.yaml` (or `.yml`, either case) in a contracts dir. The 3.x shape:

   ```yaml
   asyncapi: '3.0.0'            # 2.x is read too — see the version rule below
   info:
     title: Terminal Wire       # -> contract id + name; must be UNIQUE across all specs
     version: 0.1.0
   channels:
     submit-order:
       address: /orders/{id}/items          # the matched token, kept parameterized
       x-wiregraph-producers: [terminal]    # COMPARTMENT names that CALL it
       x-wiregraph-consumers: [orders_api]  # COMPARTMENT names that SERVE it
       messages:
         request:
           payload:
             type: object
             properties:
               order_id: { type: string }   # payload field names are tokens too
   operations:
     receive-submit-order:
       action: receive                      # server receives => client-to-server
       channel: { $ref: '#/channels/submit-order' }
       messages: [{ $ref: '#/channels/submit-order/messages/request' }]
   ```

   Rules for the wire format, worth stating to the user:

   - **AsyncAPI 2.x and 3.x are BOTH read — the version only decides WHERE the route is
     written.** In **3.x** the route is `channels.<key>.address`, and the channel KEY is an
     arbitrary id that is deliberately NOT a token (calling a 3.x channel `submit-order`
     mints nothing on its own). In **2.x** there is no `address:` field: the channel KEY
     *is* the address and is read as the token, rooted (`/alerts/{id}/escalate`) or
     unrooted (`smartylighting/streetlights/event/measured`) — the idiomatic 2.x spelling —
     and both forms match the route as source writes it, `{param}` segments included.
     Direction comes from the top-level `operations:` map in 3.x and from each channel's
     own `publish` / `subscribe` in 2.x, on the same server perspective: `publish` is
     published INTO the app (client→server), `subscribe` is what the app publishes out
     (server→client). Payload `properties:` field names are tokens in both versions. The
     same contract as the 3.0 example above, written in 2.x:

     ```yaml
     asyncapi: '2.6.0'
     info:
       title: Terminal Wire
       version: 0.1.0
     channels:
       /orders/{id}/items:                    # 2.x: the KEY is the address = the token
         x-wiregraph-producers: [terminal]
         x-wiregraph-consumers: [orders_api]
         publish:                             # 2.x: published INTO the app => c2s
           message:
             payload:
               type: object
               properties:
                 order_id: { type: string }
     ```

   - **A version that is neither 2 nor 3 is warned about, by FILE and by VERSION.** A 1.x
     or 4.x doc is read with the 3.x rules — which may find nothing — and the load logs
     `⚠ <file>: asyncapi <version> — wiregraph reads AsyncAPI 2.x and 3.x only.` A doc with
     no `asyncapi:` line at all is treated as 3.x-shaped and is not warned about for its
     version. Separately, a spec on a version wiregraph DOES read (2, 3, or no `asyncapi:`
     line) that ends up with zero matchable tokens gets its own named warning,
     `⚠ <file>: asyncapi <version> — this spec defines NO matchable tokens`,
     which is the line to look for when a contract loads and governs nothing. So if
     `trace_contract` lists a contract whose tokens contain no routes, the `asyncapi:`
     version is rarely the cause: read those two ⚠ lines from the last build first, then
     check the route against the distinctiveness gate below (a route under 5 characters or
     a generic endpoint is dropped), and only then that the address sits where its version
     puts it.
   - **`info.title` is the id.** It must be unique across every spec in the project, in
     both formats. Two specs sharing a title merge into one node (deliberately, for the
     `contracts/` + `.wiregraph/inferred/` pair) or, across two scopes in recursive mode,
     collide and the inner one is skipped with a logged warning.
   - **Two kinds of token are matched against code:** every channel address (3.x
     `address:`, 2.x the channel KEY), and every key under any `properties:` map. An
     address starting with `/` is matched as a route —
     each `{param}` segment matches however source writes it (`:id`, `${id}`, `{id}`, or a
     concrete value) — and an address that does not start with `/` is matched literally,
     which is how topics, routing keys and env-var names work.
   - **Tokens must be DISTINCTIVE** or they are dropped: a route is kept if it is 5+
     characters and is not a generic endpoint (`/health`, `/metrics`, `/api`, `/status`,
     `/ping`, `/version`, …); a non-route needs a dot/colon key, a `_` with 6+ characters,
     or a 10+ character camelCase name, and generic words (`id`, `type`, `name`, `state`,
     `status`, `data`, `message`, …) and ubiquitous env vars (`DATABASE_URL`, `PORT`,
     `LOG_LEVEL`, …) are always dropped. A generic token would mint references in every
     file and manufacture phantom seams.
   - **`x-wiregraph-producers` / `x-wiregraph-consumers` are what make a directed edge.**
     They are arrays of COMPARTMENT NAMES on the channel — the names `graph_status`
     reports, which in recursive mode are the DECLARED names. Without them the derivation
     falls back to an env-var heuristic, so a hand-written spec that omits them still
     shows references but a weaker seam.
   - **Direction is read from the operations, wherever the version keeps them.** Contracts
     are server-perspective. In 3.x that is the top-level `operations:` map: `action:
     receive` tags that operation's message fields client→server, `action: send` tags them
     server→client, and an operation's `reply.messages` get the opposite. In 2.x it is the
     channel's own `publish` (client→server) and `subscribe` (server→client). A
     `/`-leading token with no operation on either shape defaults to client→server.
   - **The spec must live in a contracts dir** — a directory named `contracts/`,
     `asyncapi/` or `*-contracts` (any case). An arbitrary directory is promoted to a
     contracts home only if it directly holds an `*.asyncapi.yaml`.

   **A RESOURCE contract** is a wiregraph-native `*.resource.yaml` in the same place:

   ```yaml
   title: game-state-files          # -> contract name; must be UNIQUE across all specs
   resources:
     - id: GAME_STATE_PATH          # the shared CONSTANT NAME, never a path literal
       kind: path                   # path | db | shm | pipe
       semantics: presence-as-state # presence-as-state | last-writer-wins | append-log
       single_writer: true          # optional declared discipline
       writers: [alpha]
       readers: [beta, gamma]
   ```

   `trace_contract` and `path_between` traverse it exactly like a wire contract: a reader
   in one compartment links back to the writer in another with **no call edge** between
   them. Rules for the resource format:

   - **Roles are never inferred.** A named constant carries no signal for which side
     writes, so an inferred draft lists every compartment as both and the user prunes it.
     A guessed direction would not weaken a resource seam, it would invert it.
   - **The id must be the CONSTANT NAME, not the path.** An id containing `/` is
     rejected — wiregraph matches `/`-bearing tokens as HTTP routes.
   - **The id must be DISTINCTIVE**, by the same rule as a wire token, and **unique across
     every spec** — declaring it twice is refused at load with a message naming both files.
   - **Bare string literals are missed BY DESIGN.** A compartment that only ever writes
     `'/var/run/game/state.json'` and never names the constant does not appear in the
     seam. Name the constant on both sides (a shared constants module, or a vendored copy
     per compartment — both work) and the seam lights up.
   - **What `single_writer` can and cannot check.** wiregraph does **not** detect writes.
     A REFERENCES edge means "this symbol mentions the constant", never "this symbol
     writes through it". So `single_writer` is checked against the **declaration** only:
     "your spec names two writers on a single-writer resource". An *undeclared* second
     writer — the case that actually loses updates — cannot be identified as a writer at
     all. What wiregraph does report exactly is an ⚠️ **undeclared participant**: a
     compartment whose code references the resource while the spec names it as neither
     writer nor reader. That is a strict superset of "an undeclared writer".
   - **What inference will and will not propose.** It needs a constant at **module/file
     scope**; a value that identifies a resource (it carries `/` or `\`, or the NAME
     contains `PATH`, `FILE`, `DIR`, `LOCK`, `SOCK`, `SOCKET`, `PIPE`, `FIFO`, `SHM`,
     `TABLE`, `QUEUE`, `CACHE`, `DB` or `STORE`) — a version string, model id, enum
     member, encoding name or **URL** is rejected, URLs outright as wire concerns; a value
     that is actually constant (an interpolated template is not); **agreement** among the
     compartments that define it (two agreeing plus one stale copy still yields the seam
     for the majority with the outlier named; a genuine tie is dropped); and **two
     compartments that USE it** — the module that merely declares the constant is not a
     participant, and neither is a compartment that names it only in a **comment**.
   - **The IMPORTS edge is EVIDENCE, not the join.** When one compartment imports
     another's constants module the scan reports `import-corroborated`. That edge links
     `<module>` to `<module>` — no language mints a symbol for a constant — so it says
     "A's module depends on B's module", never "A uses B's constant X". The seam is found
     by the reference scan either way. (It also exists for TS/JS and C `#include` only;
     Python, Java and Kotlin emit no import candidates at all, which is why the vendored
     name+value join is mandatory rather than a fallback.)

   **An IN-PROCESS contract** is a wiregraph-native `*.inproc.yaml`, also in the same place.
   **Nothing infers this format — it exists only if the user writes it.** It is for two
   compartments in ONE process, on either side of a crate or module wall, coupled by direct
   use of the other side's exported symbols:

   ```yaml
   title: ecs-sim                 # -> contract name; must be UNIQUE across all specs
   boundary: crate                # crate | module — DOCUMENTATION of what the seam crosses
   symbols:
     - id: World                  # the exported SYMBOL NAME, bare
       kind: type                 # type | function | method | trait | macro — descriptive
       provider: ecs              # the ONE compartment that DEFINES it
       consumers: [sim]           # the compartments that USE it
     - id: Scheduler
       kind: type
       provider: ecs
       consumers: [sim]
   ```

   This derives directed `INPROC` edges from provider symbols to consumer symbols, and
   `trace_contract` / `path_between` walk them like any other seam. Rules for the format,
   worth stating to the user:

   - **Direction is one-way BY CONSTRUCTION.** Exactly one `provider:`, and a spec naming a
     compartment as BOTH provider and consumer of one symbol is **REFUSED** at load — not
     warned about, the way the resource format's writer/reader overlap is. A compartment
     using its own exported symbol is the call graph's job, not a seam.
   - **The id is the BARE symbol name.** `World`, never `ecs::World` and never `World<T>` —
     the matcher builds `\bWorld\b`, which is what the definition and every call site
     actually write. An id containing `/` is rejected (a `/`-bearing token is matched as an
     HTTP route); so is anything under 3 characters, and so is a generic word (`type`,
     `state`, `name`, `result`, …) that would match essentially every file ever written.
   - **`kind:` and `boundary:` are DESCRIPTIVE and change no matching** — but an unknown
     value is refused (`boundary:` for the whole spec, `kind:` for that one symbol), because
     a typo that loaded silently would make the field mean nothing.
   - **Short ids are ACCEPTED here, unlike in every other format, and that is deliberate.**
     A wire or resource token must pass the distinctiveness gate; an in-process id cannot and
     still be useful, since the exported surface of an ECS crate *is* `World`, `Entity`,
     `Scheduler`. The gate is not applied. The build instead logs one line per spec naming
     the short ids — that line is expected on a healthy spec, not a warning to chase.
   - **Read the drift report ASYMMETRICALLY. This is the thing to tell the user.**
     🔴 `unreferenced` is STRONG evidence — nothing in scope spells the name at all.
     `satisfied` is WEAK: it means *both compartments spell this name*, not *the consumer
     uses the provider's one*. Matching is literal and case-sensitive; comments and
     `use`/`import` lines are excluded; but an unrelated same-named symbol inside a declared
     compartment is indistinguishable from the real use, and a re-export under another local
     name (`use ecs::World as W`), a type alias or a macro-pasted name is missed entirely.
   - **The blast radius is bounded by the declared roles.** Only symbols in the declared
     `provider` compartment are paired with symbols in the declared `consumers`, so a stray
     `World` in a third crate can NEVER mint an `INPROC` edge. It surfaces as an ⚠️
     **undeclared participant** instead — and for this format that finding is as likely to be
     a false positive as an incomplete spec. Read it before widening `consumers:`.
   - **An `INPROC` edge is not a resolved call.** It says a symbol on each side spells the
     declared name. Calls still do not resolve across a compartment boundary.
   - **A misspelled compartment name costs more here than elsewhere.** The roles are the only
     thing bounding a short symbol name, so a name that matches no compartment does not just
     lose the seam — it removes the bound, and every real reference reports as an undeclared
     participant. Take role names from `graph_status`, never from the directory layout.

8. **Light up the edges.** Run `/wiregraph-rebuild` — a FULL rebuild, not an incremental.
   Writing or editing a spec CHANGES THE SET OF CONTRACT SPECS IN FORCE — whether it
   creates a contracts home, drops a new file into one that already existed, moves a spec
   between dirs, or retitles one — and contract scope is applied when REFERENCES are
   minted rather than stored, so an incremental over the new set would re-derive seams
   from rows minted under the old one. Provided the project has a fingerprint baseline
   (step 1), wiregraph refuses that incremental outright and says why, and the SessionStart
   catch-up escalates to a full rebuild on the same signal — so `/wiregraph-update` and the
   read-time self-heal reach the right answer too, just with a detour. **That holds in
   GLOBAL mode as well as recursive**, which matters because global is the default and is
   the mode `apply` normally writes into. Without that baseline nothing refuses and
   nothing escalates, which is the whole reason step 1 exists.

   Then confirm with `trace_contract` (which symbols in which compartments reference the
   contract) and `path_between` (a producer in one compartment to the consumer in another,
   or a reader back to its writer with no call edge between them). Summarize what was
   linked.

   **If you don't already know a contract's name, list them all first.** `trace_contract`'s
   `contract` argument is a case-insensitive SUBSTRING of the contract name, and the EMPTY
   substring matches every one — so calling it with `contract` **omitted, or empty (`""`)**,
   lists every contract in the graph, each with its kind (wire, resource or inproc) and how
   many tokens it defines. That is the documented way to enumerate coverage on a project with
   several specs across several contracts dirs — don't guess a title, and don't fall back to
   `query_sql` for it. Then call it again with a substring of the one you want for that
   contract's per-token detail.

Note: cross-compartment attribution needs the compartments in **one graph**. There
are three ways to get that: **either** index them together under one parent (related
repos side-by-side, or a monorepo's packages — a compartment boundary is a `.git`
OR a package/module manifest), **or** **declare** them (a project on the `recursive`
mode — set only by `/wiregraph-init`), **or** connect two separately-indexed graphs with
`/wiregraph-link`, which includes one as a member of the other and re-infers seams across
the union. Two repos each with their own `/wiregraph-init` and no link between them still
can't see a shared route or a shared constant — guide the user to link them or index them
together.
