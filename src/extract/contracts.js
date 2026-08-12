// Cross-compartment wire edges via the contracts dir.
//
// Compartments that don't call each other in-process may still agree on wire
// shapes published in an AsyncAPI contracts dir. So the join between a producer in
// one compartment and the consumer in another that answers it is the *contract*,
// not a call edge. We model each contract file as a Contract node, pull out the
// distinctive wire tokens it defines (channel address paths + snake_case payload
// fields), then attach any code symbol whose body mentions one of those tokens
// to the Contract via a REFERENCES edge tagged evidence:'contract-match'.
//
// This is a heuristic, by construction: a REFERENCES edge means "this code
// mentions a string this contract defines", not "verified to implement it".
// The evidence tag keeps that honest for downstream queries.

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, dirname, sep, relative } from 'node:path';
import YAML from 'yaml';
import { contractId } from '../model.js';
import { walkSources } from './walk.js';
import { parseResourceSpec } from './resource-spec.js';
import { parseInprocSpec } from './inproc-spec.js';
import { isDistinctive } from './distinctive.js';

// isDistinctive now lives in its own leaf module (extract/distinctive.js) so BOTH
// spec parsers can use it without contracts.js <-> resource-spec.js becoming a
// module cycle. Re-exported here because that is where every existing importer
// (contracts/infer.js, the test suite) looks for it.
export { isDistinctive };

// A channel `address` -> the matchable token: a path keeps its FULL parameterized
// form (params already in AsyncAPI `{name}` form) as a stable identity — only
// collapsing duplicate slashes and stripping a trailing slash (except the root
// `/`); a non-path (topic / routing key / env var) is matched literally. Shared by
// collectTokens and the wire-role reader so both key on the exact same token that
// lands on REFERENCES edges (and drift). Path tokens are matched via pathTokenRegex,
// so each `{param}` segment matches the route however source writes it (`:id`,
// `${id}`, `{id}`, or a concrete value). null = no matchable token.
export function normalizeAddress(addr) {
  if (typeof addr !== 'string' || !addr) return null;
  if (addr.startsWith('/')) {
    const norm = addr.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return norm || '/';
  }
  return addr;
}

// Escape the literal (non-param) parts of a path segment for use inside a RegExp.
const escapePathLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One source path segment written as a parameter: `:id`, `${id}`, `{id}`, or a bare
// concrete value like `123` / `id`.
const PARAM_WILDCARD = '(?::?\\$?\\{?[A-Za-z0-9_]+\\}?)';

// Build a RegExp that matches a path token (e.g. `/orders/{id}/items`) against the
// same route as written in source — `{param}` segments become one-segment wildcards
// (a param can also be only PART of a segment, e.g. `/files/{name}.json` keeps
// `.json` literal). A trailing boundary lookahead keeps `/orders/{id}/items` from
// matching `/orders/:id/itemsFoo`; the literal `/` between statics already stops
// `/orders` matching `/orderstatus`, so no leading anchor is needed. The lookahead
// also forbids a trailing `/` OR `}`, so a bare route never matches a LONGER nested
// route: `/orders/{id}` must match neither the server form `/orders/:id/items` (the
// `/` blocks it) nor the client template literal `/orders/${id}/items` (where the `}`
// of `${id}` would otherwise read as a false route terminator). Otherwise a phantom
// REFERENCES edge — and, when both sides hit, a WIRE seam — is minted for a route
// nothing actually calls. A route that truly ENDS in `${id}` still matches: `\}?`
// consumes the closing brace and the real terminator (quote/backtick/end) follows.
//
// AN UNROOTED ADDRESS (`player/updates`, no leading slash) gets a boundary instead of the
// literal `/`. This is the idiomatic AsyncAPI 2.x channel spelling — the 2.x channel KEY
// is the address and conventionally carries no leading slash
// (`smartylighting/streetlights/event/lighting/measured`) — so without it, reading 2.x
// channel keys as tokens (see channelAddresses) would light up the token list and still
// match nothing: the compiled regex demanded a `/` the source never writes.
// `(?<![A-Za-z0-9_])` is deliberately a SUPERSET of the old `'/'` prefix, not a
// replacement for it — a slash is not in the class, so every occurrence that matched
// before still matches (including a rooted `/player/updates` in source), and the only new
// matches are the unrooted ones. A 3.0 spec written with an unrooted `address:` gains the
// same fix; nothing anywhere loses a match.
export function pathTokenRegex(tok) {
  const segments = tok.split('/').filter(Boolean).map((seg) => {
    let out = '';
    let last = 0;
    const param = /\{[^}]*\}/g;
    let m;
    while ((m = param.exec(seg)) !== null) {
      out += escapePathLiteral(seg.slice(last, m.index)) + PARAM_WILDCARD;
      last = m.index + m[0].length;
    }
    return out + escapePathLiteral(seg.slice(last));
  });
  return new RegExp((tok.startsWith('/') ? '/' : '(?<![A-Za-z0-9_])') + segments.join('/') + '(?![A-Za-z0-9_/}])');
}

// ============================================================================
// THE WIRE CONTRACT FORMAT — the only description of it that exists anywhere.
// ============================================================================
// The prose docs (`docs/contracts.html`, `commands/wiregraph-contracts.md`) now cover
// all three spec formats, this one included — the doc wave the earlier note here asked
// for happened. This block stays anyway, and NOT as a duplicate: prose about a format
// can drift from the parser, and the parser cannot drift from itself. Treat what is
// written here as the truth and the docs as the introduction; if they disagree, the
// docs are wrong.
//
// FILE: `<anything>.asyncapi.yaml` (or `.yml`, case-insensitive) in a contracts dir.
//
//   asyncapi: '3.0.0'                 # 2.x is ALSO read — see the version note below
//   info:
//     title: Server Wire              # -> the contract's NAME **and its identity**:
//     version: '1.0.0'                #    contractId() derives SOLELY from this title.
//   channels:
//     orders:                         # 3.0: the key is an arbitrary id, NOT the address
//       address: /orders/{id}         # 3.0: THIS is the matchable token
//       x-wiregraph-producers: [netcli]   # compartment NAMES that send/call
//       x-wiregraph-consumers: [netsrv]   # compartment NAMES that receive/handle
//       messages:
//         request:
//           payload:
//             type: object
//             properties:
//               player_token: { type: string }   # field NAMES are tokens too (below)
//   operations:
//     receive-orders:
//       action: receive               # receive = client -> server (c2s); send = s2c
//       channel: { $ref: '#/channels/orders' }
//       messages: [{ $ref: '#/channels/orders/messages/request' }]
//
// WHAT BECOMES A MATCHABLE TOKEN (collectTokens):
//   1. every channel ADDRESS (3.0 `address:`; 2.x the channel KEY — see below), and
//   2. every key under ANY `properties:` map anywhere in the doc — i.e. payload FIELD
//      NAMES. This is deliberate and long-standing: a message-based seam has no route
//      to match on, so the payload's field names are the join key.
//   Both are then filtered by isDistinctive (extract/distinctive.js): a token must be a
//   6+ char snake_case/SCREAMING name, a dotted/colon topic, a 10+ char camelCase
//   identifier, or a 5+ char `/`-path that is not a generic route.
//
//   CONSEQUENCE, stated because it surprises people (and was reported as a defect): a
//   payload field that no code mentions is a DEFINED token with no REFERENCES, which
//   trace_contract renders as 🔴 DRIFT on an otherwise healthy contract. That is the
//   drift report doing exactly what it is built to do — the spec declares a field the
//   code does not use — but on a big payload schema it buries the one route that really
//   is unimplemented. NARROWING IT WAS CONSIDERED AND REJECTED HERE: field-name tokens
//   are what make every message/topic seam match at all, so dropping them would take
//   whole classes of seam dark to fix a REPORTING problem. The right fix belongs in the
//   classifier, not the harvester — `classifyContractToken` (store/sqlite-query.js)
//   should learn a distinct verdict for "declared payload field, never referenced", so
//   it stops sharing a bucket with "declared route, never implemented". That is its own
//   change with its own report wording, so it is recorded here rather than smuggled in.
//
// ROLES: `x-wiregraph-producers` / `x-wiregraph-consumers` hold COMPARTMENT NAMES and
// are what let buildWireEdges orient a seam with no WIREGRAPH_SERVER_REPO env var. They
// are optional; without them a hand-written spec derives REFERENCES and a Contract node
// but no directional WIRE edge unless that env var names the server compartment.
//
// ASYNCAPI VERSION — 2.x AND 3.x ARE BOTH READ.
// In 2.x there is no `address:` field: the CHANNEL KEY *is* the address
// (`channels: { 'player/updates': { publish: …, subscribe: … } }`), and operations are
// the `publish`/`subscribe` members of the channel rather than a top-level `operations`
// map. Reading only 3.0's `address:` made an entire 2.x spec load as ZERO channel
// tokens with no diagnostic anywhere — the contract still appeared, carrying only its
// payload field names, and looked healthy. So 2.x channel keys are read, and 2.x
// publish/subscribe is classified (2.x is server-perspective: `publish` = something
// publishes TO the app = c2s; `subscribe` = the app publishes = s2c).
//
// WHY SUPPORT IT RATHER THAN JUST WARN: AsyncAPI 3.0 shipped at the end of 2023 and 2.x
// remains the version most published specs in the wild are written in, so "warn and
// refuse" leaves a user holding a correct spec and an empty graph. The support is
// VERSION-GATED (`asyncapiMajor(doc) === 2`), so the 3.0 path is untouched — a 3.0
// channel key is an arbitrary id and must never be read as an address. A doc whose
// version is neither 2 nor 3, and any doc that yields NO tokens at all, is warned about
// loudly and by name (parseContract) — that is the diagnostic whose absence made the
// original failure silent.
// ============================================================================

// Major version of an AsyncAPI doc: 2, 3, … or null when there is no parseable
// `asyncapi:` field at all (a hand-written spec that omits it is treated as 3.x-shaped,
// which is what every previously-working spec relied on).
function asyncapiMajor(doc) {
  const m = /^\s*(\d+)/.exec(String(doc?.asyncapi ?? ''));
  return m ? Number(m[1]) : null;
}

// `{ key, ch, address }` per channel, with the ONE version difference that matters
// resolved in ONE place: 3.x takes `address:`, 2.x takes the channel KEY. Both
// collectTokens and readWireRoles ride this, so a token can never exist on one side and
// not the other (which is precisely how a 2.x spec produced roles for addresses that
// were never tokens, and tokens for fields that had no roles).
function channelAddresses(doc) {
  const out = [];
  const chans = doc?.channels;
  if (!chans || typeof chans !== 'object' || Array.isArray(chans)) return out;
  const legacy = asyncapiMajor(doc) === 2;
  for (const [key, ch] of Object.entries(chans)) {
    if (!ch || typeof ch !== 'object') continue;
    const raw = typeof ch.address === 'string' ? ch.address : (legacy ? key : null);
    const address = normalizeAddress(raw);
    if (address) out.push({ key, ch, address });
  }
  return out;
}

// Walk a parsed YAML doc collecting every key that sits under a "properties"
// map, plus channel address paths (with {param} segments trimmed to a prefix).
function collectTokens(doc) {
  const tokens = new Set();

  // 2.x ONLY. The generic walk below already adds every 3.x `address:` value, so this
  // adds nothing on a 3.0 doc — and it is gated anyway, both because a 3.0 channel key
  // is an arbitrary id that must not become a token and so the 3.0 token ORDER stays
  // byte-identical to what it has always been.
  if (asyncapiMajor(doc) === 2) for (const { address } of channelAddresses(doc)) tokens.add(address);

  (function walk(node, parentKey) {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, parentKey);
      return;
    }
    if (node && typeof node === 'object') {
      if (parentKey === 'properties') {
        for (const k of Object.keys(node)) tokens.add(k);
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'address') {
          const t = normalizeAddress(v);
          if (t) tokens.add(t);
        }
        walk(v, k);
      }
    }
  })(doc, null);

  return [...tokens].filter(isDistinctive);
}

// Read the producer/consumer compartments the inference encoded per channel, keyed
// by the same normalized token REFERENCES edges use. Empty when a (hand-written)
// spec carries no x-wiregraph-* extensions — buildWireEdges then falls back to env.
function readWireRoles(doc) {
  const roles = new Map();
  for (const { ch, address: tok } of channelAddresses(doc)) {
    const producers = new Set(Array.isArray(ch['x-wiregraph-producers']) ? ch['x-wiregraph-producers'] : []);
    const consumers = new Set(Array.isArray(ch['x-wiregraph-consumers']) ? ch['x-wiregraph-consumers'] : []);
    if (producers.size || consumers.size) roles.set(tok, { producers, consumers });
  }
  return roles;
}

// --- direction inference ----------------------------------------------------
// Follow a #/-style JSON pointer within the doc.
function resolveRef(doc, ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const p of parts) { if (cur == null) return null; cur = cur[p]; }
  return cur;
}
// Follow $ref chains (message ref -> channel message -> component message).
function deref(doc, node) {
  let n = node, guard = 0;
  while (n && n.$ref && guard++ < 10) n = resolveRef(doc, n.$ref);
  return n;
}
function messagePayload(doc, msgRef) {
  const m = deref(doc, msgRef);
  return m ? deref(doc, m.payload) : null;
}
function collectSchemaTokens(doc, schema, out, depth = 0) {
  const s = deref(doc, schema);
  if (!s || depth > 8) return;
  if (s.properties && typeof s.properties === 'object') {
    for (const [k, v] of Object.entries(s.properties)) { out.add(k); collectSchemaTokens(doc, v, out, depth + 1); }
  }
  if (s.items) collectSchemaTokens(doc, s.items, out, depth + 1);
  for (const comb of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(s[comb])) s[comb].forEach((x) => collectSchemaTokens(doc, x, out, depth + 1));
  }
}
// Returns { token: 'c2s' | 's2c' }. c2s = terminal/client -> server (request),
// s2c = server -> terminal (reply). Contracts are server-perspective: an
// operation with action:receive means the server receives the request.
function classifyDirections(doc) {
  const dir = {};
  const tag = (msgRefs, direction) => {
    if (!Array.isArray(msgRefs)) return;
    for (const ref of msgRefs) {
      const toks = new Set();
      collectSchemaTokens(doc, messagePayload(doc, ref), toks);
      for (const t of toks) if (isDistinctive(t) && !(t in dir)) dir[t] = direction;
    }
  };
  // 2.x: there is no top-level `operations` map — an operation is the `publish` or
  // `subscribe` member of a channel. Same server perspective as 3.0's send/receive:
  // `publish` describes what is published TO the application (c2s), `subscribe` what
  // the application publishes out (s2c). `message` may be a single message or a
  // `oneOf` list, so both shapes are fed to the same tagger.
  if (asyncapiMajor(doc) === 2) {
    for (const { ch } of channelAddresses(doc)) {
      for (const [verb, direction] of [['publish', 'c2s'], ['subscribe', 's2c']]) {
        const op = ch[verb];
        if (!op || typeof op !== 'object') continue;
        const msg = op.message;
        tag(Array.isArray(msg?.oneOf) ? msg.oneOf : (msg ? [msg] : []), direction);
      }
    }
    return dir;
  }
  for (const op of Object.values(doc.operations || {})) {
    const reqDir = op.action === 'send' ? 's2c' : 'c2s';
    tag(op.messages, reqDir);
    if (op.reply) tag(op.reply.messages, reqDir === 'c2s' ? 's2c' : 'c2s');
  }
  return dir;
}

// Parse ONE AsyncAPI doc into a raw contract descriptor (no graph mutation).
// `isDraft` is readContractsDir's authorship verdict (null when this parser is called
// directly, e.g. a unit test) — see isGeneratedDraft.
function parseContract(doc, f, log = () => {}, isDraft = null) {
  const name = doc?.info?.title || basename(f).replace(ASYNCAPI_SPEC_RE, '');
  const id = contractId(name);
  const tokens = collectTokens(doc);
  const direction = classifyDirections(doc);
  // Channel address paths are endpoints the client calls -> client to server.
  for (const t of tokens) if (t.startsWith('/') && !(t in direction)) direction[t] = 'c2s';
  const wireRoles = readWireRoles(doc);

  // --- the diagnostics whose ABSENCE made the 2.x failure silent ---------------
  // A spec that yields no tokens still produces a Contract node, still reports as
  // "loaded 1 contract(s)", and derives absolutely nothing — the exact shape of the
  // AsyncAPI 2.x report (`loaded 1 contract(s) …; 0 wire tokens`, `matched 0 contract
  // REFERENCES edges`, `trace_contract` finds no contract). There was no warning
  // anywhere, in any mode, so nothing pointed at the spec. Both branches name the FILE
  // and the VERSION, because "which of my specs is dead" is the question being asked.
  const major = asyncapiMajor(doc);
  const version = doc?.asyncapi ? String(doc.asyncapi) : '(no asyncapi: field)';
  if (major !== null && major !== 2 && major !== 3) {
    log(`  ⚠ ${f}: asyncapi ${version} — wiregraph reads AsyncAPI 2.x and 3.x only. Channel addresses and operations are read with the 3.x rules, which may find nothing. Downgrade the spec, or open an issue naming the version.`);
  } else if (!tokens.length) {
    log(`  ⚠ ${f}: asyncapi ${version} — this spec defines NO matchable tokens, so it will mint no REFERENCES and derive no seam (it still loads as a contract, which is why this looked healthy). A token comes from a channel ADDRESS (3.x \`address:\`, 2.x the channel KEY) or a payload \`properties:\` field name, and each must pass the distinctiveness gate: 6+ char snake_case/SCREAMING name, a dotted/colon topic, a 10+ char camelCase name, or a 5+ char non-generic /path.`);
  }
  return { id, name, file: f, tokens, direction, wireRoles, kind: 'asyncapi', asyncapiMajor: major, inferred: isDraft === null ? doc?.[INFERRED_MARKER_KEY] === true : !!isDraft };
}

// Format dispatch: filename pattern -> parser. Both parsers return the SAME raw
// descriptor shape ({id, name, file, tokens, direction, wireRoles, kind}), so the
// only per-format code in the whole pipeline is this table plus the two parsers —
// mergeContracts, contractTokenMeta and matchContracts stay format-blind. A parser
// may return null to reject a doc (with its own log message).
//
// CASE: both patterns are case-INSENSITIVE, matching the DISCOVERY side
// (build.js#SPEC_FILE_RE and scripts/contracts.mjs#hasTopLevelSpec, both `/i` since
// long before resource specs existed). The two halves must agree or a dir is promoted
// to a contracts home and then parses zero specs out of it — `Contracts/X.AsyncAPI.YAML`
// discovered, silently ignored, no diagnostic anywhere. Insensitive is the direction
// that keeps every currently-DISCOVERED file working; the alternative (making
// discovery sensitive) would newly orphan dirs that are found today.
const ASYNCAPI_SPEC_RE = /\.asyncapi\.ya?ml$/i;
const RESOURCE_SPEC_NAME_RE = /\.resource\.ya?ml$/i;
const INPROC_SPEC_NAME_RE = /\.inproc\.ya?ml$/i;

// The kinds whose id is a bare JOIN KEY the user chose, rather than a token harvested out
// of a schema. Both are subject to the same cross-contract uniqueness rule below, share ONE
// id namespace (they end up in the SAME token index in matchContracts, so two contracts
// claiming one name is the same defect whichever formats they came from), and a contract
// that loses every id to a collision is dropped rather than left as an empty node.
const JOIN_KEY_KINDS = new Set(['resource', 'inproc']);
// Cross-format title precedence, strongest first. AsyncAPI is the incumbent and always
// wins; resource predates inproc. Order-based "keep whichever was read first" is what this
// replaces — see the collision block in loadAllContracts.
const KIND_PRECEDENCE = ['asyncapi', 'resource', 'inproc'];
// The filenames wiregraph itself writes for a generated draft: `wiregraph-inferred
// .asyncapi.yaml` and `wiregraph-inferred.resource.yaml` (scripts/contracts.mjs) and the
// same pair under `.wiregraph/inferred/` (scripts/lib/links.mjs).
//
// IT IS NO LONGER AN AUTHORSHIP SIGNAL ON ITS OWN — see isGeneratedDraft. A filename is
// not a statement about who wrote the CONTENT, and OR-ing it with the marker destroyed
// user edits by following the draft's own documented workflow.
const INFERRED_SPEC_NAME_RE = /^wiregraph-inferred[.-]/i;
const SPEC_PARSERS = [
  { match: ASYNCAPI_SPEC_RE, parse: (doc, f, log, isDraft) => parseContract(doc, f, log, isDraft) },
  // The literal is repeated (rather than importing RESOURCE_SPEC_RE) so this module
  // needs NOTHING from resource-spec.js at module-evaluation time — only its hoisted
  // parser function. See extract/distinctive.js for why that matters.
  { match: RESOURCE_SPEC_NAME_RE, parse: (doc, f, log, isDraft) => parseResourceSpec(doc, f, log, isDraft) },
  { match: INPROC_SPEC_NAME_RE, parse: (doc, f, log, isDraft) => parseInprocSpec(doc, f, log, isDraft) },
];

// The filename patterns this module actually PARSES, exported for ONE purpose: the suite
// pins them against src/contracts-dirs.js#SPEC_FORMATS, which is the list the contracts
// FINGERPRINT hashes. Those two drifting apart is not a cosmetic mismatch — a format the
// loader parses but the fingerprint cannot see is added, edited, moved between contracts
// dirs and deleted without ever tripping incrementalBuild's contractsDrift refusal, so the
// save loop re-derives its seams over REFERENCES rows minted under a scope that no longer
// exists. That is exactly what shipped for `*.inproc.yaml`.
export const SPEC_PARSER_PATTERNS = SPEC_PARSERS.map((p) => p.match);

// filename -> the kind its parser will produce, for the ONE caller that needs the kind
// BEFORE the parse (readContractsDir, which must hand isGeneratedDraft a kind). Kept
// beside SPEC_PARSERS so a fourth format cannot add a parser and forget this.
function specKindFor(f) {
  if (RESOURCE_SPEC_NAME_RE.test(f)) return 'resource';
  if (INPROC_SPEC_NAME_RE.test(f)) return 'inproc';
  return 'asyncapi';
}

// ============================================================================
// AUTHORSHIP — is this spec wiregraph's own draft, or a human's declaration?
// ============================================================================
// This one boolean decides three things, and gets one of them catastrophically wrong if
// it over-claims: whether inference may re-propose the spec's tokens (handWrittenTokens),
// who wins a duplicate resource-id collision (loadAllContracts), and whether the
// all-both-roles shape is the EXPECTED draft placeholder or a hand-written mistake
// (resource-spec.js). Misclassifying a human's spec as a draft is the damaging direction:
// its ids are re-proposed, `apply` writes a competing draft over them, and the pruned
// writers/readers plus a declared `single_writer` are replaced by the placeholder.
//
// THE OLD RULE WAS `marker === true || filename matches`, and the OR is what broke.
// The draft's own header used to instruct the reader to prune the role lists and then
// DELETE the marker; doing exactly that left the FILENAME still voting "draft", so the
// documented workflow destroyed the edits it asked for. A hand-written spec that merely
// happened to be NAMED `wiregraph-inferred.resource.yaml` lost every id the same way.
//
// AUTHORSHIP IS NOW DECIDED BY CONTENT, in three layers, from strongest evidence down:
//
//   1. THE DIGEST (exact). Every draft written from now on carries
//      `x-wiregraph-digest`: a hash of its own generated content (contracts/infer.js
//      stamps it; specContentDigest below recomputes it). It matches iff the file is
//      byte-for-byte the proposal wiregraph made, modulo comments and key order. ANY
//      semantic edit — pruning a role list, adding `single_writer`, deleting a resource,
//      filling in a payload schema — makes it stop matching, and the file becomes the
//      user's. This is what lets the header stop telling people to delete the marker:
//      editing the file IS how you claim it, and no ritual is required.
//   2. THE MARKER ALONE, for a draft written before digests existed. `x-wiregraph-
//      inferred: true` is the emitter's signature and no human types it by accident, so
//      with no digest to compare against it is still trusted. This is a TRANSITIONAL
//      case only — every draft the current emitters write carries a digest — and it can
//      only misfire on a file that copied the marker in by hand.
//   3. THE FILENAME, and ONLY when the content still has the emitter's exact shape.
//      Wire drafts predate the marker entirely (synthesizeAsyncApi never wrote one), so
//      dropping the filename outright would reclassify every existing wire draft as
//      hand-written and freeze inference behind it. Requiring the shape keeps those
//      drafts working while making the filename incapable of overruling content: a
//      pruned draft, and a hand-written spec that merely borrowed the name, both fail
//      the shape test and win.
//
// Nothing here can promote a spec a human wrote into a draft unless that human wrote,
// byte for byte, what the generator emits — at which point the two are the same document.

export const INFERRED_MARKER_KEY = 'x-wiregraph-inferred';
export const INFERRED_DIGEST_KEY = 'x-wiregraph-digest';

// A stable digest of a spec's SEMANTIC content: keys sorted at every level, the digest
// key itself excluded (it cannot cover itself), comments and formatting invisible because
// they never survive YAML.parse. Both the emitter (contracts/infer.js) and this loader run
// it over the PARSED doc, so a re-serialization or a reflowed list cannot forge an edit,
// and a real edit cannot hide behind one.
export function specContentDigest(doc) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === INFERRED_DIGEST_KEY) continue;
        out[k] = canon(v[k]);
      }
      return out;
    }
    return v === undefined ? null : v;
  };
  return createHash('sha1').update(JSON.stringify(canon(doc))).digest('hex').slice(0, 16);
}

// THE RESOURCE DRAFT'S OWN SHAPE, exactly as synthesizeResourceSpec emits it: every
// participating compartment listed as BOTH a writer and a reader (the symmetric
// placeholder, because nothing in code says which side writes), and `single_writer` never
// emitted at all (it is a declared discipline — inventing one manufactures violations).
//
// So a resource whose writers are not the readers, or which declares a discipline, is a
// human's statement of intent, and ONE such resource is enough to make the whole file the
// user's: a half-pruned draft is a file somebody has already started editing.
function resourceDraftShaped(doc) {
  const list = Array.isArray(doc?.resources) ? doc.resources : null;
  if (!list || !list.length) return false;
  for (const r of list) {
    if (!r || typeof r !== 'object') return false;
    if (r.single_writer !== undefined && r.single_writer !== null) return false;
    const w = Array.isArray(r.writers) ? r.writers : [];
    const rd = Array.isArray(r.readers) ? r.readers : [];
    // >= 2 because a seam is cross-compartment by definition, so that is the smallest
    // placeholder inference can emit.
    if (w.length < 2 || w.length !== rd.length) return false;
    const ws = new Set(w.map(String)), rs = new Set(rd.map(String));
    if (ws.size !== w.length || rs.size !== rd.length) return false;
    for (const x of ws) if (!rs.has(x)) return false;
  }
  return true;
}

// THE WIRE DRAFT'S OWN SHAPE, exactly as synthesizeAsyncApi emits it — nothing but the
// keys it writes, one `request` message per channel whose payload is the EMPTY
// `{type: object, properties: {}}` skeleton, and every operation `action: receive`.
// Filling in a payload schema, adding a description, a server, a reply, or a second
// message is what reviewing a draft looks like, and any of them ends its draft status.
const DRAFT_TOP_KEYS = new Set(['asyncapi', 'info', 'channels', 'operations', INFERRED_MARKER_KEY, INFERRED_DIGEST_KEY]);
const DRAFT_CHANNEL_KEYS = new Set(['address', 'messages', 'x-wiregraph-producers', 'x-wiregraph-consumers']);
const DRAFT_OP_KEYS = new Set(['action', 'channel', 'messages']);
function asyncApiDraftShaped(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  if (doc.asyncapi !== '3.0.0') return false;
  for (const k of Object.keys(doc)) if (!DRAFT_TOP_KEYS.has(k)) return false;
  if (!doc.info || typeof doc.info !== 'object') return false;
  for (const k of Object.keys(doc.info)) if (k !== 'title' && k !== 'version') return false;
  const chans = doc.channels;
  if (!chans || typeof chans !== 'object' || Array.isArray(chans) || !Object.keys(chans).length) return false;
  for (const ch of Object.values(chans)) {
    if (!ch || typeof ch !== 'object') return false;
    for (const k of Object.keys(ch)) if (!DRAFT_CHANNEL_KEYS.has(k)) return false;
    if (typeof ch.address !== 'string') return false;
    const msgs = ch.messages;
    if (!msgs || typeof msgs !== 'object') return false;
    const mk = Object.keys(msgs);
    if (mk.length !== 1 || mk[0] !== 'request') return false;
    const req = msgs.request;
    if (!req || typeof req !== 'object' || Object.keys(req).length !== 1) return false;
    const payload = req.payload;
    if (!payload || typeof payload !== 'object' || payload.type !== 'object') return false;
    for (const k of Object.keys(payload)) if (k !== 'type' && k !== 'properties') return false;
    if (!payload.properties || typeof payload.properties !== 'object') return false;
    if (Object.keys(payload.properties).length) return false;
  }
  const ops = doc.operations;
  if (ops !== undefined && ops !== null) {
    if (typeof ops !== 'object' || Array.isArray(ops)) return false;
    for (const op of Object.values(ops)) {
      if (!op || typeof op !== 'object' || op.action !== 'receive') return false;
      for (const k of Object.keys(op)) if (!DRAFT_OP_KEYS.has(k)) return false;
    }
  }
  return true;
}

// The ONE authorship decision, so the loader, the inference-exclusion set and the
// total-overlap warning can never disagree about who owns a file.
export function isGeneratedDraft(doc, file, kind) {
  const marker = doc?.[INFERRED_MARKER_KEY] === true;
  const stamped = typeof doc?.[INFERRED_DIGEST_KEY] === 'string' ? doc[INFERRED_DIGEST_KEY] : null;
  const named = INFERRED_SPEC_NAME_RE.test(basename(file));
  // A stamped file answers the question exactly — but only if something also says it was
  // BORN a draft, so a hand-written spec cannot claim draft status by pasting a digest in.
  if (stamped) return (marker || named) && stamped === specContentDigest(doc);
  if (marker) return true;
  // INPROC HAS NO SHAPE TEST BECAUSE IT HAS NO EMITTER. Nothing in wiregraph writes an
  // *.inproc.yaml — there is no inproc inference in phase 1 — so there is no "exactly what
  // the generator emits" to compare against, and the filename alone must not be able to
  // promote a hand-written spec to a draft. That was the precise defect the shape tests
  // exist to fix (the OR with the filename destroyed user edits); reproducing it for a
  // format with no drafts at all would be gratuitous. The digest and marker branches above
  // still work, so an emitter added later needs only its own shape test here.
  if (kind === 'inproc') return false;
  return named && (kind === 'resource' ? resourceDraftShaped(doc) : asyncApiDraftShaped(doc));
}

// Read + parse every contract spec in ONE dir into raw contract descriptors — any
// format the dispatch table knows. No merge, no graph mutation — callers merge
// across dirs before minting nodes. All per-file work (extension dispatch, read,
// YAML.parse, error handling) lives in this ONE loop.
//
// Entries are SORTED. readdirSync order is filesystem/creation dependent, and the
// order decides which spec wins a title collision below — i.e. which spec's tokens
// exist at all. An unsorted read makes that vary between two machines holding the
// identical tree.
// `entry` is `{ dir, scopeRoot }` (src/build.js#resolveContractsDirs) — or a bare string
// for the back-compat single-dir callers, which means UNSCOPED, i.e. today's behaviour.
// Every descriptor carries the dir's scopeRoot forward; that is the ONLY thing scoping
// persists, and it is consumed at match time (matchContracts), never stored (see the
// design's "schema bet": rows minted only for in-scope files are already scope-correct,
// so the store needs no scope column and SCHEMA_VERSION stays 5).
function readContractsDir(entry, log) {
  const contractsDir = typeof entry === 'string' ? entry : entry.dir;
  const scopeRoot = typeof entry === 'string' ? null : (entry.scopeRoot ?? null);
  let entries;
  try {
    entries = readdirSync(contractsDir).sort();
  } catch {
    log(`  no contracts dir at ${contractsDir}`);
    return [];
  }
  const out = [];
  for (const f of entries) {
    const parser = SPEC_PARSERS.find((p) => p.match.test(f));
    if (!parser) continue;
    let doc;
    try {
      doc = YAML.parse(readFileSync(join(contractsDir, f), 'utf8'));
    } catch (e) {
      log(`  failed to parse ${f}: ${e.message}`);
      continue;
    }
    // ONE authorship verdict per file, computed BEFORE the parse and handed to it, so the
    // parser's total-overlap warning and the loader's precedence rule key on the same
    // answer rather than on two independent readings of the marker.
    const isDraft = isGeneratedDraft(doc, f, specKindFor(f));
    const desc = parser.parse(doc, f, log, isDraft);
    // `file` stays the BASENAME (it is persisted to contracts.file and read back as a
    // display label). `specPath` is the full path, for DIAGNOSTICS only: a collision
    // warning that prints the basename twice — which is exactly what happens when
    // contracts/ and .wiregraph/inferred/ both hold `wiregraph-inferred.resource.yaml` —
    // names the same string twice and tells the user nothing about which two files
    // collided.
    if (desc) {
      desc.specPath = join(contractsDir, f);
      desc.scopeRoot = scopeRoot;
      desc.inferred = isDraft;
      out.push(desc);
    }
  }
  return out;
}

// Merge raw contracts sharing a contractId into ONE, UNIONing tokens, directions,
// and wireRoles across every spec that contributed the id. A hand-applied spec and
// the link-inferred spec routinely collide on 'contract:wiregraph-inferred' (same
// synthesizeAsyncApi default info.title) — without this merge, whichever object a
// downstream Map (graph.addContract node dedup vs. buildWireEdges' cById) happened
// to retain would silently DROP the other spec's channels/roles, and precedence
// differed between those two Maps, so a hand-authored channel could lose its WIRE
// edge. Union is order-independent, so node dedup and cById now agree regardless of
// dir precedence. First contributor wins for the display name/file only.
export function mergeContracts(contracts) {
  const byId = new Map();
  for (const c of contracts) {
    let m = byId.get(c.id);
    if (!m) {
      // First contributor wins for name/file AND kind — they travel together, so a
      // merged node's `kind` always describes the `file` it names. loadAllContracts
      // refuses a cross-format id collision outright (see there), so this can only
      // merge same-format specs.
      // scopeRoots is a SET because a merge legitimately spans dirs with different
      // scopes — most routinely a scoped `contracts/` spec and the UNSCOPED
      // `.wiregraph/inferred/` copy that shares its default title, which Phase 1b made
      // merge on purpose. A null member means "unscoped", and unscoped always applies
      // (see contractApplies), so that merge can never make a contract match LESS than it
      // did before.
      m = { id: c.id, name: c.name, file: c.file, specPath: c.specPath || null, kind: c.kind || 'asyncapi', tokens: new Set(), direction: {}, wireRoles: new Map(), scopeRoots: new Set() };
      byId.set(c.id, m);
    }
    // A descriptor with no scopeRoot property at all (a hand-built object in a unit test,
    // or a caller that predates scoping) is UNSCOPED — the legacy meaning.
    m.scopeRoots.add(c.scopeRoot ?? null);
    for (const t of c.tokens || []) m.tokens.add(t);
    for (const [t, d] of Object.entries(c.direction || {})) if (d && !(t in m.direction)) m.direction[t] = d;
    for (const [t, roles] of c.wireRoles || new Map()) {
      let mr = m.wireRoles.get(t);
      if (!mr) { mr = { producers: new Set(), consumers: new Set() }; m.wireRoles.set(t, mr); }
      for (const p of roles.producers || []) mr.producers.add(p);
      for (const q of roles.consumers || []) mr.consumers.add(q);
    }
  }
  return [...byId.values()].map((m) => ({ ...m, tokens: [...m.tokens] }));
}

// What lands in `contracts.file`: the spec's path RELATIVE TO THE PROJECT ROOT, POSIX
// -spelled, instead of the bare basename it used to be.
//
// This is a VALUE change, not a schema one — same table, same column, SCHEMA_VERSION stays
// 5 — and it is what makes a contract's governing subtree recoverable at QUERY time, where
// scope itself is deliberately not persisted (the design's schema bet). `dirname(dirname
// (file))` gives back the scope root of any nested contracts dir: `server/contracts/
// inner.asyncapi.yaml` -> `server`, `contracts/outer.asyncapi.yaml` -> `.`. traceContract's
// shadow note (src/store/sqlite-query.js) needs exactly that to tell a NARROWER contract,
// which legitimately took the missing half, from a DISJOINT SIBLING one, which did not.
//
// It also removes a real ambiguity: `wiregraph-inferred.asyncapi.yaml` is the default
// filename in `contracts/`, in every nested contracts dir and in `.wiregraph/inferred/`, so
// a bare basename named three different files identically.
//
// A db written before this change holds basenames, for which `dirname(dirname(f))` is `.`
// for EVERY contract — no contract is a strict descendant of any other, so the shadow note
// simply never fires. Degrading to today's silence on a stale db is the safe direction.
//
// Falls back to the basename when there is no specPath at all (a hand-built descriptor in a
// unit test), and to the ABSOLUTE path when the spec sits outside the project (a
// `--contracts` override, a linked member's own dir) — a `../..` spelling would claim a
// scope relationship to this project that the spec does not have.
function contractFileLabel(project, c) {
  if (!c.specPath) return c.file;
  if (!project) return c.specPath;
  const rel = relative(project, c.specPath);
  if (!rel || rel.startsWith('..') || rel === c.specPath) return c.specPath;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

// tokenMeta: the full defined-token set persisted to the store (schema v4) so
// trace_contract can diff it against the REFERENCES edges and report drift.
// Computed from the MERGED contract so every channel is present regardless of which
// spec defined it. producers/consumers come from the inference's x-wiregraph-*
// extensions when present (empty for hand-written specs — drift then keys purely on
// how many compartments reference the token).
function contractTokenMeta(c) {
  const join = (s) => (s && s.size ? [...s].sort().join(',') : null);
  return c.tokens.map((t) => {
    const roles = c.wireRoles.get(t);
    return { token: t, direction: c.direction[t] || null, producers: join(roles?.producers), consumers: join(roles?.consumers) };
  });
}

// --- the distinct-title requirement (recursive/scoped mode) ------------------
// `contractId` derives SOLELY from `doc.info.title` (src/model.js) and mergeContracts
// deliberately UNIONs tokens and roles across every spec sharing that id. Two NESTED specs
// that happen to share a title therefore collapse into ONE node whose scopeRoots include
// both subtrees — and since a contract applies wherever ANY of its scope roots applies,
// scoping silently becomes a no-op for both of them. That is the exact failure this rule
// exists to stop, and it is invisible: the build logs nothing and the counts look right.
//
// SO THE RULE IS KEYED ON THE SCOPE, NOT ON THE FILE. Two contracts sharing an id collide
// only when they carry DIFFERENT NON-NULL scope roots. That is precisely the case where
// merging would erase a scope, and it is the only one:
//
//   * SAME scopeRoot (two specs in one contracts dir, or two dirs governing the same
//     subtree) -> MERGE. They govern identical territory, so the union is exactly right
//     and there is no scope to lose.
//   * ONE SIDE UNSCOPED — `.wiregraph/inferred/` or `--contracts <dir>` -> MERGE. This is
//     the routine collision Phase 1b made merge on purpose: `/wiregraph-contracts apply`
//     writes `wiregraph-inferred.asyncapi.yaml` into contracts/ while /wiregraph-link
//     writes the SAME default-titled draft into .wiregraph/inferred/, and skipping the
//     later one there cost a linked multi-repo graph every cross-member seam. An unscoped
//     contract matches everywhere by definition, so absorbing a scoped sibling into it
//     cannot narrow anything — it widens, which is what an inferred union-wide draft
//     already is. (Composition with the CROSS-FORMAT guard above: that guard runs FIRST
//     and is unchanged — AsyncAPI wins, the resource spec is dropped — and this rule then
//     applies to whatever survived it.)
//   * DIFFERENT non-null scopeRoots -> COLLISION. Keep the FIRST (shallowest — see
//     detectContractsDirs' ordering, so the more general contract wins), SKIP the rest,
//     and say so naming BOTH sides.
//
// Global mode never reaches the collision branch: every scopeRoot there is null.
//
// The message names FULL SPEC PATHS. Phase 1b fixed the same defect one layer up — the
// routine collision is two files with the IDENTICAL basename in different dirs, so a
// basename-only message printed the same string twice and told the user nothing.
function enforceDistinctTitlePerScope(group, log) {
  if (group.length < 2) return group;
  const scopes = [...new Set(group.map((c) => c.scopeRoot ?? null))].filter((s) => s !== null);
  if (scopes.length < 2) return group;
  const winner = group.find((c) => (c.scopeRoot ?? null) !== null).scopeRoot;
  const keep = group.filter((c) => (c.scopeRoot ?? null) === null || c.scopeRoot === winner);
  const dropped = group.filter((c) => !keep.includes(c));
  const where = (c) => c.specPath || c.file;
  log(`  ⚠ contract title collision ACROSS SCOPES: "${group[0].name}" is declared by ${keep.filter((c) => c.scopeRoot === winner).map((c) => `${where(c)} (governs ${winner})`).join(', ')} AND by ${dropped.map((c) => `${where(c)} (governs ${c.scopeRoot})`).join(', ')}. In recursive mode a contract id is its title, and specs sharing a title MERGE into one node — which would erase both scopes and make each spec's tokens match the OTHER subtree too. Keeping the outer spec, SKIPPING ${dropped.map(where).join(', ')}. Give each spec a distinct info.title.`);
  return keep;
}

// Does contract `c` govern the file at absolute path `abs`? Returns the LENGTH of the
// governing scope root (longer = more specific) or -1 when it does not apply.
// UNSCOPED (a null scope root) returns 0: it always applies, and it never competes in the
// longest-prefix contest below — so `--contracts` and `.wiregraph/inferred/` keep matching
// everything exactly as they do today, and global mode (where every scope is null) takes
// the identical path it always has.
// `dir` is the file's CONTAINING directory, not the file — every file in one directory
// gets the same answer, which is what makes the per-file filter a Map lookup rather than a
// scan (see matchContracts).
// NULL IS STICKY, and that is the whole correctness property for a MERGED contract. A
// contract merged from a scoped `contracts/` AND the unscoped `.wiregraph/inferred/` — the
// routine apply+link title collision mergeContracts and enforceDistinctTitlePerScope
// deliberately PERMIT — carries scopeRoots = {<root>, null}. Collapsing null to 0 and then
// max()ing it away made such a contract behave as if it were scoped to <root>: for a file
// under `client/`, `client/contracts/` returned a longer depth and DISPLACED it in
// buildView's longest-prefix contest, so an inferred spec declaring `/ui/frame` with
// producers:[world_state] consumers:[netsrv] matched netsrv only and the declared
// world_state -> netsrv link seam went dark. That breaks the "UNSCOPED CONTRACTS DO NOT
// COMPETE" promise below outright: an unscoped member means the contract applies
// everywhere, so it must return 0 and never a length, no matter what else is in the set.
function scopeDepthFor(c, dir) {
  let best = -1;
  const roots = c.scopeRoots || new Set([null]);
  for (const r of roots) {
    if (r === null) return 0;
    if (dir === r || dir.startsWith(r + sep)) { if (r.length > best) best = r.length; }
  }
  return best;
}

// Load every AsyncAPI spec across `dirs`, MERGE specs sharing a contractId, and add
// ONE merged Contract node per id (union tokenMeta). Returns the merged contracts:
// matchContracts keys REFERENCES off their union token set, and buildWireEdges'
// cById is one-per-id so its wireRoles precedence matches the node exactly. `dirs`
// arrive ordered hand-written-first, inferred-last — the merge is order-free.
// `opts.knownCompartments` — the compartment names the CALLER can vouch for beyond the
// ones in `graph`. Only the incremental path passes it, and only because its graph holds
// the EDITED files' compartments alone; see validateRoleCompartments.
export function loadAllContracts(graph, dirs, log = () => {}, opts = {}) {
  // ONE pass, ONE merge, both formats. This is load-bearing, not tidiness: the store's
  // `delTok` is keyed (project, contract_id) and runs INSIDE the per-contract insert
  // loop (store/sqlite.js), so a second graph.contracts entry with a colliding id would
  // make its delete WIPE the first entry's freshly-written tokens. Every format must
  // therefore arrive as one merged contract set.
  //
  // Precisely what a second pass would cost (the earlier note here named the wrong
  // mechanism, so it is worth stating exactly): WITHIN one loadGraph call the wipe is
  // not reachable, because `graph.addContract` is first-wins — a second registration of
  // the same id is DROPPED, tokenMeta and all, so the second format's tokens are simply
  // never written. The delTok wipe is reachable ACROSS two loadGraph calls over the same
  // db: the second call's per-contract delTok clears the id's rows, INSERT OR REPLACE
  // rewrites contracts.file from the other format, and only the second pass's tokens
  // remain. Different mechanisms, same end state — a contract that silently lost half
  // its tokens — and one merged set is what avoids both. Graph.addContract additionally
  // THROWS when an id is re-registered with a different `kind` (src/model.js), so the
  // first-wins drop can no longer happen quietly.
  const all = [];
  for (const entry of dirs) for (const c of readContractsDir(entry, log)) all.push(c);

  // --- id (title) collisions -------------------------------------------------
  // SAME-FORMAT collisions MERGE — for BOTH formats, identically. A hand-applied spec and
  // the link-inferred copy routinely share a title (`/wiregraph-contracts apply` writes
  // into contracts/, `/wiregraph-link` writes the same default-titled draft into
  // .wiregraph/inferred/), and mergeContracts' own comment calls that case routine. The
  // resource side used to SKIP the later spec instead, which meant a linked multi-repo
  // graph that also ran `apply` lost every cross-member inferred resource seam — the
  // identical AsyncAPI situation merged and produced a union.
  //
  // A collision that spans FORMATS still cannot merge: mergeContracts keeps only the first
  // contributor's file/kind, so the node would name one format while carrying the union of
  // both formats' tokens. Cross-format resolution is by FORMAT, not by arrival order:
  // AsyncAPI is the incumbent and always wins. Order-based "keep the first" meant a single
  // resource spec that happened to be read first discarded the ENTIRE AsyncAPI spec sharing
  // its title — including the link-inferred spec, whose title is a fixed default that any
  // user resource spec can collide with by accident.
  const where = (c) => c.specPath || c.file;
  const byId = new Map();
  for (const c of all) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push(c);
  }
  const raw = [];
  for (const group of byId.values()) {
    // THREE formats now, so "wire vs res" is no longer a partition. The rule is unchanged
    // in substance — a title shared across FORMATS cannot merge, because mergeContracts
    // keeps only the first contributor's file/kind and the node would name one format while
    // carrying the union of both formats' tokens — but the winner is picked by FORMAT
    // PRECEDENCE (KIND_PRECEDENCE) rather than by arrival order, so which spec survives
    // does not depend on directory read order.
    //
    // The asyncapi-vs-resource message is UNCHANGED, byte for byte: that pair is the one
    // users have already seen and the one the suite pins. Any collision involving inproc
    // gets the generalised message.
    const byKind = new Map();
    for (const c of group) {
      const k = KIND_PRECEDENCE.includes(c.kind) ? c.kind : 'asyncapi';
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(c);
    }
    let kept = group;
    if (byKind.size > 1) {
      const winner = KIND_PRECEDENCE.find((k) => byKind.has(k));
      const losers = [...byKind].filter(([k]) => k !== winner);
      const lost = losers.flatMap(([, cs]) => cs);
      if (byKind.size === 2 && winner === 'asyncapi' && byKind.has('resource')) {
        log(`  ⚠ contract title collision: "${group[0].name}" is declared by BOTH ${byKind.get('asyncapi').map(where).join(', ')} (asyncapi) and ${byKind.get('resource').map(where).join(', ')} (resource) — a title must be unique ACROSS formats. Keeping the AsyncAPI spec(s), SKIPPING the resource spec(s). Rename the title in ${byKind.get('resource').map(where).join(', ')}.`);
      } else {
        const named = (k) => `${byKind.get(k).map(where).join(', ')} (${k})`;
        log(`  ⚠ contract title collision: "${group[0].name}" is declared by specs of ${byKind.size} DIFFERENT formats — ${[...byKind.keys()].map(named).join(' and ')} — and a title must be unique ACROSS formats. Keeping the ${winner} spec(s), SKIPPING ${lost.map(where).join(', ')}. Rename the title in ${lost.map(where).join(', ')}.`);
      }
      kept = byKind.get(winner);
    }
    // --- a title shared ACROSS AsyncAPI MAJORS is MERGED, and SAID OUT LOUD -------
    // Considered and deliberately NOT refused. The channel-address rule is per DOC —
    // `collectTokens` reads the channel KEY only when THAT doc says `asyncapi: 2.x` — so a
    // 2.x key really is a legitimate address harvested under the rules that govern its own
    // file, and dropping it would delete a matchable token to fix a labelling problem.
    // Refusing would also split a contract in two for anyone migrating a spec set one file
    // at a time, and load-time DROPS are the expensive direction (see `usable` below, where
    // one made a whole contract node vanish).
    //
    // What IS misleading is the merged node's identity: mergeContracts keeps the FIRST
    // contributor's name and file, so the node points at a 3.0 file while carrying tokens
    // only the 2.x rules produce — an address `pathTokenRegex` matches unrooted, which
    // reads as a 3.0 channel key to anyone who opens the file it names. So the merge is
    // named rather than performed silently.
    const majors = [...new Set(kept.filter((c) => c.kind !== 'resource' && c.asyncapiMajor != null).map((c) => c.asyncapiMajor))];
    if (majors.length > 1) {
      log(`  ⚠ contract "${group[0].name}" is declared by specs at DIFFERENT AsyncAPI versions (${majors.sort().map((v) => `${v}.x`).join(' and ')}): ${kept.filter((c) => c.asyncapiMajor != null).map((c) => `${where(c)} (${c.asyncapiMajor}.x)`).join(', ')}. Specs sharing a title MERGE into one contract, and each doc's tokens are harvested under ITS OWN version's rules — so this node names one file while carrying 2.x channel-key addresses from another. That is intended, not refused; give them distinct info.titles if you want them reported separately.`);
    }
    for (const c of enforceDistinctTitlePerScope(kept, log)) raw.push(c);
  }

  // --- duplicate resource ids across DIFFERENT contracts ----------------------
  // A resource id is the join key. Two DIFFERENTLY-TITLED specs declaring the same id mint
  // REFERENCES to TWO different contract nodes for one constant, so the same
  // writer->reader pair is derived twice under two contract names — and before the
  // derived-edge dedup key learned about `contract` (store/sqlite.js) one of the two was
  // silently DROPPED at insert time, leaving the losing contract reporting `ok` with no
  // edges at all, with the loser decided by directory read order. Refuse that at load.
  //
  // Scoped to DIFFERENT contract ids on purpose. Two specs that share a title are ONE
  // contract node after mergeContracts, so a repeated id there is a union, not a
  // duplicate — and treating it as one deleted the second spec's roles, which is precisely
  // the contracts/ + .wiregraph/inferred/ pair that merges above.
  //
  // PRECEDENCE IS BY AUTHORSHIP, NOT BY READ ORDER. This loop used to run over `raw` in
  // discovery order, so the first spec off the disk kept the id — and the machine-written
  // draft is read first by construction: `/wiregraph-contracts apply` writes it into the
  // OUTERMOST contracts home (contracts-dirs.js#contractsHome is deliberately depth-1) and
  // detectContractsDirs returns shallowest-first. Following commands/wiregraph-contracts.md
  // verbatim on a repo with three hand-written resource specs therefore DELETED them:
  //
  //   ⚠ …/client-resources.resource.yaml: resource id "WORLD_SNAPSHOT_CACHE_PATH" is
  //     ALREADY declared by …/wiregraph-inferred.resource.yaml … Dropping it
  //
  // Both hand-written specs lost EVERY id, so `usable` filtered them out and their
  // contract nodes were never created at all — `trace_contract {"contract":"Server Shared
  // Resources"}` answered "No contract matches". The collateral is worse than the missing
  // node: the draft's all-both placeholder roles replaced the real writer/reader split, a
  // declared `single_writer` violation stopped being reported, and RESOURCE edges went
  // 6 -> 16 as the symmetric cross product took over.
  //
  // So hand-written specs claim their ids FIRST, in discovery order among themselves, and
  // drafts get whatever is left. A draft is a proposal about code; a hand-written spec is
  // a statement of intent by the person the tool is for, and no read order should be able
  // to overrule it. Two HAND-WRITTEN specs colliding is still first-come — that is a real
  // ambiguity between two human declarations and the warning tells them to rename one.
  //
  // INPROC IDS RIDE THE SAME RULE, IN THE SAME NAMESPACE. An inproc id is a join key in
  // exactly the sense a resource id is — a bare name the user chose, compiled to `\bname\b`
  // and put into the SAME token index in matchContracts — so two differently-titled specs
  // claiming one name mint REFERENCES to two contract nodes and derive the same seam twice,
  // whichever two formats they came from. One namespace, not one per format: splitting them
  // would let a `*.resource.yaml` and a `*.inproc.yaml` both claim `SESSION_TOKEN` and
  // reintroduce precisely the defect this block exists to refuse.
  const idOwner = new Map(); // join-key id -> descriptor that owns it
  const joinKeyRaw = raw.filter((c) => JOIN_KEY_KINDS.has(c.kind));
  const byAuthorship = [...joinKeyRaw.filter((c) => !c.inferred), ...joinKeyRaw.filter((c) => c.inferred)];
  for (const c of byAuthorship) {
    const keep = [];
    // The resource wording is UNCHANGED, byte for byte — it is what users have seen and
    // what the suite pins. An inproc spec speaks its own vocabulary rather than being told
    // its symbol name is a "resource id".
    const noun = c.kind === 'inproc' ? 'symbol id' : 'resource id';
    for (const t of c.tokens) {
      const prior = idOwner.get(t);
      if (prior && prior.id !== c.id) {
        const why = c.inferred && !prior.inferred
          ? ' — a HAND-WRITTEN spec always wins over an inferred draft, whatever order they are read in'
          : ` — a ${c.kind === 'inproc' ? 'symbol name' : 'resource id'} is the join key and must be unique across every differently-titled spec`;
        const fix = c.inferred && !prior.inferred
          ? ` Delete "${t}" from the draft (or the whole draft) — inference should not have re-proposed a seam you have already declared.`
          : ' Rename one of them.';
        log(`  ⚠ ${where(c)}: ${noun} "${t}" is ALREADY declared by ${where(prior)} (contract "${prior.name}")${why}. Dropping it from "${c.name}";${fix}`);
        continue;
      }
      idOwner.set(t, c);
      keep.push(t);
    }
    if (keep.length !== c.tokens.length) {
      c.tokens = keep;
      for (const t of Object.keys(c.direction)) if (!keep.includes(t)) delete c.direction[t];
      for (const t of [...c.wireRoles.keys()]) if (!keep.includes(t)) c.wireRoles.delete(t);
    }
  }
  // A resource contract that lost EVERY id to a collision mints no node at all, and the
  // per-id warnings above never say so — the user is left with `trace_contract` answering
  // "No contract matches" for a spec that is sitting on disk, with nothing connecting the
  // two. The node is still not kept (a contract with no tokens has no defined-token set,
  // derives nothing, and would report as 100% drift on every build — and the precedence
  // rule exists precisely so the SURVIVING owner is the one worth looking at). What was
  // missing was the sentence that makes the disappearance findable.
  const erased = raw.filter((c) => JOIN_KEY_KINDS.has(c.kind) && !c.tokens.length);
  for (const c of erased) {
    log(`  ⚠ ${where(c)}: contract "${c.name}" has NO surviving ${c.kind === 'inproc' ? 'symbol' : 'resource'} ids — every one was dropped above — so NO contract node is created for it at all. trace_contract will answer "No contract matches" for "${c.name}" until the collision is resolved.`);
  }
  const usable = raw.filter((c) => !JOIN_KEY_KINDS.has(c.kind) || c.tokens.length);

  const merged = mergeContracts(usable);
  validateRoleCompartments(graph, merged, log, opts.knownCompartments);
  for (const c of merged) {
    graph.addContract({ id: c.id, name: c.name, kind: c.kind || 'asyncapi', file: contractFileLabel(graph.project, c), tokenMeta: contractTokenMeta(c) });
  }
  const nRes = merged.filter((c) => c.kind === 'resource').length;
  // A SEPARATE segment, appended only when non-zero, so a project with no inproc spec logs
  // the byte-identical line it always has.
  const nInp = merged.filter((c) => c.kind === 'inproc').length;
  log(`  loaded ${merged.length} contract(s) from ${dirs.length} dir(s)${nRes ? ` (${nRes} resource)` : ''}${nInp ? ` (${nInp} inproc)` : ''}; ${merged.reduce((n, c) => n + c.tokens.length, 0)} wire tokens`);
  return merged;
}

// A writer/reader naming a compartment that does not exist. Only checkable HERE: the
// parser sees one YAML file, but by the time contracts load the graph already knows
// every compartment name (extractCode ran first). Without this, a misspelled
// compartment produces the maximally misleading report — buildResourceEdges finds no
// symbol on that side, so trace_contract says "writer half missing", pointing the user
// at their CODE when the defect is one character in their SPEC.
//
// A warning, not a rejection: a spec legitimately outlives a compartment that is
// temporarily unindexed (a linked member that is not currently linked), and dropping
// the role would silently convert a declared seam into a half-seam — exactly the
// failure mode this is meant to make visible.
//
// "THE GRAPH ALREADY KNOWS EVERY COMPARTMENT NAME" IS TRUE OF A FULL BUILD AND FALSE OF
// `--files`. On the incremental path `graph` holds ONLY the edited files' compartments,
// so ONE save of an unrelated file made this fire on a correct spec and a correct graph,
// with both of its claims false: `resource "X" names compartment(s) [svc_b] that do not
// exist in this graph. Known compartments: [svc_a].` — while the db held both and
// graph_status's own `Mode:` line, two lines above the warning it rendered, named them
// both. It re-armed on every save and cleared only on a full rebuild.
//
// So the known set is the CALLER'S when the caller has an authoritative one: the
// incremental passes the compartment names already in the db (the last full build's
// complete set), unioned with the freshly extracted ones (a compartment this very save
// creates is real too, and is not in the db yet). A full build passes nothing, because
// its graph IS the authoritative set. Nothing is weakened: a genuinely misspelled name
// is in neither source and still warns, on both paths.
// WIRE ROLES ARE CHECKED TOO, and used not to be. `x-wiregraph-producers` /
// `x-wiregraph-consumers` hold compartment NAMES exactly as writers/readers do, and
// buildWireEdges filters the referencing symbols by them — so a name that matches no
// compartment produces `derived 0 WIRE edges` and NOT ONE WORD anywhere, while the
// identical mistake in a resource spec was named and explained. That asymmetry hit hardest
// in precisely the situation the compartment-disambiguation warning exists to flag: after
// a rename (or after declaring compartments with qualified names like `client/network`),
// every bare-basename role name in every wire spec goes dark at once, silently.
//
// The wire message says the same thing in wire vocabulary and points at the right two
// keys. The resource message is UNCHANGED, byte for byte.
function validateRoleCompartments(graph, contracts, log, extraKnown = null) {
  const known = new Set([...graph.compartments.values()].map((c) => c.name));
  for (const n of extraKnown || []) if (n) known.add(n);
  if (!known.size) return; // no code indexed (spec-only unit test) — nothing to check against
  for (const c of contracts) {
    const isResource = c.kind === 'resource';
    for (const [tok, roles] of c.wireRoles) {
      const missing = [...roles.producers, ...roles.consumers].filter((n) => !known.has(n));
      if (!missing.length) continue;
      const names = [...new Set(missing)].join(', ');
      const knownList = [...known].sort().join(', ');
      if (c.kind === 'inproc') {
        // THE SAME CHECK, in this type's vocabulary. It matters more here than anywhere
        // else: an inproc contract's roles are the ONLY thing bounding a short symbol
        // name's blast radius (buildInprocEdges pairs declared provider with declared
        // consumers and nothing else), so a misspelled compartment does not merely lose a
        // seam — it removes the bound, and every reference to the id in the real
        // compartment then reports as an UNDECLARED PARTICIPANT instead.
        log(`  ⚠ ${c.file}: symbol "${tok}" names provider/consumer compartment(s) [${names}] that do not exist in this graph. Known compartments: [${knownList}]. A misspelled name derives NO INPROC edge and reports as a MISSING SEAM HALF (and turns the real compartment's references into UNDECLARED PARTICIPANTS), not as an error — fix the spec or index that compartment.`);
      } else if (isResource) {
        log(`  ⚠ ${c.file}: resource "${tok}" names compartment(s) [${names}] that do not exist in this graph. Known compartments: [${knownList}]. A misspelled name reports as a MISSING SEAM HALF, not as an error — fix the spec or index that compartment.`);
      } else {
        log(`  ⚠ ${c.file}: channel "${tok}" names producer/consumer compartment(s) [${names}] that do not exist in this graph. Known compartments: [${knownList}]. A role naming no compartment derives NO WIRE edge and reports as a MISSING SEAM HALF, not as an error — a compartment rename takes every bare-basename x-wiregraph-producers/x-wiregraph-consumers name dark at once. Fix the spec or index that compartment.`);
      }
    }
  }
}

// Back-compat single-dir wrapper (external callers / tests).
export function loadContracts(graph, contractsDir, log = () => {}) {
  return loadAllContracts(graph, [contractsDir], log);
}

// Every token a HAND-WRITTEN spec already declares, across `dirs` — wire addresses,
// payload field names and resource ids alike, in one set. This is what stops inference
// re-proposing seams the user has already written down.
//
// WHY INFERENCE MUST CONSULT IT. `/wiregraph-contracts scan` printed all 9 of a repo's
// already-declared seams back at the user as new proposals, directly contradicting its own
// "you already have hand-written contracts … so there is nothing left to infer" explainer
// — and `apply` then wrote them into a draft that competed with the specs they came from,
// which is the other half of the id-precedence defect above. Excluding them at the SOURCE
// means the draft never contains a competing id in the first place, so the precedence rule
// becomes a backstop for pre-existing drafts rather than the thing standing between a user
// and their own specs.
//
// DRAFTS ARE SKIPPED, deliberately: excluding a draft's own ids would make inference
// idempotent-by-amnesia, unable to re-derive (or re-title, or widen) a seam it proposed
// last week, and a stale draft would freeze the scan forever. Only a human's declaration
// takes a token off the table. `inferred` is set by readContractsDir from the
// `x-wiregraph-inferred` marker OR the generated filename.
//
// Parse failures are already logged by readContractsDir. An unreadable dir contributes
// nothing, which is the safe direction here: inference then re-proposes a seam the user
// has declared, which is noise, rather than dropping a seam they have not.
export function handWrittenTokens(dirs, log = () => {}) {
  const out = new Set();
  for (const entry of dirs) {
    for (const c of readContractsDir(entry, log)) {
      if (c.inferred) continue;
      for (const t of c.tokens) out.add(t);
    }
  }
  return out;
}

// Build a per-file list of {startLine, endLine, id} intervals from real symbols
// so we can map a token's line back to the function that contains it.
function symbolIntervals(graph) {
  const byFile = new Map(); // `${compartment}\0${file}` -> [{startLine,endLine,id}]
  for (const s of graph.symbols.values()) {
    if (s.kind === 'module') continue;
    const k = `${s.compartment}\0${s.file}`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(s);
  }
  return byFile;
}

function enclosingSymbol(intervals, line, moduleIdOf) {
  let best = null;
  if (intervals) {
    for (const s of intervals) {
      if (s.startLine <= line && s.endLine >= line) {
        if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) best = s;
      }
    }
  }
  return best ? best.id : moduleIdOf;
}

// Byte offset -> 1-based line number, without slicing the file per match. The old
// `text.slice(0, at).split('\n').length` was affordable when there was exactly ONE
// match per (file, token); attributing EVERY occurrence makes it O(matches x filesize).
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}
function lineAt(starts, idx) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// A line that OPENS an import / include / require statement. A token occurrence inside
// one is module wiring, not a use of the resource: `import { GAME_STATE_PATH } from
// '../common/constants.js'` names the constant without touching it. Attributing a
// REFERENCES edge there is actively harmful — it is the FIRST occurrence in the file, so
// the pre-C1 matcher gave the edge to `<module>` and the functions that really use the
// constant got none. Even with every occurrence attributed it would still add a spurious
// module-scope endpoint to every importing file, growing a resource's fan-out with each
// consumer that merely re-exports it.
//
// Deliberately conservative: only forms that are unambiguously import syntax in an
// indexed language (JS/TS, Python, C, Java, Kotlin, Rust). `export default {` and
// `module.exports = {` are NOT here — a config object legitimately holds route strings.
//
// THIS REGEX RUNS ON RAW TEXT, IN EVERY LANGUAGE, AND COMMENT RANGES DO NOT PROTECT IT.
// The ranges passed to scanTokenOccurrences cover real comment NODES; they do not cover a
// Python docstring (tree-sitter parses it as an `expression_statement`, not a comment), a
// JS template literal, a heredoc, or any file scanned with no parse in hand. So every arm
// here is matched against ordinary PROSE somewhere, and an arm that fires on prose deletes
// real references. Two arms were measured doing exactly that and are pinned tight below.
//
// RUST `use` / `pub use`. wiregraph emits no import CANDIDATES for Rust (a `use` path is
// crate-relative and does not resolve to a file — see parse.js#rustSig), but this is a
// different mechanism on raw text, and Rust needs it for exactly the reason JS does: in
// the shared-module layout — a `common` crate holding the constants, which is the
// dominant Rust layout — every consumer writes `use common::GAME_SOCK_PATH;` at the top,
// and without this a crate that merely NAMES the constant in its use list would be
// promoted to a full participant in the seam without ever touching the resource.
//
// The FIRST version of this arm was `(?:pub\s+)?use\s[\w:{*]`, which fires on the English
// sentence "use the shared config …" — measured, in every language, and it blacked the
// matcher out well past the prose line (see importLineFlags). "use" is an ordinary English
// verb and a leading `[\w:{*]` excludes nothing at all, so the arm is now Rust's actual
// ITEM shape: `use <path>;` or `use <path>{`, where the path may contain only the
// characters a Rust use-tree contains (`\w : { } * ,` and the spaces of an `as` rename),
// and the line must END on the item's own terminator. `use the shared config (see the
// notes` has a `(` and no terminator, so it is no longer an import line; a real
// `use crate::a::{B, C as D};`, `pub(crate) use x::*;` and the opening `use foo::{` of a
// multi-line tree all still are.
//
// `#include` / `#import` LIKEWISE. `#\s*(?:include|import)\s` fires on the ordinary
// Python/shell comment `# import the registration flow`. A C include always names a
// header in `<>` or `""`, so requiring that delimiter keeps every real include and drops
// every sentence.
//
// `package` likewise: `package\s` fires on "package the build output". A Java/Kotlin
// package declaration is a dotted name and (Java) a `;`, alone on its line.
//
// The bare `import` arm is deliberately NOT tightened. It has to accept `import os`,
// `import os.path as p`, `import x, {y} from 'z'`, `import * as ns from 'm'`,
// `import 'side-effect'` and `import('dyn')` across six languages, and every rule that
// separates those from "import the registration flow" is a guess at English. Instead the
// CONTINUATION BOUND below caps what a prose false positive can cost: one line, not the
// rest of the file. That is the fix that generalises — a new arm added tomorrow inherits
// it — and it is why the bound, not the arm list, is the primary defence here.
const IMPORT_START_RE = /^[\t ]*(?:import[\s{*'"(]|from\s+\S+\s+import\b|#\s*(?:include|import)\s*[<"]|package\s+[\w.]+[\t \r]*;?[\t \r]*$|(?:pub(?:\s*\([^)]*\))?\s+)?use\s+[\w:{][\w:{}*,\s]*[;{][\t \r]*(?:\/\/.*)?$|export\s*\{|export\s+\*|(?:const|let|var)\s[^=]*=\s*require\s*\()/;

// Does this line leave its construct GENUINELY UNTERMINATED — i.e. is the next line a
// continuation of it? Every real multi-line import/include/export list ends its opening
// line on the bracket it just opened or on a separator inside one:
//   `import {`  `from x import (`  `use foo::{`  `export {`  `import {a,`  `= require(`
// Prose does not: "use the shared config (see the notes" ends on a WORD. A trailing line
// comment is stripped first so `import {   // the good ones` still continues.
const IMPORT_CONTINUES_RE = /[,({[][\t \r]*(?:(?:\/\/|#|--).*)?$/;

// Hard ceiling on how many lines ONE import region may span. See importLineFlags.
const MAX_IMPORT_REGION_LINES = 40;

// Which 1-based lines of a file belong to an import statement. Multi-line named imports
// are the common case in JS/TS and Python (`import {\n  X,\n} from 'y'`), so the region
// continues past the opening line until the brackets it opened close again.
//
// THE CONTINUATION IS BOUNDED, TWICE. An unbounded bracket-balance region computed over
// RAW TEXT is the root hazard in this file: one unmatched `(` on a line that any arm of
// IMPORT_START_RE happens to match suppresses every token occurrence from there to the
// end of the file. Measured end to end: two identical Python readers of one resource, one
// of them carrying a docstring that begins "use the shared config (…". The clean reader
// produced its REFERENCES and its RESOURCE edge; the other produced ZERO of both, because
// its `open(GAME_STATE_PATH)` two lines further down sat inside the still-open region.
// Nothing reported it — `trace_contract` said the resource was SATISFIED, since other
// readers existed — so a declared participant simply left the graph.
//
//   BOUND 1 (the real one): a region only EXISTS past its opening line when that line is
//   genuinely unterminated by IMPORT_CONTINUES_RE. A prose line therefore costs exactly
//   the line it is on, which is the difference between a token being missed and a file
//   being missed. This is a property of the OPENING line, so it holds for every arm,
//   including any added later.
//
//   BOUND 2 (the backstop): MAX_IMPORT_REGION_LINES. Bound 1 can still be defeated by
//   text that ends on a real opener — a template literal holding `import {`, a heredoc, a
//   commented-out block — and the cost of that is again unbounded. 40 lines comfortably
//   covers real multi-line import lists (the largest in this repo is 12) while turning
//   "the rest of the file" into "at most 40 lines".
//
// WHEN THE CAP FIRES THE FAILURE DIRECTION IS THE SAFE ONE, which is why it needs no
// diagnostic (and there is no log channel here — this runs per file inside the matcher's
// hot loop). Past the cap the scanner simply resumes normal matching: the worst case is
// an EXTRA module-scope REFERENCES edge from, say, the 41st line of a 200-name barrel
// `export { … }` — a visible over-count on a re-export file. The behaviour it replaces
// is a silent, unbounded deletion of real edges. Over-counting is reviewable; a
// disappeared participant is not.
function importLineFlags(text) {
  const lines = text.split('\n');
  const flags = new Uint8Array(lines.length + 2);
  let open = 0, inImport = false, span = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!inImport) {
      if (!IMPORT_START_RE.test(L)) continue;
      flags[i + 1] = 1;
      if (!IMPORT_CONTINUES_RE.test(L)) continue; // single-line statement (or prose) — done
      inImport = true;
      open = 0;
      span = 0;
    } else {
      flags[i + 1] = 1;
    }
    for (let j = 0; j < L.length; j++) {
      const ch = L.charCodeAt(j);
      if (ch === 123 /* { */ || ch === 40 /* ( */) open++;
      else if (ch === 125 /* } */ || ch === 41 /* ) */) { if (open > 0) open--; }
    }
    if (open === 0 || ++span >= MAX_IMPORT_REGION_LINES) inImport = false;
  }
  return flags;
}

// ONE compiled RegExp per token for a WHOLE walk, `g`-flagged so a single exec loop
// enumerates every occurrence in a file. (Was: a fresh RegExp per token PER FILE, and a
// scan that stopped at the first hit.)
//   * path token  — pathTokenRegex, so each `{param}` segment matches the route however
//     source writes it;
//   * identifier  — `\btok\b`. Word-bounded for BOTH existence and position: indexOf
//     alone points at a substring embedded in a larger identifier (user_id inside
//     superuser_id_map) and mis-attributes the edge to the wrong enclosing symbol (M11).
export function compileTokenRegexes(tokens) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new Map(tokens.map((t) => [t,
    t.includes('/') ? new RegExp(pathTokenRegex(t).source, 'g') : new RegExp(`\\b${esc(t)}\\b`, 'g')]));
}

// Is offset `idx` inside one of `ranges` ([start,end) pairs, ascending)? Binary search,
// because a large file's comment list is long and this runs per match.
function inRanges(ranges, idx) {
  if (!ranges || !ranges.length) return false;
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx < ranges[mid][0]) hi = mid - 1;
    else if (idx >= ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// The ONE occurrence scanner: for one file's TEXT, call `onHit(token, line, index)` for
// every word-bounded occurrence of every token that is NOT inside an import statement and
// NOT inside a comment. Both consumers ride it — matchContracts (which mints REFERENCES
// from the enclosing symbol) and resource-seam inference (which only needs the
// compartment) — so the two can never disagree about what counts as a reference. That
// equivalence is the whole point of reusing it: inference proposes writers/readers,
// matchContracts is what actually mints the edges for them, and a seam proposed on a rule
// the matcher does not share is a seam that lands in a spec and then derives nothing.
//
// COMMENTS. `comments` is the [start,end) list captured during the file's own tree-sitter
// parse (parse.js). A token that appears only in prose is a MENTION, not a reference, and
// this scanner reads raw text — so without the ranges a single
// `// TODO(someday): … LEDGER_STATE_PATH.` makes that compartment a full participant in
// the seam. Passing null keeps the old behavior for a caller that has no parse in hand.
//
// `lineStarts`/`importLineFlags` are per-file and only needed once a token actually hits,
// so they are paid for lazily — most files match no token at all.
export function scanTokenOccurrences(text, tokens, tokenRe, onHit, comments = null) {
  let starts = null, importFlags = null;
  for (const tok of tokens) {
    const re = tokenRe.get(tok);
    if (!re) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // paranoia: never spin
      if (inRanges(comments, m.index)) continue; // prose, not a use
      if (starts === null) { starts = lineStarts(text); importFlags = importLineFlags(text); }
      const line = lineAt(starts, m.index);
      if (importFlags[line]) continue; // import statement, not a use
      onHit(tok, line, m.index);
    }
  }
}

// `${compartment}\0${file}` -> Map(constant name -> Set(byte offset)) over kind:'const'
// candidates. This is the DEFINITION-SITE index: exactly where each named constant's
// declared NAME sits. Built from the extractor's own output (Phase 1b-i), so it is exact
// — no line-shaped regex guessing at what a declaration looks like in five languages.
//
// KEYED ON POSITION, NOT LINE. A line key excludes every occurrence that SHARES the
// definition's line, which is not the same thing at all:
//
//   export const SESSION_LOCK_PATH = '/var/run/sess.lock'; export function fn3a() { return SESSION_LOCK_PATH; }
//
// is one line, so the USE on it was dropped too — the declared writer half of the seam
// disappeared and trace_contract blamed the user's code. Same defect for two constants
// declared on one line, for a name mentioned in a trailing comment on the definition
// line, and for a `\`-continued C `#define`. The name node's offset has none of those
// ambiguities.
export function constDefIndex(candidates) {
  const out = new Map();
  for (const c of candidates || []) {
    if (c?.kind !== 'const' || !c.token || c.nameStart === undefined) continue;
    const k = `${c.compartment}\0${c.file}`;
    let byTok = out.get(k);
    if (!byTok) { byTok = new Map(); out.set(k, byTok); }
    let offsets = byTok.get(c.token);
    if (!offsets) { offsets = new Set(); byTok.set(c.token, offsets); }
    offsets.add(c.nameStart);
  }
  return out;
}

// fileFilter (optional): a Set of absolute paths to restrict matching to (the
// incremental path). When present, only those files are scanned for wire tokens.
// constDefs (optional): a constDefIndex — the (file, OFFSET) sites where a token is
// DEFINED as a named constant. Phase 1a excluded import statements from minting
// REFERENCES, but the constants module's own definition (`export const X = "…"`) is not
// an import and still minted one. That edge is not a use of the resource: if the
// constants module sits inside a declared writer or reader compartment it manufactures a
// phantom seam half from a file that only DECLARES the name, and the fan-out grows with
// every module that re-exports it. 1a could not close this — nothing knew where a
// constant was defined. 1b-i's extractor does, and the build already has those
// candidates in hand, so this costs no extra parsing.
// comments (optional): `${compartment}\0${relPath}` -> comment ranges from the same
// parse, so a token mentioned only in prose mints nothing.
export function matchContracts(graph, rootDir, contracts, log = () => {}, fileFilter = null, constDefs = null, comments = null) {
  if (!contracts.length) return { refs: 0 };

  // token -> Set(contractId)
  const tokenIndex = new Map();
  for (const c of contracts) {
    for (const t of c.tokens) {
      if (!tokenIndex.has(t)) tokenIndex.set(t, new Set());
      tokenIndex.get(t).add(c.id);
    }
  }
  const allTokens = [...tokenIndex.keys()];
  const intervals = symbolIntervals(graph);
  // ONE compiled RegExp per token for the WHOLE walk (Phase 1a, a measured 2.7x) — over
  // ALL tokens, deliberately, even though a given file may be allowed only a subset. The
  // regexes are stateless apart from lastIndex, which scanTokenOccurrences resets, so
  // compiling the union once and handing each file its own token LIST costs nothing and
  // keeps the compile out of the per-file loop.
  const tokenRe = compileTokenRegexes(allTokens);

  // --- per-file scope filtering (recursive mode) ------------------------------
  // A contract governs a subtree; a file matches its tokens only from inside that subtree.
  // The filter is applied to the TOKEN SET BEFORE the occurrence scan, never to the edges
  // after it: matching is O(files x tokens), so discarding at mint time would leave the
  // full cost in place and add work on top. Two caches make the per-file price a Map
  // lookup:
  //   1. directory -> which scope roots contain it. Every file in a directory shares one
  //      answer, and a compartment is thousands of files across dozens of directories.
  //   2. that signature -> the {tokens, index} view. There are only as many distinct
  //      signatures as there are nestings of contracts dirs — a handful.
  //
  // LONGEST PREFIX WINS among SCOPED contracts. When an outer `contracts/` and an inner
  // `server/contracts/` both define the same route, code under `server/` belongs to the
  // inner one — the nearest-ancestor rule compartment attribution already uses
  // (walk.js#compartmentNameFor). Consequence worth stating plainly: the outer contract
  // then sees only the halves OUTSIDE that subtree, so a route deliberately shared between
  // an outer and an inner compartment reports as one-sided on the outer contract. That is
  // the honest answer — two contracts claiming one route is an ambiguity, and the
  // remedy is a distinct token or a single contract, not a silent double-count.
  //
  // UNSCOPED CONTRACTS DO NOT COMPETE. `--contracts <dir>` and `.wiregraph/inferred/` are
  // always unscoped; they apply everywhere and are never displaced by a deeper scope, so
  // link-inferred seams stay lit. In global mode EVERY contract is unscoped, `scoped` is
  // false, and the whole block collapses to the single shared view — the exact object,
  // token order and index the pre-scoping code used.
  const scopeRootsOf = (c) => c.scopeRoots || new Set([null]);
  const scoped = contracts.some((c) => [...scopeRootsOf(c)].some((r) => r !== null));
  const globalView = { tokens: allTokens, index: tokenIndex };
  const distinctScopes = scoped
    ? [...new Set(contracts.flatMap((c) => [...scopeRootsOf(c)]))].filter((r) => r !== null).sort()
    : [];
  const sigByDir = new Map();
  const viewBySig = new Map();
  const buildView = (dir) => {
    const depthOf = new Map();
    for (const c of contracts) depthOf.set(c.id, scopeDepthFor(c, dir));
    const tokens = [];
    const index = new Map();
    for (const [t, cids] of tokenIndex) { // global token order preserved
      let maxDepth = 0;
      for (const cid of cids) { const d = depthOf.get(cid); if (d > maxDepth) maxDepth = d; }
      const keep = new Set();
      for (const cid of cids) {
        const d = depthOf.get(cid);
        if (d < 0) continue;                       // this file is outside the contract's subtree
        if (d === 0 || d === maxDepth) keep.add(cid); // unscoped always; scoped only at the deepest
      }
      if (keep.size) { tokens.push(t); index.set(t, keep); }
    }
    return { tokens, index };
  };
  const viewFor = (abs) => {
    if (!scoped) return globalView;
    const dir = dirname(abs);
    let sig = sigByDir.get(dir);
    if (sig === undefined) {
      sig = distinctScopes.filter((r) => dir === r || dir.startsWith(r + sep)).join('\0');
      sigByDir.set(dir, sig);
    }
    let v = viewBySig.get(sig);
    if (!v) { v = buildView(dir); viewBySig.set(sig, v); }
    return v;
  };

  const edgeSet = new Set();
  let refs = 0;

  for (const f of walkSources(rootDir)) {
    if (fileFilter && !fileFilter.has(f.abs)) continue;
    const view = viewFor(f.abs);
    if (!view.tokens.length) continue; // no contract governs this file — skip the read too
    let text;
    try {
      text = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const fileIntervals = intervals.get(`${f.compartment}\0${f.relPath}`);
    const moduleIdOf = `sym:${f.compartment}:${f.relPath}:<module>:0`;
    const fileKey = `${f.compartment}\0${f.relPath}`;
    const defOffsets = constDefs?.get(fileKey) || null;
    const commentRanges = comments?.get(fileKey) || null;

    // EVERY distinct enclosing symbol that mentions a token gets an edge, not just the
    // first occurrence's. One function writes a shared constant and another reads it in
    // the same file; a module imports it at the top and three functions use it. Taking
    // only the first occurrence collapsed all of that onto whichever symbol happened to
    // come first in the file — routinely `<module>`, which is not a path_between
    // endpoint's idea of an answer.
    const bySymbol = new Map(); // token -> Set(enclosing symbol id)
    scanTokenOccurrences(text, view.tokens, tokenRe, (tok, line, at) => {
      if (defOffsets?.get(tok)?.has(at)) return; // the constant's own declared name, not a use
      let froms = bySymbol.get(tok);
      if (!froms) { froms = new Set(); bySymbol.set(tok, froms); }
      froms.add(enclosingSymbol(fileIntervals, line, moduleIdOf));
    }, commentRanges);

    for (const [tok, froms] of bySymbol) {
      for (const fromId of froms) {
        for (const cid of view.index.get(tok)) {
          // (symbol, contract, token) — so N occurrences inside ONE function are still
          // ONE edge, and the same symbol seen again in a later file cannot double up.
          const key = `${fromId}->${cid}->${tok}`;
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          graph.addEdge('REFERENCES', fromId, cid, {
            evidence: 'contract-match',
            token: tok,
            side: f.compartment,
          });
          refs++;
        }
      }
    }
  }
  log(`  matched ${refs} contract REFERENCES edges`);
  return { refs };
}

// Derive direct symbol -> symbol WIRE edges from the REFERENCES already in the
// graph. The contract is the *reason* for the edge, not a node on the path: a
// token referenced on both the terminal side and the server side becomes a
// directed edge publisher -> consumer, with direction taken from the contract
// (request = terminal->server, reply = server->terminal). A token only one side
// touches yields no edge — that asymmetry is the gap, made visible by absence.
// WIRE edges encode a producer->consumer direction, which needs to know which
// compartment is the "server" side. That's project-specific, so it's configured
// via env (WIREGRAPH_SERVER_REPO, and optionally WIREGRAPH_SELF_REPO to exclude a
// root/aggregate compartment). With no server compartment set, directional WIRE
// derivation is skipped — the REFERENCES edges and Contract nodes (which
// trace_contract and path_between use) are unaffected; only the export
// visualizations use WIRE.
const SERVER_COMPARTMENT = process.env.WIREGRAPH_SERVER_REPO || null;
const SELF_COMPARTMENT = process.env.WIREGRAPH_SELF_REPO || null;
const MAX_PAIRS_PER_TOKEN = 25;

// contractId|token -> [symbol, ...] over the graph's REFERENCES edges. Shared by the
// wire and resource derivations so both see exactly the same reference groups (and
// the same SELF_COMPARTMENT exclusion).
function groupContractReferences(graph) {
  const groups = new Map();
  for (const e of graph.edges) {
    if (e.type !== 'REFERENCES') continue;
    const sym = graph.symbols.get(e.from);
    if (!sym || sym.compartment === SELF_COMPARTMENT) continue;
    const key = e.to + '|' + e.props.token;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sym);
  }
  return groups;
}

const splitGroupKey = (key) => { const i = key.indexOf('|'); return [key.slice(0, i), key.slice(i + 1)]; };

// Cross-compartment (from, to) symbol pairs for ONE token, with the fan-out cap applied
// PER ORDERED COMPARTMENT PAIR and the pairs emitted round-robin. Three deliberate
// properties, each fixing a measured defect of the old `break outer` at
// MAX_PAIRS_PER_TOKEN:
//
//   * BUDGET PER COMPARTMENT PAIR, not per token. The cap exists to stop ONE firehose
//     token exploding a single seam; a resource with symmetric writer/reader lists (which
//     is what inference emits — nothing in code says which side writes) legitimately has
//     k(k-1) compartment pairs. 2 compartments x 4 symbols wants 32 edges and got 25.
//   * ROUND-ROBIN within a pair, so a truncation spreads across sources instead of
//     exhausting the budget on the first one. 3 compartments x 6 symbols produced 3
//     distinct sources out of 18 — 15 symbols with no outgoing seam at all.
//   * DETERMINISTIC. Symbols are sorted by id, so what survives a truncation does not
//     depend on Map iteration order.
//
// `onDrop(fromComp, toComp, dropped, total)` is called for every truncation. The design
// doc's principle is NO SILENT CAPS: the old loop dropped edges with no log line anywhere.
function crossCompartmentPairs(froms, tos, budget, onDrop = () => {}) {
  const byComp = (syms) => {
    const m = new Map();
    for (const s of syms) {
      if (!m.has(s.compartment)) m.set(s.compartment, []);
      m.get(s.compartment).push(s);
    }
    for (const v of m.values()) v.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return new Map([...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  };
  const F = byComp(froms), T = byComp(tos);
  const out = [];
  for (const [fc, fs] of F) {
    for (const [tc, ts] of T) {
      if (fc === tc) continue;   // intra-compartment is the call graph's job, not a seam
      const total = fs.length * ts.length;
      let taken = 0;
      // (i, off) -> (fs[i], ts[(i+off) % ts.length]) enumerates every pair exactly once,
      // breadth-first over sources.
      for (let off = 0; off < ts.length && taken < budget; off++) {
        for (let i = 0; i < fs.length && taken < budget; i++) {
          out.push([fs[i], ts[(i + off) % ts.length]]);
          taken++;
        }
      }
      if (taken < total) onDrop(fc, tc, total - taken, total);
    }
  }
  return out;
}

export function buildWireEdges(graph, contracts, log = () => {}) {
  // Merge specs sharing a contractId first, so cById holds the SAME union of
  // tokens/wireRoles the merged Contract node does — a hand-authored channel and an
  // inferred one that collide on the id both keep their roles here (M2). Idempotent
  // when the caller already passed merged contracts (loadAllContracts does).
  // Resource contracts are NOT wires (writer/reader, presence-as-state — no
  // request/reply orientation and no `c2s` direction), so they are excluded here and
  // derived by buildResourceEdges instead. Dropping them from cById is what keeps a
  // resource token from also minting a WIRE edge below.
  //
  // INPROC IS EXCLUDED FOR THE SAME REASON, and the exclusion is not optional. An inproc
  // contract ALWAYS carries roles, so without this line it would satisfy `anyRoles`, take
  // the producers->consumers branch and mint a WIRE edge labelled `c2s` for every seam —
  // silently doubling every in-process seam into a second, wrong edge type that every
  // export and visualization reads as a network call. mergeContracts sets `kind` on every
  // merged contract, so a kind-less descriptor cannot slip through as inproc.
  const merged = mergeContracts(contracts).filter((c) => c.kind !== 'resource' && c.kind !== 'inproc');
  const cById = new Map(merged.map((c) => [c.id, c]));
  // Two ways to orient a WIRE edge: the producer/consumer compartments the
  // inference encoded per channel (x-wiregraph-*, read into c.wireRoles), or — for
  // a hand-written spec without them — the WIREGRAPH_SERVER_REPO env var. With
  // neither, skip: REFERENCES + Contract nodes are unaffected, only WIRE.
  const anyRoles = merged.some((c) => c.wireRoles && c.wireRoles.size);
  if (!anyRoles && !SERVER_COMPARTMENT) {
    log('  WIRE edges skipped (no producer/consumer compartments in specs; set WIREGRAPH_SERVER_REPO for hand-written specs without direction)');
    return { wire: 0, gaps: 0 };
  }

  const groups = groupContractReferences(graph);

  let wire = 0, gaps = 0, truncated = 0;
  const seen = new Set();
  for (const [key, syms] of groups) {
    const [cid, token] = splitGroupKey(key);
    const c = cById.get(cid);
    if (!c) continue;

    let pubs, cons, dirLabel;
    const roles = c.wireRoles && c.wireRoles.get(token);
    if (roles && (roles.producers.size || roles.consumers.size)) {
      // Direction encoded by inference: producers (callers/senders) -> consumers
      // (definers/receivers). No env var needed — the scan already knew the sides.
      pubs = syms.filter((s) => roles.producers.has(s.compartment));
      cons = syms.filter((s) => roles.consumers.has(s.compartment));
      dirLabel = 'c2s';
    } else if (SERVER_COMPARTMENT) {
      // Hand-written spec without the extension: orient via the configured server.
      const server = syms.filter((s) => s.compartment === SERVER_COMPARTMENT);
      const terminal = syms.filter((s) => s.compartment !== SERVER_COMPARTMENT);
      const dir = c.direction[token] || 'unknown';
      if (dir === 's2c') { pubs = server; cons = terminal; dirLabel = 's2c'; }
      else { pubs = terminal; cons = server; dirLabel = dir === 'unknown' ? 'c2s?' : 'c2s'; }
    } else { continue; } // this contract has no roles and no env server — can't orient
    if (!pubs.length || !cons.length) { gaps++; continue; }

    // A WIRE edge is a CROSS-compartment seam. If a compartment both produces and
    // consumes a token (defines a route it also calls), it lands in both pubs and cons —
    // but an edge between two of its own symbols is intra-compartment (the call graph's
    // job), not a wire. crossCompartmentPairs skips those, applies the fan-out cap per
    // compartment pair, and REPORTS every truncation instead of dropping edges silently.
    for (const [p, q] of crossCompartmentPairs(pubs, cons, MAX_PAIRS_PER_TOKEN,
      (fc, tc, dropped, total) => {
        truncated++;
        log(`  ⚠ fan-out cap: contract "${c.name}" token ${token} — ${fc} -> ${tc} has ${total} symbol pairs, capped at ${MAX_PAIRS_PER_TOKEN}; ${dropped} WIRE edge(s) NOT derived`);
      })) {
      if (p.id === q.id) continue;
      // Keyed by CONTRACT too. Two differently-titled specs can name the same channel
      // between the same two symbols — two findings under two contract names, not one
      // edge seen twice — and without this term the second was dropped here, upstream
      // of the store's own dedup, so the losing contract reported `ok` with no edges.
      const k = `${c.id}|${p.id}->${q.id}|${token}`;
      if (seen.has(k)) continue;
      seen.add(k);
      graph.addEdge('WIRE', p.id, q.id, {
        token, contract: c.name, direction: dirLabel, evidence: 'wire-derived',
      });
      wire++;
    }
  }
  log(`  derived ${wire} WIRE edges (symbol->symbol); ${gaps} one-sided tokens (no wire = gap)${truncated ? `; ${truncated} token/compartment-pair(s) hit the fan-out cap` : ''}`);
  return { wire, gaps, truncated };
}

// Derive direct symbol -> symbol RESOURCE edges — the resource-contract analogue of
// buildWireEdges. Same shape (group the REFERENCES already in the graph by
// contractId|token, then cross the two role sides), different semantics:
//
//   * roles are WRITERS -> READERS (wireRoles.producers -> wireRoles.consumers),
//     not producers/consumers of a request; many-writer and many-reader both work;
//   * the direction label is 'w2r' (writer to reader), never 'c2s'/'s2c' — there is
//     no client/server here and no request/reply round trip;
//   * there is NO env-var fallback. A resource contract is hand-declared and ALWAYS
//     carries its roles, so WIREGRAPH_SERVER_REPO is irrelevant — which also means a
//     resource-only project derives its seams with no configuration at all
//     (buildWireEdges' "no roles anywhere -> skip" early return cannot gate this).
//
// A RESOURCE edge is a distinct edge TYPE rather than a flavour of WIRE so existing
// wire counts/exports are untouched and a shared-state seam is never mistaken for a
// call/response wire. Everything that prunes or re-derives WIRE must handle RESOURCE
// too (store/sqlite.js: pruneFile + rederiveWireEdges) or the seam is deleted on
// every file save and never rebuilt.
export function buildResourceEdges(graph, contracts, log = () => {}) {
  // Cheap discriminator FIRST. mergeContracts walks every contract, token, direction and
  // role set — a real cost on the incremental re-derive, which runs on every file save —
  // and a wire-only project would have paid it in full only to discard the result. `kind`
  // survives the merge untouched, so testing it on the raw list is equivalent.
  if (!contracts.some((c) => c.kind === 'resource')) return { resource: 0, gaps: 0 };
  const merged = mergeContracts(contracts).filter((c) => c.kind === 'resource');
  if (!merged.length) return { resource: 0, gaps: 0 };
  const cById = new Map(merged.map((c) => [c.id, c]));
  const groups = groupContractReferences(graph);

  let resource = 0, gaps = 0, truncated = 0;
  const seen = new Set();
  for (const [key, syms] of groups) {
    const [cid, token] = splitGroupKey(key);
    const c = cById.get(cid);
    if (!c) continue;
    const roles = c.wireRoles && c.wireRoles.get(token);
    if (!roles) continue;
    const writers = syms.filter((s) => roles.producers.has(s.compartment));
    const readers = syms.filter((s) => roles.consumers.has(s.compartment));
    // One side missing = the seam's other half is absent (unindexed, or drifted off
    // the constant). Made visible by absence, exactly as for a wire.
    if (!writers.length || !readers.length) { gaps++; continue; }

    // Cross-compartment only: a compartment that both writes and reads its own resource
    // is internal state, not a seam. The symmetric roles an inferred draft emits make
    // the fan-out cap bite on LEGITIMATE seams, so the budget is per compartment pair and
    // every truncation is logged — see crossCompartmentPairs.
    for (const [w, r] of crossCompartmentPairs(writers, readers, MAX_PAIRS_PER_TOKEN,
      (fc, tc, dropped, total) => {
        truncated++;
        log(`  ⚠ fan-out cap: resource "${token}" (contract "${c.name}") — ${fc} -> ${tc} has ${total} writer/reader symbol pairs, capped at ${MAX_PAIRS_PER_TOKEN}; ${dropped} RESOURCE edge(s) NOT derived. Pruning the writers:/readers: lists to the real roles removes the cross product.`);
      })) {
      if (w.id === r.id) continue;
      // Keyed by CONTRACT too — same reason as buildWireEdges. (Duplicate resource ids
      // across differently-titled specs are refused at load, so this is belt-and-braces;
      // it keeps the two derivations' dedup rules identical rather than subtly different.)
      const k = `${c.id}|${w.id}->${r.id}|${token}`;
      if (seen.has(k)) continue;
      seen.add(k);
      graph.addEdge('RESOURCE', w.id, r.id, {
        token, contract: c.name, direction: 'w2r', evidence: 'resource-derived',
      });
      resource++;
    }
  }
  log(`  derived ${resource} RESOURCE edges (writer->reader); ${gaps} one-sided resource(s) (no writer or no reader = gap)${truncated ? `; ${truncated} resource/compartment-pair(s) hit the fan-out cap` : ''}`);
  return { resource, gaps, truncated };
}

// Derive direct symbol -> symbol INPROC edges — the in-process-contract analogue of
// buildResourceEdges. Same shape (group the REFERENCES already in the graph by
// contractId|token, then cross the two role sides), different semantics again:
//
//   * roles are PROVIDER -> CONSUMERS (wireRoles.producers -> wireRoles.consumers). The
//     producer side always holds exactly ONE compartment — the parser refuses more — so
//     unlike a resource seam this one cannot fan out in both directions;
//   * the direction label is 'p2c' (provider to consumer), never 'c2s'/'s2c' (there is no
//     client/server and no round trip) and never 'w2r' (nothing is written);
//   * there is NO env-var fallback, for the same reason buildResourceEdges has none: the
//     spec always carries its roles, so an inproc-only project derives its seams with no
//     configuration at all.
//
// WHY A DISTINCT EDGE TYPE rather than a flavour of RESOURCE: an in-process call across a
// crate boundary and a shared file on disk are different couplings with different
// remedies, and collapsing them would make `path_between` explain a direct type dependency
// as shared state. Everything that prunes or re-derives WIRE/RESOURCE must handle INPROC
// too (store/sqlite.js: DERIVED_EDGE_TYPES drives pruneFile + rederiveWireEdges) or the
// seam is deleted on every file save and never rebuilt.
//
// WHAT THIS DOES NOT DO, stated because the edge looks like more than it is: an INPROC edge
// means "a symbol in the provider compartment and a symbol in the consumer compartment both
// spell this declared name". It is NOT a resolved call — resolve.js still refuses to link
// calls across a compartment boundary by name, and letting a contract AUTHORIZE that
// resolution is deliberately out of scope here.
export function buildInprocEdges(graph, contracts, log = () => {}) {
  // Cheap discriminator FIRST — same reason as buildResourceEdges: mergeContracts walks
  // every contract, token, direction and role set, and this runs on every file save.
  if (!contracts.some((c) => c.kind === 'inproc')) return { inproc: 0, gaps: 0 };
  const merged = mergeContracts(contracts).filter((c) => c.kind === 'inproc');
  if (!merged.length) return { inproc: 0, gaps: 0 };
  const cById = new Map(merged.map((c) => [c.id, c]));
  const groups = groupContractReferences(graph);

  let inproc = 0, gaps = 0, truncated = 0;
  const seen = new Set();
  for (const [key, syms] of groups) {
    const [cid, token] = splitGroupKey(key);
    const c = cById.get(cid);
    if (!c) continue;
    const roles = c.wireRoles && c.wireRoles.get(token);
    if (!roles) continue;
    // THE ROLE FILTER IS THE FALSE-POSITIVE BOUND, not just an orientation step. An inproc
    // id is a short symbol name by nature (see extract/inproc-spec.js LIMITATION #2), so a
    // third compartment that happens to spell the same name WILL mint REFERENCES — and it
    // is these two filters that stop it from ever becoming a seam. It surfaces instead as
    // an undeclared participant in trace_contract, which is the honest report.
    const providers = syms.filter((s) => roles.producers.has(s.compartment));
    const consumers = syms.filter((s) => roles.consumers.has(s.compartment));
    // One side missing = the seam's other half is absent (unindexed, renamed, or reached
    // only through an alias the matcher cannot see). Made visible by absence, exactly as
    // for a wire and a resource.
    if (!providers.length || !consumers.length) { gaps++; continue; }

    // Cross-compartment only. The parser already refuses a spec that names one compartment
    // as both provider and consumer of an id, so unlike the resource case this guard is a
    // backstop rather than the primary defence — but it must stay, because a compartment
    // can be the declared provider of one id and a declared consumer of another in the same
    // contract, and the role sets are read per token from a merged contract.
    for (const [p, q] of crossCompartmentPairs(providers, consumers, MAX_PAIRS_PER_TOKEN,
      (fc, tc, dropped, total) => {
        truncated++;
        log(`  ⚠ fan-out cap: symbol "${token}" (contract "${c.name}") — ${fc} -> ${tc} has ${total} provider/consumer symbol pairs, capped at ${MAX_PAIRS_PER_TOKEN}; ${dropped} INPROC edge(s) NOT derived. A short, common id is the usual cause — most of those pairs are unrelated symbols that merely spell the same name.`);
      })) {
      if (p.id === q.id) continue;
      // Keyed by CONTRACT too — same reason as buildWireEdges/buildResourceEdges, and the
      // same key shape the store's dedup uses, so a re-derive can never collapse two
      // contracts' seams where a full rebuild keeps both.
      const k = `${c.id}|${p.id}->${q.id}|${token}`;
      if (seen.has(k)) continue;
      seen.add(k);
      graph.addEdge('INPROC', p.id, q.id, {
        token, contract: c.name, direction: 'p2c', evidence: 'inproc-derived',
      });
      inproc++;
    }
  }
  log(`  derived ${inproc} INPROC edges (provider->consumer); ${gaps} one-sided symbol(s) (no provider or no consumer = gap)${truncated ? `; ${truncated} symbol/compartment-pair(s) hit the fan-out cap` : ''}`);
  return { inproc, gaps, truncated };
}
