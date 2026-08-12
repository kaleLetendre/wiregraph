# wiregraph — decision log

Architecture decisions for the storage backend, newest first. Each entry: the
decision, why, and what it costs. (The detailed evaluation logs that led here —
the Neo4j-vs-SQLite parity/perf/token experiments — are kept out of this repo.)

---

## D13 — In-process contract ids are NOT put through the distinctiveness gate — 2026-08-12

**Decision.** `*.inproc.yaml` ids skip `isDistinctive` (`src/extract/distinctive.js`), the gate every
AsyncAPI and resource token must pass. Sub-distinctive ids are **accepted**; the loader names them
once per spec, deliberately **without** a `⚠` marker. Only ids that cannot be a join key under any
reading are refused: shorter than 3 characters, or on a small stop list of generic words (`type`,
`state`, `name`, `result`, …).

**Why.** The gate's camelCase arm is `/^[a-zA-Z][a-zA-Z]{9,}$/` — ten or more letters. The seam this
contract type exists for is an ECS crate whose exported surface is `World` (5 characters), `Entity`
(6) and `Scheduler` (9). **Every one of them is rejected by `isDistinctive`.** Applying the gate would
have made the feature refuse its own reason for existing, and the alternative — a gate with a special
case for symbol names — is a gate that no longer means anything. So the cost is *documented* rather
than *gated*, in the parser header, the README and `docs/contracts.html`, in the one form that is
actionable: `unreferenced` is strong evidence, `satisfied` is weak, and the blast radius of a false
positive is bounded by the declared provider/consumer roles. The report is not a `⚠` and is not one
line per id, because a short id is the **expected** shape here (unlike a resource id, where it is a
mistake); a marker that fires on a healthy spec on every single build teaches the user to ignore the
marker — the exact failure `resource-spec.js` already documents for its total-overlap warning.

**Cost.** False positives are real, and *within* the declared compartments they are unbounded in
count: N unrelated `World`-mentioning symbols on one side × M on the other is N×M candidate pairs,
capped per ordered compartment pair with the truncation logged. So a too-common id inflates a seam
between two compartments that genuinely share the symbol — it does not manufacture a seam between two
that do not. The precise fix — intersect the id against the extractor's own symbol table, accepting an
occurrence only where the file also defines or calls a symbol of that name — is a real cross-check and
is deliberately **not** built: it needs a definition-site index covering types and traits, and this
change makes no extractor changes. Recorded so it is a decision rather than an omission.

## D14 — A provider that is also a consumer is REFUSED, where the resource analogue only warns — 2026-08-12

**Decision.** An in-process symbol naming one compartment as both `provider` and a member of
`consumers` is **skipped with a reason**. The equivalent resource case — a compartment in both
`writers` and `readers` — is only *warned* about, and still loads.

**Why.** The two look like the same mistake and are not. A resource legitimately has a compartment
that both writes and reads it; `buildResourceEdges` skips the intra-compartment pairs and the
cross-compartment ones still derive, so the spec still says something true and checkable. An
in-process contract's *entire claim* is that direction is one-way — exactly one provider, by
construction — and a compartment on both sides of one symbol is a self-contradiction with nothing left
to check. This is the first mechanism in wiregraph that makes the architecture's **R6** ("direction is
one-way where it can be") checkable at all; accepting the contradiction would mean the type quietly
stopped checking the one thing it exists to check. A compartment using its own exported symbol is the
call graph's job, not a seam.

**Cost.** Two formats that otherwise look alike now behave differently on the same-shaped input, and a
user who learned the resource rule will be surprised — the log line has to carry the whole explanation
because nothing else will. The whole symbol is dropped rather than partially honored, so a spec with
one bad entry silently loses that entry from the graph (logged, with the fix). And the check is
**per declaration only**: nothing looks for a direction cycle across several contracts, so R6 is
enforced narrowly. The README's R6 row now reads *enforced (per declaration)*, superseding this log's
own **D12**, which lists R6 as unaddressed.

## D15 — Resource ids and in-process ids share ONE join-key namespace — 2026-08-12

**Decision.** One id-ownership map across both formats, not one per format: a differently-titled spec
claiming an id another spec already owns has it dropped, whichever two formats they came from, with a
hand-written spec always beating an inferred draft regardless of read order. A contract that loses
*every* id this way is dropped rather than left as an empty node, and says so.

**Why.** Both kinds of id are a bare name the user chose, both compile to `\bname\b`, and both land in
the **same token index** in `matchContracts`. Two contracts claiming one name therefore mint
`REFERENCES` to two contract nodes and derive the same seam twice — the identical defect whichever
formats produced them, so it wants the identical rule. Splitting the namespace by format would let a
`*.resource.yaml` and an `*.inproc.yaml` both claim `SESSION_TOKEN` and reintroduce precisely the
defect the uniqueness rule exists to refuse.

**Cost.** The two formats are coupled forever on naming: a project must keep constant names and
exported symbol names globally distinct from each other, even though they describe unrelated things
and a collision between them is far less likely to be a genuine mistake than a collision within one
format. The diagnostic has to speak each format's own vocabulary so the message stays honest, which
means one rule with two spellings and two places to keep in step. And a third join-key format added
later inherits the namespace whether or not that is right for it — the registration is a single set,
which is the point, but it is an opt-out nobody gets.

## D16 — Cross-format title collisions resolve by FORMAT PRECEDENCE: asyncapi > resource > inproc — 2026-08-12

**Decision.** When one title is declared by specs of more than one format, the strongest format's
spec(s) survive and the rest are skipped with a warning naming every file by path. The precedence is
fixed and explicit: **asyncapi > resource > inproc**. The pre-existing asyncapi-vs-resource message is
kept byte for byte; any collision involving the new format gets a generalised one.

**Why.** A title shared across formats cannot be merged — `mergeContracts` keeps only the first
contributor's file and kind, so the resulting node would name one format while carrying the union of
both formats' tokens, and every report about it would be wrong about what it is. Something has to
lose. Before this, the loser was whichever spec was **read second**, i.e. a function of directory read
order — so which contract existed could differ between two machines with identical trees. Fixed
precedence makes the outcome reproducible and makes the warning actionable: it can name the survivor
and the file to rename. The ordering is by incumbency — AsyncAPI is the original format and the only
one with an external standard behind it, and resource predates in-process.

**Cost.** The order is a convention, not a truth: no format is intrinsically more authoritative, so a
user whose in-process spec is the real one has to rename the *other* file, and the message must say so
clearly or it reads as wiregraph picking the wrong winner. It is also one more list that a fourth
format must be appended to — a kind absent from the precedence list falls back into the `asyncapi`
bucket rather than erroring, which is right for the two legacy values (`asyncapi` and unset) and would
be silently wrong for a new one.

## D12 — Recursive mode implements a named architecture, and the docs say which of its rules wiregraph actually checks — 2026-08-12

**Decision.** Treat **Compartments & Contracts** — a language- and tool-independent architecture
document that exists outside this repo — as the thing recursive mode implements, and record the
correspondence rule by rule in ONE place: the README's
[Nested compartments](README.md#nested-compartments-recursive-mode) table. Every rule R1–R6 gets one
of three verdicts, and the three are kept distinct because conflating them is the failure this
entry exists to prevent: **enforced** (wiregraph detects a violation and says so — R3, R4),
**assumed** (its behaviour depends on the rule and goes silent or wrong without it — R2, R5),
**unaddressed** (nothing in wiregraph relates to it — R1, R6). The load-bearing case is **R4**, "a
contract lives in the shared parent's `contracts/`, never inside either side," which is
character-for-character what `scopeRoot = dirname(dir)` computes in
`src/contracts-dirs.js#rootContractsEntries` (consumed by `src/build.js#resolveContractsDirs` and
`src/extract/contracts.js#scopeDepthFor`). The rule and the code were arrived at independently and
nothing in either place recorded that they are the same rule.

**Why.** The scoping rule reads as an implementation detail — "which subtree does this contracts dir
govern" — and was documented as one, at three code sites, in the vocabulary of directories. Named as
R4 it is instead the single reason the layout works, and the reason the misfiling diagnostic exists:
a contract filed inside one of its own sides governs only that side, so its far half reports
one-sided. Without the correspondence written down, the next change to `scopeRoot` looks like a free
choice of convention rather than an implementation of a rule with a stated purpose. The verdict
column carries the other half of the honesty: four of the six rules are NOT machine-checked, and a
reader who saw "wiregraph supports this architecture" would reasonably assume the tool was holding
boundaries it does not hold.

**Cost.** A correspondence claim in the README that nothing tests — it can rot the way any prose can,
and the two `assumed` verdicts in particular would have to be revisited if the compartment partition
ever became nested rather than flat, or if role names were ever validated against a contract's scope.
It also puts a second project's vocabulary (whoami, R1–R6, levels) into wiregraph's docs, which is a
dependency on a document this repo does not own. The alternative — leaving the two descriptions
independent and hoping they stay compatible — is what produced a scoping rule nobody could explain
the purpose of.

## D10 — Freshness = "differs from what was indexed" (mtime/size), and reads self-heal — 2026-06-17

**Decision.** Track each file's on-disk `mtime`+`size` in the `files` table (schema
v1 → v2) and define staleness as *the file on disk differs from what was indexed*,
not *the working tree differs from the last committed git sha*. The read tools
(`find_symbol`, `get_source`, `trace_*`, `path_between`, `query_sql`) now self-heal:
before answering they re-index any file that changed on disk, bounded by a short
in-process TTL so a burst of queries pays the git+stat probe at most once.

**Why.** Users reported wiregraph going unused after they made edits: it "wasn't
updated," so Claude fell back to grep. Root cause was a logic bug — staleness was
computed purely from git (`git status --porcelain` + committed diff), so an
*uncommitted* edit showed as changed **forever**, even right after `update_graph`
re-indexed it (HEAD hadn't moved, so the stored sha never advanced). `graph_status`
therefore reported `STALE` perpetually and the update loop never converged. Tracking
the indexed mtime makes "stale" clear as soon as the file is re-indexed, regardless
of commit state; self-heal-on-read removes the dependency on Claude noticing
staleness and calling `update_graph` at all (it also covers edits the user makes
outside Claude and the edit-then-query race against the background PostToolUse
re-index).

**Cost.** A schema bump: existing v1 graphs are migrated to v2 automatically on the
next read (see D11). Each read pays a cheap git-diff + `stat` probe when the TTL
window has expired, and a fast incremental re-index only when something actually
changed. Staleness enumeration still seeds from git, so a change in a non-git
directory isn't detected on read (unchanged from before; the SessionStart catch-up
and a manual `update_graph` remain the backstops).

## D11 — Schema mismatch self-heals too, not just stale files — 2026-06-17

**Decision.** Extend self-heal-on-read to cover a schema-version mismatch: when a
read tool opens a db on an older schema, the server runs a full reset rebuild
(migrating v1 → v2) and then serves, instead of returning "run /wiregraph-rebuild".
The rebuild is deduped within the process (`schemaHealPromise`) and awaited by every
caller, and `update_graph`'s incremental path migrates first too.

**Why.** D10's mtime self-heal didn't cover the schema bump it introduced — the
staleness probe bails on a schema mismatch, and `withDb` returned the rebuild prompt,
so a read on a v1 graph still fell back to grep. A user hit exactly this in daily
use: a verifier subagent saw the v1/v2 mismatch and grepped instead of rebuilding.
Making the migration transparent closes the last "graph looks broken → abandon it"
path, so a plugin update with a schema change needs no manual `/wiregraph-rebuild`.

**Cost.** The first read after a schema-changing update pays a one-time full rebuild
inline (seconds on a real project); on a very large graph that single call could
approach an MCP timeout, after which the rebuild still completes in the background
and the next call succeeds. If several plugin processes each run their own MCP
server, each may trigger one redundant rebuild (serialized by the db lock); they
converge. `/wiregraph-rebuild` remains the explicit backstop.

## D9 — WASM SQLite (`sql.js`) is the store, not `better-sqlite3` — 2026-06-15

**Decision.** Back the embedded store with `sql.js` (SQLite compiled to
WebAssembly), via a thin adapter that presents the slice of the better-sqlite3 API
the loader/query layer use.

**Why.** The target is "a bare machine with only Claude Code + Node." `better-sqlite3`
is a *native* module; it only has a prebuilt binary when a release matches the
exact Node version, and on the dev machine `npm install` fell back to **compiling
from source (~57 s, requires python3 + a C/C++ toolchain)** — which simply fails on
a machine without build tools. `sql.js` ships its `.wasm` inside the npm package,
so install compiles and downloads nothing: clean `npm install` dropped from 57 s to
~1 s with zero node-gyp. It reads/writes the standard SQLite on-disk format, so the
db file is unchanged and interoperable, and it loads the 5 MB test-workspace graph in
~2.4 ms (queries sub-ms) — perf is irrelevant at this graph size.

**Cost.** sql.js is in-memory: a writable connection must persist on `close()`
(export → temp file → atomic rename). Native better-sqlite3 would be faster on a
*much* larger graph, but ours is thousands of nodes. The adapter is the one place
that knows the store isn't better-sqlite3.

**Consequence.** The only remaining native dependency is `tree-sitter`, which ships
bundled prebuilds for all six linux/mac/windows × x64/arm64 targets (loaded, never
compiled). Install is therefore toolchain-free on any mainstream platform.

## D8 — Defer per-process adjacency caching — 2026-06-15

**Decision.** `trace_*` rebuilds the full CALLS adjacency map on each call
(~8 ms at a few-thousand-node scale). Leave it; add a code note.

**Why.** Negligible cost at our size; caching adds state/invalidation complexity
for no user-visible win. Revisit only if wiregraph targets much larger graphs.

## D7 — One db file per project, not a shared multi-project file — 2026-06-15

**Decision.** Each project's graph lives at `<project>/.wiregraph/graph.db`; the
server resolves it from `CLAUDE_PROJECT_DIR`.

**Why.** Clean isolation, trivial teardown (delete the folder), no cross-project
bleed risk. The `project` column still scopes every query (the schema supports
multiple projects in one file), but per-project files are simpler and match how
Neo4j was used in practice. `$WIREGRAPH_DB` overrides the path.

## D6 — Stamp a schema version + migrate on rebuild — 2026-06-15

**Decision.** Store `schema_version` in a `meta` table. The server refuses to query
a db whose version differs (prompts `/wiregraph-rebuild`); a `--reset` build
migrates by dropping + recreating the tables.

**Why.** A future schema change must not silently return wrong answers against an
old-shape db. Cheap insurance.

## D5 — Keep a raw-query escape hatch as `query_sql`, not drop it — 2026-06-15

**Decision.** Replace the old Neo4j `cypher` tool with `query_sql`: a single
read-only `SELECT`/`WITH` over the schema; everything else rejected.

**Why.** The 7 structured tools covered every experiment, but a power-user escape
hatch for novel structural questions costs ~20 lines and avoids shipping new code
for one-off queries. Read-only by construction (regex guard + the db is opened
read-only in the server).

## D4 — Full replacement of Neo4j, no `WIREGRAPH_BACKEND` switch — 2026-06-15

**Decision.** Delete the Neo4j backend entirely rather than keep both behind a
runtime switch.

**Why.** The eval proved SQLite is at parity on answers and the token win, faster
per call, and ~570× smaller. Keeping Neo4j would mean maintaining two query layers
and the 2.7 GB JVM provisioning forever. One code path is simpler and is the whole
point. What's lost: the Neo4j Browser visual theme (the standalone d3/Gephi
exporters cover visualization) and raw Cypher (replaced by `query_sql`).

## D3 — Rewire the HTML/GEXF exporters to SQLite; drop the raw-Cypher mode — 2026-06-15

**Decision.** `export-html`/`export-gexf` gather from SQLite via a shared module;
`export-html`'s `--query <cypher>` mode is removed.

**Why.** The d3/Gephi rendering is backend-agnostic; only the data-gathering query
changed. The raw-Cypher mode can't exist without Neo4j and `query_sql` covers
ad-hoc needs. Added a `contract` column to `edges` so WIRE edges stay faithful for
the contract-scoped export.

## D2 — Golden-snapshot regression test, since there's no Neo4j to diff against — 2026-06-15

**Decision.** Add `test/` (`npm test`): build a committed synthetic fixture and
assert golden results through the query layer — symbol resolution, intra/cross-file
traces, get_source, an in-repo `path_between`, `query_sql` guards, schema migration,
and incremental idempotency. The fixture is self-contained (no external workspace).

**Why.** Parity was previously proven by diffing against Neo4j. With Neo4j gone, a
committed golden suite is what stops a future change from silently regressing — the
`path_between`/incremental bugs below are exactly what it guards.

## D1 — Embedded SQLite replaces the Neo4j server (not Kuzu) — 2026-06-13

**Decision.** Replace the Neo4j server backend with an embedded SQLite store.
Chose SQLite over Kuzu (the original "embedded graph DB" idea).

**Why.** Neo4j needed a 2.7 GB bundled JVM + a running daemon + a port, and its
setup bailed on anything but linux-x64 — a non-starter for cross-platform. Kuzu (the
embedded graph engine) was deprecated (npm "no longer supported"). The graph is
~2,700 nodes, so a graph *engine* isn't needed — an indexed store + in-JS BFS
traversals reproduce Neo4j's behavior exactly. Proven byte-identical on a real
multi-repo test workspace (45/45 parity battery) at ~570× smaller footprint.

---

## Bugs found during the migration (all fixed; guarded by `npm test`)

- **`path_between` crashed on cross-repo paths** that route through a Contract node
  (its label helper queried only the `symbols` table). The spike's parity check
  used an in-repo path and missed it. Fixed to resolve labels against contracts too,
  mirroring Neo4j's `coalesce` reconstruction.
- **Incremental dropped cross-file edges**: the loader's dangling-edge check
  validated endpoints against the in-memory batch only, so re-indexing one file lost
  its edges to symbols in files it didn't re-parse. Fixed to validate against the
  store (existing + just-inserted), exactly like Neo4j's MATCH-both-endpoints.
  Incremental re-index is now idempotent.
- **Incremental falsely tagged `~ambiguous`**: a re-indexed file's own symbols
  appeared in both the fresh graph and `loadProjectSymbols`, so same-file calls
  looked doubly-defined. Fixed by excluding the changed files from `extraDefs`;
  incremental now matches a full rebuild exactly.
