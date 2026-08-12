// Resource / shared-state contracts — the SECOND contract type.
//
// A wire contract models caller -> route/message -> handler: request/reply over a
// wire. A RESOURCE contract models the other big class of cross-compartment
// coupling — two compartments joined not by a call or a message but by a SHARED
// RESOURCE: a file or sentinel path, a DB table+key, a shared-memory region, a
// named pipe / socket path. The roles are writer(s) and reader(s), not
// request/reply, and the semantics are presence/state ("A writes R, B reads R"),
// not a round trip.
//
// Format — `<name>.resource.yaml` (or .yml) in any contracts dir:
//
//   title: game-state-files          # -> contract name; MUST be unique across ALL specs
//   resources:
//     - id: GAME_STATE_PATH          # the CONSTANT NAME, never a path literal
//       kind: path                   # path | db | shm | pipe
//       semantics: presence-as-state # presence-as-state | last-writer-wins | append-log
//       single_writer: true          # optional declared discipline
//       writers: [alpha]
//       readers: [beta, gamma]
//
// WHY THE ID MUST BE A CONSTANT NAME, NOT A PATH. matchContracts (extract/
// contracts.js) branches on whether a token contains `/`: a `/`-bearing token takes
// the route-shaped pathTokenRegex branch, whose `{param}` wildcards and trailing
// boundary lookahead are built for HTTP routes and are wrong for a filesystem path.
// The identifier branch builds `\bGAME_STATE_PATH\b` and mints REFERENCES with
// correct enclosing-symbol attribution in every walked file, in every language, with
// NO extractor changes. So an id containing `/` is REJECTED with a clear message.
//
// DOCUMENTED LIMITATION (intended, not a bug): the join key is the shared CONSTANT
// NAME. A compartment that only ever writes the bare string literal
// ('/var/run/game/state.json') and never mentions the constant is MISSED. wiregraph
// is deliberately literal-blind; naming the constant is what makes the seam visible.
//
// DOCUMENTED LIMITATION #2, about `single_writer` specifically. wiregraph does NOT
// detect writes. A REFERENCES edge means "this symbol mentions the constant", never
// "this symbol writes through it" — there is no per-language table of filesystem/DB
// write APIs, by design. So `single_writer` is enforceable only against the
// DECLARATION: "this spec names two writers on a single-writer resource". The case
// that actually loses updates — an UNDECLARED second writer — cannot be identified as
// a writer at all, because nothing in the graph distinguishes a write from a read.
// What IS reported, exactly and without guessing, is an UNDECLARED PARTICIPANT: a
// compartment that references the resource while the spec names it as neither writer
// nor reader (store/sqlite-query.js#undeclaredParticipants). That is a strict superset
// of "an undeclared writer" and is the concrete thing to go and look at.
//
// The parser returns the SAME descriptor shape the AsyncAPI parser returns —
// {id, name, file, tokens, direction, wireRoles} — plus a `kind` discriminator, so
// mergeContracts / contractTokenMeta / matchContracts need no branch at all:
//   writers -> wireRoles.producers   (persisted to contract_tokens.producers)
//   readers -> wireRoles.consumers   (persisted to contract_tokens.consumers)
//   kind + semantics + single_writer -> the free-text contract_tokens.direction
//     column, via the `res:` encoding below. NO SCHEMA CHANGE (SCHEMA_VERSION 5).

import { basename } from 'node:path';
import { contractId } from '../model.js';
import { isDistinctive, whyNotDistinctive } from './distinctive.js';

export const RESOURCE_KINDS = ['path', 'db', 'shm', 'pipe'];
export const RESOURCE_SEMANTICS = ['presence-as-state', 'last-writer-wins', 'append-log'];
// Case-INSENSITIVE, matching both the discovery side (build.js#SPEC_FILE_RE,
// scripts/contracts.mjs) and the AsyncAPI parser pattern. See extract/contracts.js
// SPEC_PARSERS for why the two halves must not disagree.
export const RESOURCE_SPEC_RE = /\.resource\.ya?ml$/i;

// contract_tokens.direction is free text whose only existing values are 'c2s',
// 's2c' and NULL (extract/contracts.js classifyDirections). A resource token has no
// request/reply direction at all, so the column carries the resource's own metadata
// instead, behind a prefix that CANNOT collide with those three:
//
//   res:kind=path;semantics=presence-as-state;single_writer=1
//
// Keys and values are percent-encoded (encodeURIComponent escapes both `;` and `=`),
// so any future semantics/kind string round-trips losslessly. `single_writer` is
// omitted entirely when undeclared, which decodes back to null — distinct from a
// declared `false`.
export const RESOURCE_DIRECTION_PREFIX = 'res:';

export function encodeResourceDirection({ kind, semantics, singleWriter = null } = {}) {
  const e = (v) => encodeURIComponent(String(v));
  const parts = [`kind=${e(kind ?? 'path')}`, `semantics=${e(semantics ?? 'presence-as-state')}`];
  if (singleWriter != null) parts.push(`single_writer=${singleWriter ? '1' : '0'}`);
  return RESOURCE_DIRECTION_PREFIX + parts.join(';');
}

// null for anything that is NOT a resource direction ('c2s' / 's2c' / null /
// garbage), so every existing caller keeps its current behavior unchanged.
//
// Failures are RECORDED, never guessed at. Only wiregraph writes this column, so a
// value that does not decode means the row is corrupt — and the two silent-wrong
// behaviours this replaces both flipped a declared TRUE into an effective FALSE:
// a malformed percent-escape was swallowed by `catch { continue }`, and
// `single_writer=<anything but '1'>` decoded to `false`. Either way the
// single-writer violation simply stopped being reported, with nothing anywhere to
// say why. Now `singleWriter` stays null (UNKNOWN, distinct from a declared false)
// and `errors` is non-null, which trace_contract renders as its own line.
export function decodeResourceDirection(value) {
  if (typeof value !== 'string' || !value.startsWith(RESOURCE_DIRECTION_PREFIX)) return null;
  const out = { kind: null, semantics: null, singleWriter: null, errors: null };
  const fail = (msg) => { (out.errors ??= []).push(msg); };
  for (const pair of value.slice(RESOURCE_DIRECTION_PREFIX.length).split(';')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    if (i < 0) { fail(`field "${pair}" has no "=" separator`); continue; }
    let k, v;
    try { k = decodeURIComponent(pair.slice(0, i)); v = decodeURIComponent(pair.slice(i + 1)); }
    catch { fail(`field "${pair}" is not valid percent-encoding`); continue; }
    if (k === 'kind') out.kind = v;
    else if (k === 'semantics') out.semantics = v;
    else if (k === 'single_writer') {
      if (v === '1') out.singleWriter = true;
      else if (v === '0') out.singleWriter = false;
      else fail(`single_writer="${v}" is neither "1" nor "0" — the declared discipline is UNKNOWN, not false`);
    } else fail(`unknown field "${k}"`);
  }
  return out;
}

const strArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

// Parse ONE *.resource.yaml doc into a raw contract descriptor (no graph mutation).
// Returns null when the doc yields nothing usable; every rejection is logged with a
// message that names the file and says what to fix.
export function parseResourceSpec(doc, file, log = () => {}, isDraft = null) {
  const title = typeof doc?.title === 'string' && doc.title.trim() ? doc.title.trim() : null;
  const name = title || basename(file).replace(RESOURCE_SPEC_RE, '');
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.resources)) {
    log(`  ${file}: not a resource spec — expected a top-level 'resources:' list; skipping`);
    return null;
  }
  // The title is the contract's identity: contractId(name) is what merges specs, what a
  // cross-format collision is judged on, and what `trace_contract <substring>` searches.
  // Falling back to the filename is a convenience, not a design — two specs named
  // `state.resource.yaml` in two different contracts dirs would collide on it silently.
  if (!title) {
    log(`  ⚠ ${file}: no 'title:' — falling back to the filename "${name}" as the contract name. Titles must be unique across every spec; add an explicit title.`);
  }

  // `x-wiregraph-inferred: true` — written by synthesizeResourceSpec, never by a human.
  // TOTAL role overlap (every participant on both sides) is the DEFINED shape of a
  // generated draft: nothing in code says which side writes, so the emitter lists all of
  // them and the header tells the reviewer to prune. Warning about it means one ⚠ per
  // resource on EVERY build, forever, through normal build output, using the same marker
  // as a genuine problem — noise that trains the user to ignore the marker, and a direct
  // contradiction of "the generated spec loads cleanly with zero warnings".
  //
  // It stays a warning for a HAND-WRITTEN spec, where naming every compartment on both
  // sides really is a mistake and the author has no header telling them so. That split is
  // the whole point, and it is pinned in BOTH directions by test/run.mjs: the draft loads
  // with zero ⚠, the same content WITHOUT this key warns.
  //
  // THE VERDICT IS THE LOADER'S, not this function's. `isDraft` is
  // extract/contracts.js#isGeneratedDraft's answer — marker AND content, because the
  // marker alone let a spec the user had already pruned keep counting as a draft. Reading
  // the marker here independently would let one file be a draft for the warning and a
  // human's spec for id precedence. Falling back to the bare marker keeps the direct
  // callers (unit tests, any external user of this parser) behaving exactly as before.
  const isInferredDraft = isDraft === null ? doc['x-wiregraph-inferred'] === true : !!isDraft;

  const tokens = [];
  const direction = {};
  const wireRoles = new Map();
  const seen = new Set();

  for (const r of doc.resources) {
    if (!r || typeof r !== 'object') { log(`  ${file}: skipping a non-object entry under 'resources:'`); continue; }
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) { log(`  ${file}: skipping a resource with no 'id' (the id is the shared CONSTANT NAME)`); continue; }
    if (id.includes('/')) {
      log(`  ${file}: resource id "${id}" contains "/" — a resource id must be the CONSTANT NAME (e.g. GAME_STATE_PATH), not a path literal. A token containing "/" is matched as an HTTP route, which is wrong for a shared resource. Skipping.`);
      continue;
    }
    if (/\s/.test(id)) { log(`  ${file}: resource id "${id}" contains whitespace — ids must be a single constant name. Skipping.`); continue; }
    if (seen.has(id)) { log(`  ${file}: resource id "${id}" is declared twice in this spec — keeping the first, skipping the rest.`); continue; }
    // The SAME distinctiveness gate every AsyncAPI token passes (extract/distinctive.js).
    // A resource id becomes `\bid\b` in matchContracts and is run against every source
    // file in every compartment, so a generic one is not a weak signal — it is a firehose:
    // `id` matches essentially every file ever written, minting REFERENCES everywhere and
    // up to MAX_PAIRS_PER_TOKEN phantom writer->reader seams. This was the one path into
    // the token index with no distinctiveness check at all.
    if (!isDistinctive(id)) {
      log(`  ${file}: resource id "${id}" is not distinctive enough to be a join key — ${whyNotDistinctive(id)}. It would match unrelated code in every compartment and mint phantom seams. Skipping.`);
      continue;
    }

    const kind = r.kind == null ? 'path' : String(r.kind);
    if (!RESOURCE_KINDS.includes(kind)) {
      log(`  ${file}: resource "${id}" has unknown kind "${kind}" (expected ${RESOURCE_KINDS.join(' | ')}). Skipping.`);
      continue;
    }
    const semantics = r.semantics == null ? 'presence-as-state' : String(r.semantics);
    if (!RESOURCE_SEMANTICS.includes(semantics)) {
      log(`  ${file}: resource "${id}" has unknown semantics "${semantics}" (expected ${RESOURCE_SEMANTICS.join(' | ')}). Skipping.`);
      continue;
    }

    const writers = strArray(r.writers);
    const readers = strArray(r.readers);
    if (!writers.length && !readers.length) {
      log(`  ${file}: resource "${id}" declares neither writers nor readers — nothing to join. Skipping.`);
      continue;
    }
    // Both roles naming the same compartment is not a seam at all: buildResourceEdges
    // skips every intra-compartment pair, so the resource silently contributes nothing
    // — it looks declared and behaves as if it were not there.
    const bothSides = writers.filter((w) => readers.includes(w));
    // TOTAL overlap across two or more compartments is a different situation from a
    // partial one, and since 1b-ii it is the shape inference itself emits: nothing in
    // code says which side writes, so a draft lists every participant on both sides. That
    // still derives edges (every CROSS-compartment pair, in both directions) — telling
    // the user it "derives NO edges" would be simply wrong. The partial case keeps the
    // original wording: there one compartment is genuinely doubling as its own reader.
    const totalOverlap = bothSides.length >= 2 && bothSides.length === writers.length && bothSides.length === readers.length;
    if (totalOverlap && !isInferredDraft) {
      log(`  ⚠ ${file}: resource "${id}" names every compartment [${bothSides.join(', ')}] as BOTH writer and reader — roles are UNRESOLVED (an inferred draft looks like this). Same-compartment pairs are skipped, so it still derives a seam for every cross-compartment pair, in BOTH directions, until you delete the wrong side of each list.`);
    } else if (bothSides.length && !totalOverlap) {
      log(`  ⚠ ${file}: resource "${id}" names [${bothSides.join(', ')}] as BOTH writer and reader. A resource seam is cross-compartment by definition, so every same-compartment pair is skipped; if that is the only overlap this resource derives NO edges. Intra-compartment state belongs to the call graph, not to a contract.`);
    }
    const singleWriter = r.single_writer === true ? true : (r.single_writer === false ? false : null);
    if (singleWriter && !writers.length) {
      log(`  ${file}: resource "${id}" declares single_writer: true but lists NO writers — a single-writer discipline with no writer to hold it is unenforceable and says nothing. Name the writer, or drop single_writer. Skipping.`);
      continue;
    }
    if (singleWriter && writers.length > 1) {
      log(`  ⚠ ${file}: resource "${id}" declares single_writer but lists ${writers.length} writers (${writers.join(', ')}) — surfaced as a VIOLATION in trace_contract.`);
    }

    seen.add(id);
    tokens.push(id);
    direction[id] = encodeResourceDirection({ kind, semantics, singleWriter });
    wireRoles.set(id, { producers: new Set(writers), consumers: new Set(readers) });
  }

  if (!tokens.length) { log(`  ${file}: no usable resources — skipping`); return null; }
  // `inferred` travels with the descriptor because PRECEDENCE depends on it: a
  // hand-written spec must beat a generated draft for ownership of a resource id no
  // matter which dir the loader happened to read first (extract/contracts.js). It is the
  // same `x-wiregraph-inferred` marker the total-overlap warning above is gated on — one
  // marker, two consumers, so a draft cannot be a draft for one purpose and not the other.
  return { id: contractId(name), name, file, tokens, direction, wireRoles, kind: 'resource', inferred: isInferredDraft };
}
