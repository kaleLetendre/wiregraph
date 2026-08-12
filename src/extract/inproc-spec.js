// In-process contracts — the THIRD contract type.
//
// A WIRE contract (*.asyncapi.yaml) models caller -> route/message -> handler over a
// network. A RESOURCE contract (*.resource.yaml) models two compartments joined by a
// shared file / table / shm region / pipe. An INPROC contract models the third big class
// of cross-compartment coupling and the one wiregraph could not represent at all: two
// compartments IN ONE PROCESS, coupled across a crate or module boundary by direct use of
// each other's exported symbols.
//
// WHY IT HAS TO EXIST AS A CONTRACT. src/extract/resolve.js deliberately never resolves a
// call across a compartment boundary by name, on the rationale that "genuine
// cross-compartment links flow through Contract nodes instead". For an in-process seam
// there was no contract type to flow through, so those links flowed nowhere: a four-crate
// Cargo workspace indexed as four disconnected islands.
//
// Format — `<name>.inproc.yaml` (or .yml) in any contracts dir:
//
//   title: ecs-sim                 # -> contract name; MUST be unique across ALL specs
//   boundary: crate                # crate | module — DOCUMENTATION of what the seam
//                                  #   crosses. It does not change matching.
//   symbols:
//     - id: World                  # the exported SYMBOL NAME that crosses the boundary
//       kind: type                 # type | function | method | trait | macro (descriptive)
//       provider: ecs              # the ONE compartment that defines it
//       consumers: [sim]           # the compartments that use it
//
// DIRECTION IS ONE-WAY BY CONSTRUCTION. There is exactly one `provider:` and a list of
// `consumers:`, and a compartment naming itself on both sides of one id is REFUSED rather
// than warned about. This is the first mechanism in wiregraph that makes "direction is
// one-way where it can be" checkable at all, and a spec that says a compartment both
// provides and consumes one symbol has not said anything checkable.
//
// WHY THE ID MUST BE A BARE SYMBOL NAME, NOT A PATH. Exactly the resource-spec rule and
// for exactly the resource-spec reason: matchContracts (extract/contracts.js) branches on
// whether a token contains `/`, and a `/`-bearing token takes the route-shaped
// pathTokenRegex branch, whose `{param}` wildcards and trailing boundary lookahead are
// built for HTTP routes and are wrong for a symbol name. The identifier branch builds
// `\bWorld\b` and mints REFERENCES with correct enclosing-symbol attribution in every
// walked file, in every language, with NO extractor changes. So an id containing `/` is
// REJECTED with a clear message. A Rust path (`ecs::World`) is likewise refused: declare
// the bare item name, which is what both the definition and every `use`/call site spell.
//
// ============================================================================
// DOCUMENTED LIMITATION #1 — THE SAME LITERAL-BLINDNESS EVERY CONTRACT TYPE HAS.
// ============================================================================
// The join key is the SYMBOL NAME as written. A consumer that reaches the provider only
// through a re-export under a different local name (`use ecs::World as W;` and then only
// ever `W`), through a type alias, through a generic parameter, or through a macro that
// pastes the name together at expansion time, is MISSED. Nothing here parses Rust
// semantics; it matches the identifier.
//
// ============================================================================
// DOCUMENTED LIMITATION #2 — SHORT IDS ARE A FIREHOSE, AND THIS TYPE INVITES THEM.
// ============================================================================
// This one deserves more than a sentence, because it is the limitation a user of THIS
// contract type will actually hit, and because it is the direct cost of the design choice
// that makes the type work at all.
//
// A resource id is a SCREAMING_SNAKE constant name and is put through the same
// distinctiveness gate every AsyncAPI token passes (extract/distinctive.js: 6+ char
// snake/SCREAMING, a dotted/colon topic, a 10+ char camelCase name, or a 5+ char path).
// An in-process id CANNOT pass that gate and still be useful: the motivating seam is an
// ECS crate whose exported surface is `World`, `Entity`, `Scheduler`, `Query`, `System`.
// Every one of those is rejected by isDistinctive — `World` and `Entity` are far short of
// the 10-character camelCase floor. Applying the gate would have made the feature refuse
// its own reason for existing. So THE GATE IS NOT APPLIED, and the consequence is stated
// here instead of being implied away:
//
//   * matchContracts compiles the id to `\bWorld\b` and runs it over every source file in
//     every compartment the contract governs. EVERY word-bounded occurrence mints a
//     REFERENCES edge from its enclosing symbol. Matching is CASE-SENSITIVE, so a local
//     `world` is safe — but an unrelated `struct World` in another crate, a `World` inside
//     a string literal, a `World` field name on an unrelated type and a `World` in a
//     doctest are all indistinguishable from the real use, and all mint edges.
//   * Comments and import/`use` lines are already excluded (scanTokenOccurrences takes the
//     tree-sitter comment ranges, and importLineFlags drops `use ecs::World;`), so
//     "comments-adjacent code" specifically is NOT a false-positive source. Prose in a
//     Python docstring or a Rust `///` doc-comment IS covered by the comment ranges when
//     the file parsed; a file scanned with no parse in hand is not.
//   * The BLAST RADIUS OF A FALSE POSITIVE IS BOUNDED BY THE DECLARED ROLES, and this is
//     the one real structural difference from a resource id. buildInprocEdges only pairs
//     symbols in the declared provider compartment with symbols in the declared consumer
//     compartments, so a stray `World` in a third crate can NEVER mint an INPROC edge. It
//     mints a REFERENCES edge, and that surfaces — deliberately — as an UNDECLARED
//     PARTICIPANT in trace_contract, which is the honest report: "something else in this
//     project spells this name, go look".
//   * WITHIN the declared compartments a false positive is real and unbounded in count: N
//     unrelated `World`-mentioning symbols in `ecs` x M in `sim` is N*M candidate pairs,
//     capped at MAX_PAIRS_PER_TOKEN per ordered compartment pair with the truncation
//     logged. So the failure mode of a too-common id is an INFLATED, noisy seam between
//     two compartments that genuinely do share the symbol — not a phantom seam between
//     two that do not.
//   * A DRIFT REPORT ON A SHORT ID IS THEREFORE WEAK IN ONE DIRECTION ONLY. "unreferenced"
//     is still strong evidence (nothing anywhere spells the name). "satisfied" is WEAK:
//     it means both sides spell the name, not that the consumer uses the provider's one.
//
// THE CHEAP MITIGATION, IMPLEMENTED: ids that fail isDistinctive are ACCEPTED but the
// loader says so, once per spec, naming them. It is NOT a `⚠` and NOT one line per id: a
// short id is the EXPECTED shape here (unlike a resource id, where it is a mistake), so a
// warning marker would fire on the flagship's own six frozen ECS signatures on every
// single build and train the user to ignore the marker — the exact failure resource-spec.js
// documents for its total-overlap warning. What IS refused outright is the id that cannot
// be a join key under any reading: a stop-word (`type`, `state`, `name`, ...) or anything
// under 3 characters, both of which would match essentially every file ever written.
//
// THE MITIGATION NOT BUILT, AND WHY: the precise fix is to intersect the id against the
// extractor's own SYMBOL table — accept an occurrence only where the enclosing file also
// defines or calls a symbol of that name — which is a real cross-check, not a heuristic.
// It is deliberately out of scope: it needs the definition-site index to cover types and
// traits (constDefIndex covers `kind: 'const'` only), and phase 1 is a no-extractor-change
// change. Recorded here so it is a decision rather than an omission.
//
// The parser returns the SAME descriptor shape the AsyncAPI and resource parsers return —
// {id, name, file, tokens, direction, wireRoles} — plus a `kind` discriminator, so
// mergeContracts / contractTokenMeta / matchContracts need no branch at all:
//   provider  -> wireRoles.producers   (persisted to contract_tokens.producers)
//   consumers -> wireRoles.consumers   (persisted to contract_tokens.consumers)
//   kind + boundary -> the free-text contract_tokens.direction column, via the `inproc:`
//     encoding below. NO SCHEMA CHANGE (SCHEMA_VERSION 5).

import { basename } from 'node:path';
import { contractId } from '../model.js';
import { isDistinctive } from './distinctive.js';

// Descriptive only — none of these changes matching. Rejecting an unknown value is what
// keeps the vocabulary a vocabulary: a typo'd `kind: struct` that silently loaded would
// make the field mean nothing.
export const INPROC_KINDS = ['type', 'function', 'method', 'trait', 'macro'];
export const INPROC_BOUNDARIES = ['crate', 'module'];
// Case-INSENSITIVE, matching both the discovery side and the other two parsers' patterns.
// See extract/contracts.js SPEC_PARSERS for why the two halves must not disagree.
export const INPROC_SPEC_RE = /\.inproc\.ya?ml$/i;

// contract_tokens.direction is free text whose existing values are 'c2s', 's2c', NULL and
// the resource encoding's `res:` prefix. An inproc token has no request/reply direction, so
// the column carries this contract type's own metadata behind a prefix that cannot collide
// with any of those:
//
//   inproc:kind=type;boundary=crate
//
// Keys and values are percent-encoded (encodeURIComponent escapes both `;` and `=`), so a
// future kind/boundary string round-trips losslessly. Same shape as the resource encoding
// on purpose — one reader per prefix, no shared parser that could drift into accepting a
// resource field on an inproc token.
export const INPROC_DIRECTION_PREFIX = 'inproc:';

export function encodeInprocDirection({ kind, boundary } = {}) {
  const e = (v) => encodeURIComponent(String(v));
  return INPROC_DIRECTION_PREFIX + [`kind=${e(kind ?? 'type')}`, `boundary=${e(boundary ?? 'crate')}`].join(';');
}

// null for anything that is NOT an inproc direction ('c2s' / 's2c' / null / a `res:`
// value / garbage), so every existing caller keeps its current behavior unchanged.
//
// Failures are RECORDED, never guessed at — the same rule decodeResourceDirection follows,
// and for the same reason: only wiregraph writes this column, so a value that does not
// decode means the row is corrupt, and silently substituting a default would turn a
// corrupt row into a confident wrong answer with nothing anywhere to say why.
export function decodeInprocDirection(value) {
  if (typeof value !== 'string' || !value.startsWith(INPROC_DIRECTION_PREFIX)) return null;
  const out = { kind: null, boundary: null, errors: null };
  const fail = (msg) => { (out.errors ??= []).push(msg); };
  for (const pair of value.slice(INPROC_DIRECTION_PREFIX.length).split(';')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    if (i < 0) { fail(`field "${pair}" has no "=" separator`); continue; }
    let k, v;
    try { k = decodeURIComponent(pair.slice(0, i)); v = decodeURIComponent(pair.slice(i + 1)); }
    catch { fail(`field "${pair}" is not valid percent-encoding`); continue; }
    if (k === 'kind') out.kind = v;
    else if (k === 'boundary') out.boundary = v;
    else fail(`unknown field "${k}"`);
  }
  return out;
}

const strArray = (v) => {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
};

// The ids that cannot be a join key under ANY reading, refused outright (see LIMITATION #2
// for why the full distinctiveness gate is NOT applied). `isDistinctive`'s own STOP list is
// not exported and this is a deliberately smaller set: the generic words that name a
// language keyword or an every-file identifier.
const INPROC_ID_STOP = new Set([
  'id', 'type', 'name', 'value', 'data', 'self', 'this', 'new', 'get', 'set', 'run',
  'main', 'init', 'state', 'error', 'result', 'option', 'string', 'str', 'vec', 'map',
  'box', 'ref', 'key', 'item', 'node', 'list', 'len', 'add', 'fn', 'impl', 'mod', 'use',
]);
const MIN_INPROC_ID_LEN = 3;
// matchContracts compiles a non-`/` token to `\btok\b`, so an id containing a regex
// metacharacter or whitespace would either be escaped into something nobody wrote or
// silently never match. An id is one bare identifier.
const INPROC_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Parse ONE *.inproc.yaml doc into a raw contract descriptor (no graph mutation).
// Returns null when the doc yields nothing usable; every rejection is logged with a
// message that names the file and says what to fix.
//
// `isDraft` is readContractsDir's authorship verdict. There is NO inproc inference and no
// inproc emitter in phase 1, so no draft of this format exists and the parameter is only
// here to keep the three parsers' signatures identical (SPEC_PARSERS calls them uniformly).
// It is passed through to `inferred` so that if an emitter is ever added, precedence and
// the inference-exclusion set already behave.
export function parseInprocSpec(doc, file, log = () => {}, isDraft = null) {
  const title = typeof doc?.title === 'string' && doc.title.trim() ? doc.title.trim() : null;
  const name = title || basename(file).replace(INPROC_SPEC_RE, '');
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.symbols)) {
    // A CLEAN BREAK FROM `interfaces:`, WITH A NAMED ERROR — not an alias. The key was
    // `interfaces:` while this was being built, and the word is precisely the one
    // `*.inproc.yaml` was chosen to avoid: this repo's architecture warns that `contracts/`
    // must never accumulate shared types, and "the interface contract" invites exactly that
    // reading — a place to put the types, rather than a description of which already-defined
    // symbols cross a boundary. An ALIAS would keep the wrong word alive in users' files
    // forever and make the vocabulary two words for one thing; nothing has shipped, so the
    // old key is refused. What it is NOT is refused SILENTLY: the design doc this was built
    // from spells `interfaces:`, so anyone working from it writes the old key once, and the
    // generic "expected a top-level 'symbols:' list" would leave them staring at a spec that
    // looks right. This branch costs one condition and turns that into a one-line fix.
    if (doc && typeof doc === 'object' && Array.isArray(doc.interfaces)) {
      log(`  ${file}: the list key is 'symbols:', not 'interfaces:' — rename it. An inproc spec DESCRIBES the exported symbols that cross a boundary; it never defines an interface, and naming it one invites a contracts/ dir that accumulates shared types. There is no alias: the spec is SKIPPED until the key is renamed.`);
      return null;
    }
    log(`  ${file}: not an inproc spec — expected a top-level 'symbols:' list; skipping`);
    return null;
  }
  // The title is the contract's identity: contractId(name) is what merges specs, what a
  // cross-format collision is judged on, and what `trace_contract <substring>` searches.
  // Falling back to the filename is a convenience, not a design — two specs named
  // `seam.inproc.yaml` in two different contracts dirs would collide on it silently.
  if (!title) {
    log(`  ⚠ ${file}: no 'title:' — falling back to the filename "${name}" as the contract name. Titles must be unique across every spec; add an explicit title.`);
  }

  // Spec-level, because the boundary a seam crosses is a property of the seam, not of each
  // symbol on it. An unknown value is refused for the WHOLE spec rather than silently
  // defaulting: `boundary: package` loading as `crate` would put a false statement in every
  // token's stored metadata.
  const boundary = doc.boundary == null ? 'crate' : String(doc.boundary);
  if (!INPROC_BOUNDARIES.includes(boundary)) {
    log(`  ${file}: unknown boundary "${boundary}" (expected ${INPROC_BOUNDARIES.join(' | ')}). Skipping the whole spec — the boundary describes the seam, not one symbol.`);
    return null;
  }

  const tokens = [];
  const direction = {};
  const wireRoles = new Map();
  const seen = new Set();
  const weak = [];

  for (const r of doc.symbols) {
    if (!r || typeof r !== 'object') { log(`  ${file}: skipping a non-object entry under 'symbols:'`); continue; }
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) { log(`  ${file}: skipping an entry under 'symbols:' with no 'id' (the id is the exported SYMBOL NAME that crosses the boundary)`); continue; }
    if (id.includes('/')) {
      log(`  ${file}: symbol id "${id}" contains "/" — an inproc id must be the bare SYMBOL NAME (e.g. World), not a path. A token containing "/" is matched as an HTTP route, which is wrong for a symbol. Skipping.`);
      continue;
    }
    if (/\s/.test(id)) { log(`  ${file}: symbol id "${id}" contains whitespace — ids must be a single symbol name. Skipping.`); continue; }
    if (!INPROC_ID_RE.test(id)) {
      log(`  ${file}: symbol id "${id}" is not a bare identifier — declare the item's own name (e.g. World, not ecs::World or World<T>): the matcher builds \\b${id}\\b and a qualified or parameterised spelling is not what the definition or the call sites write. Skipping.`);
      continue;
    }
    if (seen.has(id)) { log(`  ${file}: symbol id "${id}" is declared twice in this spec — keeping the first, skipping the rest.`); continue; }
    if (id.length < MIN_INPROC_ID_LEN || INPROC_ID_STOP.has(id.toLowerCase())) {
      log(`  ${file}: symbol id "${id}" cannot be a join key — it is ${id.length < MIN_INPROC_ID_LEN ? `shorter than ${MIN_INPROC_ID_LEN} characters` : 'a generic word that names something in almost every file'}. It would match unrelated code throughout both compartments and inflate the seam with pairs that have nothing to do with it. Skipping.`);
      continue;
    }

    const kind = r.kind == null ? 'type' : String(r.kind);
    if (!INPROC_KINDS.includes(kind)) {
      log(`  ${file}: symbol "${id}" has unknown kind "${kind}" (expected ${INPROC_KINDS.join(' | ')}). Skipping.`);
      continue;
    }

    // ONE provider. A list would be a different contract type: two compartments defining
    // the same symbol name is a duplication problem, not a one-way seam.
    const providers = strArray(r.provider);
    if (providers.length > 1) {
      log(`  ${file}: symbol "${id}" names ${providers.length} providers [${providers.join(', ')}] — an inproc seam has exactly ONE provider (that is what makes it one-way). Split it into one entry per seam, or name the real owner. Skipping.`);
      continue;
    }
    const provider = providers[0] || null;
    const consumers = strArray(r.consumers);
    if (!provider) {
      log(`  ${file}: symbol "${id}" declares no 'provider' — the provider is the compartment that DEFINES the symbol and is what gives the seam its direction. Skipping.`);
      continue;
    }
    if (!consumers.length) {
      log(`  ${file}: symbol "${id}" declares no 'consumers' — a seam needs a side that USES the symbol. A provider alone derives nothing and drifts as nothing. Skipping.`);
      continue;
    }
    // REFUSED, not warned about — the difference from the resource parser's overlap
    // warning, and it is deliberate. A resource legitimately has a compartment that both
    // writes and reads it (buildResourceEdges then skips the intra-compartment pairs and
    // the cross-compartment ones still derive). An inproc contract's whole claim is that
    // direction is ONE-WAY; a compartment on both sides of one id is a self-contradiction,
    // and keeping it would mean this type quietly stops checking the one thing it exists
    // to check.
    if (consumers.includes(provider)) {
      log(`  ${file}: symbol "${id}" names "${provider}" as BOTH provider and consumer. An in-process contract is one-way BY CONSTRUCTION — a compartment using its own exported symbol is the call graph's job, not a seam. Remove it from consumers:, or name the compartment that really uses it. Skipping.`);
      continue;
    }

    // NOT a rejection — see LIMITATION #2 in the header. Collected and reported ONCE per
    // spec below, without a ⚠, because a short symbol name is the expected shape here.
    if (!isDistinctive(id)) weak.push(id);

    seen.add(id);
    tokens.push(id);
    direction[id] = encodeInprocDirection({ kind, boundary });
    wireRoles.set(id, { producers: new Set([provider]), consumers: new Set(consumers) });
  }

  if (!tokens.length) { log(`  ${file}: no usable symbols — skipping`); return null; }
  if (weak.length) {
    log(`  ${file}: ${weak.length} id(s) [${weak.join(', ')}] are short/common names. They are matched as \\bname\\b across both compartments, so any unrelated symbol spelling the same name mints a reference too: expect an inflated seam and read "satisfied" as "both sides spell this name", not as "the consumer uses the provider's one". A reference from a compartment the spec does not name is reported as an undeclared participant.`);
  }
  return { id: contractId(name), name, file, tokens, direction, wireRoles, kind: 'inproc', inferred: isDraft === null ? doc['x-wiregraph-inferred'] === true : !!isDraft };
}
