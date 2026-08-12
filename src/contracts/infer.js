// Contract INFERENCE: turn cross-compartment communication signals observed in
// code — HTTP routes and message topics today — into a draft AsyncAPI 3.0 spec,
// so wiregraph builds the cross-service graph without hand-written contracts. The
// synthesized spec is consumed by the EXISTING pipeline unchanged (loadContracts
// -> matchContracts -> buildWireEdges in src/extract/contracts.js).
//
// Detectors (src/extract/parse.js) emit candidates { kind, token, role, label };
// here we cluster the distinctive tokens shared by >= 2 compartments into seams and
// synthesize one AsyncAPI channel per seam. CRITICAL round-trip: the channel
// `address` is what collectTokens reads back (a path is {param}-trimmed to a
// prefix; a non-path topic is matched literally), so the inferred spec lights up
// REFERENCES edges from every compartment that mentions the token. Drafts are PROPOSED,
// evidence-tagged, never silently written — direction is heuristic, the shared
// token is the real signal.

import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { walkSources } from '../extract/walk.js';
import { parseSource, shapeCandidate } from '../extract/parse.js';
import {
  isDistinctive, compileTokenRegexes, scanTokenOccurrences,
  specContentDigest, INFERRED_MARKER_KEY, INFERRED_DIGEST_KEY,
} from '../extract/contracts.js';
import { whyNotDistinctive } from '../extract/distinctive.js';
import { resolveImports } from './imports.js';
import { fileId, moduleId } from '../model.js';
import { RESOURCE_KINDS } from '../extract/resource-spec.js';

// --- 1. extract contract candidates across the workspace --------------------
// Mirrors extractCode's walk loop, collecting the `candidates` parseSource now
// returns. fileFilter (optional Set of abs paths) restricts the scan. `roots` may
// be a single root (string) or a UNION of member roots (array) — walkSources
// shares one dedup set across the union so overlapping members are counted once.
// The full signal set from one walk: the candidates AND the per-file comment ranges the
// SAME parse produced. Reference discovery must not count a token that appears only in
// prose, and it reads raw file text — so the ranges have to travel with the candidates.
// `comments` is `${compartment}\0${relPath}` -> [[start,end), …].
export function extractSignals(roots, fileFilter = null) {
  const candidates = [];
  const comments = new Map();
  // `lang -> Map(compartment -> file count)`. Not a statistic: it is the ONLY way the
  // report can distinguish "your compartments share no routes" from "wiregraph has no
  // route rule for the language your server is written in". A missing route rule produces
  // no candidates AT ALL, so nothing downstream of this walk can ever notice it — the
  // absence has to be recorded HERE, where the files are still in hand. See
  // WIRE_SIGNAL_LANGS.
  const langFiles = new Map();
  for (const f of walkSources(roots)) {
    if (fileFilter && !fileFilter.has(f.abs)) continue;
    let byComp = langFiles.get(f.lang);
    if (!byComp) { byComp = new Map(); langFiles.set(f.lang, byComp); }
    byComp.set(f.compartment, (byComp.get(f.compartment) || 0) + 1);
    let src;
    try { src = readFileSync(f.abs, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = parseSource(src, f.lang, f.variant); } catch { continue; }
    for (const c of parsed.candidates || []) candidates.push(shapeCandidate(c, f));
    if (parsed.comments?.length) comments.set(`${f.compartment}\0${f.relPath}`, parsed.comments);
  }
  return { candidates, comments, langFiles };
}

// The languages whose extractor rule emits `wire` (HTTP route) or `message` (topic)
// candidates — src/extract/parse.js RULES: tsSig -> tsRoute/tsMessage, pySig ->
// pyRoute/pyMessage. cSig, javaSig, ktSig and rustSig emit only `state`/`import`/`const`,
// so a route literal in those languages is invisible to inference by construction.
//
// KEPT NEXT TO THE REPORT, NOT NEXT TO THE RULES, on purpose: this list exists to be
// PRINTED, and its whole value is that it goes stale loudly (a scan that keeps naming Rust
// after a Rust route rule lands is an obvious bug) rather than quietly (today's silence).
export const WIRE_SIGNAL_LANGS = new Set(['typescript', 'python']);

// Indexed languages with NO route/topic rule, with how many files and compartments each
// covers, biggest first. Empty when every indexed language is covered — in which case the
// coverage note is not printed at all, so a pure TS/JS project's output is unchanged.
export function wireBlindLanguages(langFiles) {
  const out = [];
  for (const [lang, byComp] of langFiles || new Map()) {
    if (WIRE_SIGNAL_LANGS.has(lang)) continue;
    let files = 0;
    for (const n of byComp.values()) files += n;
    if (!files) continue;
    out.push({ lang, files, compartments: [...byComp.keys()].sort() });
  }
  return out.sort((a, b) => b.files - a.files || a.lang.localeCompare(b.lang));
}

export function extractCandidatesAcross(roots, fileFilter = null) {
  return extractSignals(roots, fileFilter).candidates;
}

// Single-root convenience (back-compat): unchanged behavior for existing callers.
export function extractCandidates(root, fileFilter = null) {
  return extractCandidatesAcross(root, fileFilter);
}

// Candidates for a UNION of roots -> cross-compartment seams. This is what link /
// unlink and /wiregraph-contracts use so inference spans every member.
export function inferSeamsAcross(roots, fileFilter = null) {
  return clusterSeams(extractCandidatesAcross(roots, fileFilter));
}

// --- 2. cluster shared tokens into cross-compartment seams ------------------
// HTTP path -> AsyncAPI address form (`:id`/`<id>` -> `{id}`) so variants group
// and collectTokens' {param}-trim applies; message topics are kept verbatim.
export function toAsyncApiPath(p) {
  return '/' + String(p).split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) return `{${seg.slice(1)}}`;
    if (seg.startsWith('{') && seg.endsWith('}')) return seg;
    if (seg.startsWith('<') && seg.endsWith('>')) return `{${seg.slice(1, -1)}}`;
    // template-literal params: `${name}` -> `{name}`, whole-segment and
    // intra-segment (e.g. `/files/${name}.json` -> `/files/{name}.json`),
    // mirroring the name-agnostic H2 pathTokenRegex matcher.
    return seg.replace(/\$\{([A-Za-z0-9_]+)\}/g, '{$1}');
  }).join('/');
}

function normToken(kind, token) {
  return kind === 'wire' ? toAsyncApiPath(token) : token;
}

function channelKey(kind, token) {
  const base = token.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}-${base || 'x'}`.toLowerCase();
}

// Group candidates by (kind, normalized token); keep tokens that are distinctive
// AND span >= 2 distinct compartments (the cross-compartment seam — a
// single-compartment token is not a contract). Returns
// [{ kind, token, compartments, inCompartments, outCompartments, labels }].
// A token a hand-written spec already declares is not a proposal — it is a decision the
// user has already made and committed. Both clusterers therefore take an `exclude` set
// (extract/contracts.js#handWrittenTokens) and drop those tokens with a REASON, never
// silently: "why is my seam missing from the scan" and "why is the scan proposing what I
// already wrote" are both questions the report has to answer out loud.
//
// COMPARISON IS PARAM-CANONICALISED for the wire side. A declared `/orders/{orderId}` and
// an inferred `/orders/{id}` are the SAME endpoint pattern — clusterSeams already collapses
// `{anything}` to `{}` to group a client and a server route that differ only in param name,
// and the exclusion has to use the identical key or a declared route escapes it on a
// spelling. Resource ids are plain constant names with no params, so they compare verbatim
// and pass through this unchanged.
const paramCanonToken = (tok) => String(tok).replace(/\{[^/{}]*\}/g, '{}');
function excludeSet(exclude) {
  const s = new Set();
  for (const t of exclude || []) { s.add(String(t)); s.add(paramCanonToken(t)); }
  return s;
}

// NOTHING IS DROPPED SILENTLY ON THE WIRE SIDE EITHER. The resource clusterer has printed
// "Named constants considered and DECLINED" with a reason per name since 1b; the wire
// clusterer printed a reason for exactly ONE case (already declared by hand) and dropped
// everything else without a word. So a scan that proposed 2 of a repo's 5 real seams said
// nothing whatsoever about the other 3, and the user had no way to tell "there are no more
// seams" from "I cannot see your seams". Two classes were invisible:
//
//   * SEEN IN ONLY ONE COMPARTMENT — the ">= 2 compartments" gate, which is the single
//     most common reason a real seam is missed. It fires when the OTHER half is written in
//     a language with no route rule (parse.js RULES has `wire`/`message` for TS/JS and
//     Python only — Rust, C, Java and Kotlin emit neither), when the other half builds its
//     URL dynamically, or when the peer simply is not indexed. Under the old code such a
//     token never even reached the reporting loop.
//   * NOT DISTINCTIVE ENOUGH — `/api`, `/health`, a 3-letter topic. Reported only when at
//     least two compartments share it, mirroring the resource side's rule: a token one
//     compartment mentions could not have been a seam under ANY rule, so listing it would
//     bury the answer under every string in the repo.
//
// ORDER MATTERS because formatSeams truncates the list: already-declared first (the user
// asked for those by writing a spec), then near misses, then the long tail.
export function clusterSeams(candidates, opts = {}) {
  const declared = excludeSet(opts.exclude);
  const rejected = opts.rejected || [];
  const notDistinctive = [];
  const lonely = [];
  // Canonicalize param NAMES in the grouping key only: `/orders/{id}` and
  // `/orders/{orderId}` are the SAME endpoint pattern, so a client route and a
  // server route that differ only in param name must cluster into one seam. We
  // collapse every `{anything}` to `{}` for the KEY but KEEP the first-seen real
  // token as the seam address (readable param name; the name-agnostic H2 matcher
  // matches both sides). A non-path token has no `{}` so it's unaffected. Distinct
  // static segments (`/orders/{id}` vs `/users/{id}`) still differ and won't merge.
  const paramCanon = (tok) => tok.replace(/\{[^/{}]*\}/g, '{}');
  const groups = new Map(); // key -> { kind, token, compartments: Map(compartment->Set(role)), labels: Set }
  for (const c of candidates) {
    if (c.kind === 'import') continue; // imports become IMPORTS edges, not token-matched contracts
    // 'const' candidates (named string constants) are RESOURCE-seam raw material, joined
    // on name AND value by a separate clusterer. They must not fall through to this
    // wire/message/state clusterer: it groups on the token alone, so two compartments
    // that merely declare the same constant name with DIFFERENT values would be emitted
    // as a bogus AsyncAPI channel — and every constant name would inflate the
    // `inferredSeams` count that drives the /wiregraph-contracts nudge.
    if (c.kind === 'const') continue;
    const tok = normToken(c.kind, c.token);
    // Grouped BEFORE the distinctiveness gate, not after, so the report can say how many
    // compartments a rejected token spans. The seam list is unaffected — the gate is
    // simply applied one loop later.
    const key = `${c.kind}\0${paramCanon(tok)}`;
    if (!groups.has(key)) groups.set(key, { kind: c.kind, token: tok, compartments: new Map(), labels: new Set() });
    const g = groups.get(key);
    if (!g.compartments.has(c.compartment)) g.compartments.set(c.compartment, new Set());
    g.compartments.get(c.compartment).add(c.role);
    if (c.label) g.labels.add(c.label);
  }
  const seams = [];
  for (const g of groups.values()) {
    const comps = [...g.compartments.keys()].sort();
    if (!isDistinctive(g.token)) {
      if (comps.length >= 2) notDistinctive.push(`${g.token} (${comps.join(', ')}): not distinctive enough to be a join key — ${whyNotDistinctive(g.token)}. It would match unrelated code in every compartment.`);
      continue;
    }
    if (comps.length < 2) {
      lonely.push(`${g.token} (${comps.join(', ')}): seen in only ONE compartment — a seam needs two, so there is nothing to join. The other half may be written in a language with no route/topic rule (see the coverage note), may build its URL dynamically, or may not be indexed in this workspace.`);
      continue;
    }
    // Filtered HERE, not at the top of the candidate loop, so the message can say which
    // compartments the already-declared seam spans — the useful half of the information.
    if (declared.has(g.token) || declared.has(paramCanon(g.token))) {
      rejected.push(`${g.token} (${comps.join(', ')}): already declared by a hand-written contract — not re-proposed`);
      continue;
    }
    const inCompartments = [...g.compartments].filter(([, roles]) => roles.has('in')).map(([r]) => r).sort();
    const outCompartments = [...g.compartments].filter(([, roles]) => roles.has('out')).map(([r]) => r).sort();
    seams.push({ kind: g.kind, token: g.token, compartments: comps, inCompartments, outCompartments, labels: [...g.labels].sort() });
  }
  for (const r of notDistinctive.sort()) rejected.push(r);
  for (const r of lonely.sort()) rejected.push(r);
  return seams.sort((a, b) => (a.kind + a.token).localeCompare(b.kind + b.token));
}

// --- 2b. cluster shared CONSTANTS into cross-compartment RESOURCE seams ------
//
// A resource seam is two compartments coupled through a shared file/table/region
// rather than through a wire. The join key is a named CONSTANT (wiregraph is
// deliberately literal-blind), and there are two layouts to find, which need two
// different pieces of evidence:
//
//   VENDORED — each compartment carries its OWN copy of the constants module. Every
//     compartment therefore DEFINES the constant, and no cross-compartment import
//     exists at all (imports.js skips same-compartment targets by design). The join is
//     same NAME *and* same VALUE.
//   SHARED  — one constants module, both compartments import it. Only ONE compartment
//     defines anything, so definitions alone yield one compartment and no seam. The
//     other compartments have to be found by REFERENCE.
//
// Reference discovery reuses matchContracts' own scanner (scanTokenOccurrences) rather
// than adding per-language identifier grammar: same `\bNAME\b` rule, same import-line
// exclusion, same definition-site exclusion. That equivalence is load-bearing, not
// tidiness — matchContracts is what will actually mint the REFERENCES for the spec this
// emits, so a seam proposed under a different rule would land in a spec and derive
// nothing.
//
// WHAT IS REJECTED, and why it needs a real tuple join rather than a parameter:
// clusterSeams groups on ONE string, so a `const DATA_DIR` in two compartments with two
// DIFFERENT values would group as one seam. Two compartments naming the same constant
// with different values are coupled to nothing — they share a spelling. So the value is
// carried through the group and a name whose definitions disagree is dropped whole,
// rather than being emitted as a seam whose id means two things.

// A compartment that only DEFINES a constant (the constants module itself) is not a
// participant in the seam: it declares the name, it does not touch the resource. This
// is the same rule matchContracts applies when minting REFERENCES, so the emitted spec
// and the derived edges agree.
// --- what counts as a RESOURCE IDENTIFIER ------------------------------------
//
// The old rule was "the value has no whitespace in it". It let through every dominant
// false-positive class, all of them measured as `kind: path` proposals:
//
//   __version__ = "0.0.1"                              a version string
//   DEFAULT_MODEL = "gpt-4o-mini"                      a model id
//   EVENT_KIND_CREATED = 'created'                     an enum member
//   DEFAULT_ENCODING = 'utf8'                          a codec name
//   BILLING_API_BASE = 'https://api.example.com/v1/…'  a wire concern, not a resource
//   _UA = "Argus/0.1 (local memory assistant)"         a user-agent
//
// A real multi-repo scan turned up version strings, user-agents, URLs and output
// filenames — and not one shared resource. So the test is no longer "does the value look
// tidy" but "does anything here actually IDENTIFY a shared resource":
//
//   1. the VALUE carries a path separator (`/` or `\`) — a file, dir, socket or fifo
//      path, the overwhelmingly common case; or
//   2. the NAME is resource-shaped — one of its words is PATH/FILE/DIR/LOCK/SOCK/
//      SOCKET/PIPE/FIFO/SHM/TABLE/QUEUE/CACHE/DB/STORE. This is what catches a DB table,
//      a shm key or a queue name, none of which contain a separator.
//
// …and a URL scheme REJECTS outright regardless: `https://…` is a wire seam, which the
// AsyncAPI side already models, and inferring it as a shared FILE would be wrong twice.
const RESOURCE_WORDS = new Set(['PATH', 'FILE', 'DIR', 'LOCK', 'SOCK', 'SOCKET', 'PIPE', 'FIFO', 'SHM', 'TABLE', 'QUEUE', 'CACHE', 'DB', 'STORE']);
const URL_SCHEME_RE = /\b(?:https?|wss?):\/\//i;

// Split an identifier into WORDS, so the match is word-boundary aware rather than a
// substring test: `INDEX_CACHE_PATH` and `gameStatePath` both yield a `PATH` word, while
// `PROFILE_NAME` does not yield `FILE` and `DEBUG_LEVEL` does not yield `DB`.
export function identifierWords(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')      // camelCase / PascalCase humps
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')   // ACRONYMWord
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}
export function isResourceShapedName(name) {
  return identifierWords(name).some((w) => RESOURCE_WORDS.has(w));
}

// Does (name, value) plausibly identify a SHARED RESOURCE? Returns null when it does, or
// a short reason when it does not (the reason is reported, never swallowed).
//
// NOTE ON WHITESPACE — the rule this replaces. Once escapes are decoded (see
// parse.js#decodeConstValue) a blanket "no whitespace" test is both too weak and too
// strong. Too weak: `'Run\tthe\tthing\tto\tfix\tit.'` has no whitespace in its SOURCE and
// sailed through; every one of the false positives above has no whitespace at all. Too
// strong: `'/Users/me/Library/Application Support/Acme/state.json'` and a quoted DB
// identifier with a space in it are genuine resource ids that it rejected BY
// CONSTRUCTION, so macOS and Windows paths could never be seen. The shape rule below does
// the discriminating that the whitespace test was standing in for, so the whitespace test
// is gone — replaced by a narrow reject for CONTROL whitespace (newline / tab / CR),
// which no filesystem path, table name or shm key contains and which is what prose and
// embedded blobs actually look like once decoded.
export function whyNotResourceValue(name, value) {
  const v = String(value ?? '');
  if (!v) return 'the value is empty';
  if (/[\n\r\t\0]/.test(v)) return 'the value contains a newline/tab — prose or an embedded blob, not an identifier';
  if (URL_SCHEME_RE.test(v)) return `the value carries a URL scheme — "${v}" is a wire endpoint, not a shared resource`;
  // A resource-shaped NAME is the strongest signal there is, and it is what licenses a
  // value with SPACES in it: `/Users/me/Library/Application Support/…` and a quoted DB
  // identifier are genuine resource ids, and the old whitespace rule made them invisible.
  if (isResourceShapedName(name)) return null;
  // Otherwise the VALUE has to carry its own weight — a separator AND no whitespace. The
  // separator alone is not enough: `_UA = "Argus/0.1 (local memory assistant)"` has one,
  // and a user-agent was one of the classes a real multi-repo scan actually surfaced.
  if (v.includes('/') || v.includes('\\')) {
    if (!/\s/.test(v)) return null;
    return `the value "${v}" has a separator but also whitespace, and the name "${name}" carries no resource word — prose (a user-agent, a message), not an identifier`;
  }
  return `neither the value "${v}" (no path separator) nor the name "${name}" (no PATH/FILE/DIR/LOCK/SOCK/PIPE/SHM/TABLE/QUEUE/CACHE/DB/STORE word) identifies a resource`;
}

function constDefinitions(candidates, rejected) {
  const byName = new Map(); // name -> { values, unknown, sites, files, comps, declined }
  const get = (name) => {
    let d = byName.get(name);
    if (!d) d = { values: new Map(), unknown: new Set(), sites: new Map(), files: new Set(), comps: new Set(), declined: new Map() };
    byName.set(name, d);
    return d;
  };
  for (const c of candidates || []) {
    if (c?.kind !== 'const' || !c.name) continue;
    if (!isDistinctive(c.name)) continue;   // the SAME gate a resource id must pass to load
    if (c.name.includes('/') || /\s/.test(c.name)) continue; // resource-spec rejects both
    const d = get(c.name);
    d.comps.add(c.compartment);
    // DEFINITION-SITE INDEX, keyed on the declared name's OFFSET (see
    // extract/contracts.js#constDefIndex for why a line key is wrong). Recorded for EVERY
    // definition, including a value-unknown one — the site is a declaration either way.
    const k = `${c.compartment}\0${c.file}`;
    if (c.nameStart !== undefined) {
      if (!d.sites.has(k)) d.sites.set(k, new Set());
      d.sites.get(k).add(c.nameStart);
    }
    d.files.add(k);
    // "Definition present, value unknown" — an env-var fallback, a concatenation, a
    // `let`/`var` rebinding, an over-long blob. This compartment DEFINES the name, so it
    // is not a passive user of somebody else's value and must not be joined to one.
    // Measured hole this closes: `export const INDEX_CACHE_PATH = process.env.INDEX_CACHE
    // || '/somewhere/else/entirely.db'` produced NO candidate at all, so the compartment
    // read as a pure user and joined a seam on a value it does not use.
    if (c.value == null) { d.unknown.add(c.compartment); continue; }
    const why = whyNotResourceValue(c.name, c.value);
    if (why) {
      // Not a resource identifier — but still a DEFINITION, so the site stays indexed and
      // the name is not eligible on some other compartment's value either.
      d.unknown.add(c.compartment);
      d.declined.set(why, (d.declined.get(why) || new Set()).add(c.compartment));
      continue;
    }
    if (!d.values.has(c.value)) d.values.set(c.value, new Set());
    d.values.get(c.value).add(c.compartment);
  }
  // A name NO compartment binds to a usable resource value can never be a seam, and
  // keeping it would cost a compiled regex plus a full-tree scan per name — the exact
  // cost the value gate exists to avoid. Its `unknown` set is only ever consulted for a
  // name that some other compartment DOES bind to a value, so dropping it is free.
  //
  // What IS worth saying out loud is the near miss: a name that SEVERAL compartments
  // declare and whose value the shape rule rejected. That is the case a user asks about
  // ("why didn't it find my shared constant?"), and it is a tiny fraction of the
  // rejections — a name only one compartment declares could never have been a seam under
  // any rule, so reporting it would bury the answer in a list of every string constant in
  // the repo.
  for (const [name, d] of byName) {
    if (d.values.size) continue;
    if (rejected && d.comps.size >= 2) {
      for (const [why, comps] of d.declined) rejected.push(`${name} (${[...comps].sort().join(', ')}): ${why}`);
    }
    byName.delete(name);
  }
  return byName;
}

// Which compartments IMPORT a file that defines one of these constants, cross-compartment.
//
// THIS IS EVIDENCE, NOT A JOIN KEY — stated plainly because §11 called for "two
// mechanisms, both required" and that is NOT what shipped, nor what could ship. The
// IMPORTS edge links `<module>` to `<module>` (contracts/imports.js) and no language
// mints a symbol for a constant, so the strongest claim it can make is "A's module
// depends on B's module" — never "A uses B's constant X". Two compartments can import the
// same constants module and use entirely different constants out of it. So the join is
// made by the REFERENCE scan alone, and this is recorded as supporting evidence on a seam
// that scan already found: removing it changes no seam, only the `corroborated` field and
// the report line that prints it. (It is also TS/JS + C `#include` only; Python, Java,
// Kotlin and Rust emit no import candidates at all — see parse.js#rustSig for why a Rust
// `use` path cannot be resolved to a file — which is why the vendored name+value join is
// mandatory rather than a fallback.)
function importCorroboration(candidates, defsByName, compartments, files, moduleCompartment) {
  const out = new Map(); // constant name -> Set(compartment)
  const edges = resolveImports(candidates, { compartments, files });
  if (!edges.length) return out;
  const defModules = new Map(); // moduleId of a defining file -> Set(constant name)
  for (const [name, d] of defsByName) {
    for (const k of d.files) {
      const [comp, file] = k.split('\0');
      const id = moduleId(comp, file);
      if (!defModules.has(id)) defModules.set(id, new Set());
      defModules.get(id).add(name);
    }
  }
  for (const e of edges) {
    const names = defModules.get(e.to);
    if (!names) continue;
    // Looked up, not parsed back out of the id string: a compartment name is a directory
    // basename and may contain a ':'.
    const comp = moduleCompartment.get(e.from);
    if (!comp) continue;
    for (const n of names) {
      if (!out.has(n)) out.set(n, new Set());
      out.get(n).add(comp);
    }
  }
  return out;
}

// Group const candidates into resource seams. `roots` is the same root (or union of
// member roots) the candidates were extracted from — the reference scan re-reads those
// files (it does NOT re-parse them). Returns
// [{ kind:'resource', token, value, compartments, definers, corroborated, layout }].
export function clusterResourceSeams(candidates, roots, opts = {}) {
  // `opts.rejected` (optional array): every name this function declines, with the reason.
  // Nothing is dropped silently — a constant that ALMOST joined a seam is exactly what a
  // user asks about, and "it proposed nothing" with no explanation is unanswerable.
  // `opts.comments`: the per-file comment ranges from extractSignals.
  const rejected = opts.rejected || [];
  const comments = opts.comments || null;
  // `opts.exclude`: resource ids a HAND-WRITTEN spec already declares. Dropped BEFORE the
  // reference scan, not after — an excluded name costs a compiled regex plus a full-tree
  // scan it can never contribute to.
  const declared = excludeSet(opts.exclude);
  const defsByName = constDefinitions(candidates, rejected);
  for (const name of [...defsByName.keys()]) {
    if (!declared.has(name)) continue;
    rejected.push(`${name}: already declared by a hand-written resource contract — not re-proposed`);
    defsByName.delete(name);
  }
  if (!defsByName.size) return [];   // nothing named — no walk, no cost for wire-only projects

  const names = [...defsByName.keys()].sort();
  const tokenRe = compileTokenRegexes(names);
  const refs = new Map(names.map((n) => [n, new Set()]));  // name -> Set(compartment that USES it)
  // The minimum resolveImports needs to resolve a specifier: the compartment roots (for
  // package.json names and relative resolution) and the set of files that exist. Built
  // from the same walk the reference scan does, so it costs one Map/Set insert per file.
  const compartments = new Map();
  const files = new Set();
  const moduleCompartment = new Map(); // moduleId -> compartment

  for (const f of walkSources(roots)) {
    if (!compartments.has(f.compartment)) compartments.set(f.compartment, { name: f.compartment, root: f.compartmentRoot });
    files.add(fileId(f.compartment, f.relPath));
    moduleCompartment.set(moduleId(f.compartment, f.relPath), f.compartment);
    let text;
    try { text = readFileSync(f.abs, 'utf8'); } catch { continue; }
    const siteKey = `${f.compartment}\0${f.relPath}`;
    scanTokenOccurrences(text, names, tokenRe, (tok, line, at) => {
      if (defsByName.get(tok)?.sites.get(siteKey)?.has(at)) return; // its own declared name, not a use
      refs.get(tok).add(f.compartment);
    }, comments?.get(siteKey) || null);
  }

  const corroborated = importCorroboration(candidates, defsByName, compartments, files, moduleCompartment);

  const seams = [];
  for (const name of names) {
    const d = defsByName.get(name);
    // WHICH VALUE IS THE RESOURCE. Two compartments that agree on a spelling and disagree
    // on what it points at are not coupled to anything — but dropping the NAME whole, as
    // this did, means one stale copy kills the seam for everybody: two compartments
    // agreeing on '/var/spool/q' plus a third still saying '/var/spool/q-old' yielded
    // ZERO seams and no diagnostic at all. So: the value with the most DEFINING
    // compartments wins, the disagreeing compartments are reported as OUTLIERS and
    // excluded from the seam, and a genuine TIE (nothing to call the majority) is still
    // dropped whole — with a reason.
    const ranked = [...d.values.entries()].sort((a, b) => b[1].size - a[1].size || String(a[0]).localeCompare(String(b[0])));
    if (ranked.length > 1 && ranked[0][1].size === ranked[1][1].size) {
      rejected.push(`${name}: ${ranked.length} different values with no majority (${ranked.map(([v, cs]) => `${JSON.stringify(v)} in ${[...cs].sort().join('/')}`).join('; ')}) — a shared spelling, not a shared resource`);
      continue;
    }
    const [value, definerComps] = ranked[0];
    const outliers = [];
    const excluded = new Set(d.unknown);   // K3(b): a value-unknown definer is not a user
    for (const [v, comps] of ranked.slice(1)) for (const c of comps) { excluded.add(c); outliers.push({ compartment: c, value: v }); }
    const participants = [...refs.get(name)].filter((c) => !excluded.has(c)).sort();
    if (participants.length < 2) {         // a seam is cross-compartment by definition
      if (excluded.size && refs.get(name).size >= 2) {
        rejected.push(`${name}: only ${participants.length} compartment(s) left after excluding ${[...excluded].sort().join(', ')} (they define the name themselves, with a different or unreadable value)`);
      }
      continue;
    }
    const definers = [...definerComps].filter((c) => !excluded.has(c)).sort();
    for (const o of outliers.sort((a, b) => a.compartment.localeCompare(b.compartment))) {
      rejected.push(`${name}: ${o.compartment} disagrees — ${JSON.stringify(o.value)} vs the majority ${JSON.stringify(value)}; excluded from the seam`);
    }
    for (const c of [...d.unknown].sort()) {
      rejected.push(`${name}: ${c} defines the name with a value wiregraph cannot read (env fallback / concatenation / rebinding); excluded from the seam rather than joined to a value it may not use`);
    }
    seams.push({
      kind: 'resource',
      token: name,
      value,
      compartments: participants,
      definers,
      outliers,
      corroborated: [...(corroborated.get(name) || [])].filter((c) => !excluded.has(c)).sort(),
      // How the two sides were joined, for the report: VENDORED when two or more
      // compartments define the same name+value, SHARED when one module defines it and
      // others reference it.
      layout: definers.length >= 2 ? 'vendored' : 'shared-module',
    });
  }
  return seams.sort((a, b) => a.token.localeCompare(b.token));
}

// --- 3. synthesize a draft AsyncAPI 3.0 doc ---------------------------------
// One channel per seam, address = the token (path or topic). A server-perspective
// `receive` operation per channel. We also record, as `x-wiregraph-*` extensions,
// which compartments PRODUCE (call/send — the seam's out side) and CONSUME
// (define/receive — the in side): the scan already knows this, so encoding it lets
// buildWireEdges derive directional producer->consumer WIRE edges straight from an
// inferred spec, with no WIREGRAPH_SERVER_REPO env var. (REFERENCES don't need it;
// directional WIRE does — and throwing the direction away made the round-trip lossy.)
export function synthesizeAsyncApi(seams, title = 'wiregraph-inferred') {
  const channels = {};
  const operations = {};
  const usedKeys = new Set();
  for (const s of seams) {
    // channelKey collapses every non-alphanumeric run to a single '-', so two
    // DISTINCT tokens of the same kind differing only by separators (message
    // device:heartbeat vs device.heartbeat; wire /order/created vs /order-created)
    // collide on one key. clusterSeams keeps them as separate seams, so assigning
    // channels[key] unconditionally would let the second seam overwrite the first
    // (dropping its address + roles, and its edges). Suffix collisions instead.
    let key = channelKey(s.kind, s.token);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}-${n}`)) n++;
      key = `${key}-${n}`;
    }
    usedKeys.add(key);
    channels[key] = { address: s.token, messages: { request: { payload: { type: 'object', properties: {} } } } };
    if (s.outCompartments.length) channels[key]['x-wiregraph-producers'] = s.outCompartments;
    if (s.inCompartments.length) channels[key]['x-wiregraph-consumers'] = s.inCompartments;
    operations[`receive-${key}`] = {
      action: 'receive',
      channel: { $ref: `#/channels/${key}` },
      messages: [{ $ref: `#/channels/${key}/messages/request` }],
    };
  }
  // AUTHORSHIP STAMP. Both keys, on both formats, for the reason spelled out at
  // extract/contracts.js#isGeneratedDraft: a filename is not evidence about content, and
  // OR-ing it in destroyed user edits. The marker says "wiregraph wrote this"; the DIGEST
  // says "and it has not been touched since". The moment a reviewer edits anything the
  // digest stops matching and the file becomes theirs — no marker to delete, nothing to
  // remember. The wire draft never carried the marker at all before this, so it was
  // identifiable ONLY by filename.
  //
  // The digest is taken over the doc as PARSED BACK, not over the object in hand, so it
  // is computed on exactly the value the loader will see (YAML's own scalar typing
  // included) rather than on a shape that merely resembles it.
  const body = {
    asyncapi: '3.0.0', info: { title, version: '0.1.0' }, [INFERRED_MARKER_KEY]: true, channels, operations,
  };
  const digest = specContentDigest(YAML.parse(YAML.stringify(body)));
  return YAML.stringify({ ...body, [INFERRED_DIGEST_KEY]: digest });
}

// --- 3b. synthesize a draft *.resource.yaml ---------------------------------
// The resource analogue of synthesizeAsyncApi, emitting the Phase 1a hand-written
// format (see extract/resource-spec.js for the accepted shape — this must produce specs
// that pass that parser's own validator, so ids are re-checked here for `/`, whitespace
// and duplicates even though the clusterer already filtered them).
//
// ROLE ASSIGNMENT — the one real judgment call, and the answer is "I cannot tell":
// the wire path infers roles from the candidate's `role` (a caller is a producer, a
// definer is a consumer). A named constant carries no such signal — `role` is 'unknown'
// — and the only mechanisms that could manufacture one (proximity to a write-shaped
// call, a per-language table of fs/DB write APIs) are exactly the per-language grammar
// this phase set out not to write, and would be wrong silently. A wrong role is worse
// than no role here: it does not degrade the seam, it INVERTS it, and the draft is
// explicitly a document the user owns and reviews. So every participating compartment is
// listed as BOTH a writer and a reader — the symmetric superset, which claims only
// "these compartments share this resource" — and the header says in one line that
// deleting the wrong side is the reviewer's job. `single_writer` is never emitted: it is
// a declared DISCIPLINE, and inventing one would manufacture violations out of a guess.
//
// Consequence, stated so it is not a surprise: until the lists are pruned, each pair
// derives a RESOURCE edge in both directions.
// Lines are comment BODIES — the YAML writer adds the `#` — so no leading marker here.
const RESOURCE_HEADER = [
  ' DRAFT — inferred by wiregraph from shared named constants. You own this file:',
  ' review it, prune it, commit it.',
  '',
  ' WRITERS/READERS ARE UNRESOLVED. wiregraph can see that these compartments share the',
  ' constant, but nothing in the code says which side WRITES and which side READS, so',
  ' every compartment is listed on BOTH sides. Delete the wrong side of each list — that',
  ' is what turns a shared name into a directional seam.',
  '',
  ' DO THAT FIRST, before adding anything else. While a resource still lists every',
  ' compartment as a writer, `single_writer: true` is guaranteed to report an immediate',
  ' VIOLATION that says nothing about your code — the writers list is a placeholder, not',
  ' an observation. Prune `writers:` to the one real writer, THEN declare single_writer.',
  '',
  " `kind` is guessed from the constant's value; `semantics` is the format default.",
  ' A compartment that names only the bare string literal, never the constant, is MISSED',
  ' by design (wiregraph is literal-blind).',
  '',
  ' `x-wiregraph-inferred: true` and `x-wiregraph-digest:` are how wiregraph recognises',
  ' this file as ITS draft rather than yours. LEAVE THEM AS THEY ARE — there is nothing',
  ' to delete. The digest covers the content exactly as generated, so the moment you edit',
  ' anything here (prune a role list, add `single_writer:`, drop a resource) it stops',
  ' matching and wiregraph treats the whole file as YOURS: a later scan will not',
  ' re-propose these ids, and a later apply will not overwrite what you wrote. Editing is',
  ' what claims the file — authorship is decided by the CONTENT, never by the filename.',
  ' (While the file is still untouched, the marker also suppresses the total-overlap',
  ' warning the unresolved roles above would otherwise raise on every build.)',
].join('\n');

// The resource KIND, read off the constant's value shape — the one part of the record
// the literal genuinely does tell us. Anything unrecognised is a `path`, the format's own
// default and the overwhelmingly common case.
//
// `db` is deliberately absent: nothing in a string literal distinguishes a table name
// from any other bare identifier, so it is only ever reachable from a HAND-WRITTEN spec.
// The two that ARE readable are pinned by their own unit assertions (test/run.mjs) —
// before that, this function could be replaced by `() => 'path'` with zero failures.
export function resourceKindFor(value) {
  const v = String(value || '');
  if (/^\/dev\/shm\//.test(v)) return 'shm';
  if (/\.(sock|socket|fifo|pipe)$/i.test(v) || /^\/dev\//.test(v)) return 'pipe';
  return 'path';
}

export function synthesizeResourceSpec(seams, title = 'wiregraph-inferred-resources') {
  const resources = [];
  const seen = new Set();
  for (const s of seams) {
    const id = String(s?.token || '');
    // Re-validated against the loader's rules rather than trusted: this emitter's output
    // has to survive parseResourceSpec, and a spec that logs "skipping" on load is worse
    // than one that was never written.
    if (!id || id.includes('/') || /\s/.test(id) || !isDistinctive(id) || seen.has(id)) continue;
    seen.add(id);
    const kind = resourceKindFor(s?.value);
    resources.push({
      id,
      kind: RESOURCE_KINDS.includes(kind) ? kind : 'path',
      semantics: 'presence-as-state',
      writers: [...(s?.compartments || [])],
      readers: [...(s?.compartments || [])],
    });
  }
  // The marker that tells parseResourceSpec this total-overlap is the EXPECTED shape of a
  // generated draft rather than a hand-written mistake. Without it the loader logged one
  // ⚠ per resource on every single build, through normal build output, using the same
  // marker as a genuine problem — and §11's "the generated spec loads cleanly with zero
  // warnings" was simply false.
  // See synthesizeAsyncApi for why the digest travels with the marker. specContentDigest
  // ignores the digest key itself, so hashing the body without it and then writing it in
  // round-trips exactly.
  const body = { title, [INFERRED_MARKER_KEY]: true, resources };
  const digest = specContentDigest(YAML.parse(YAML.stringify(body)));
  const doc = new YAML.Document({ title, [INFERRED_MARKER_KEY]: true, [INFERRED_DIGEST_KEY]: digest, resources });
  doc.commentBefore = RESOURCE_HEADER;
  // Per-resource: the observed VALUE and how the two sides were joined. A comment, not a
  // key — the loader ignores unknown keys silently, and the reviewer is the audience.
  const items = doc.get('resources')?.items || [];
  for (let i = 0; i < items.length; i++) {
    const s = seams.find((x) => x?.token === resources[i]?.id);
    if (!s) continue;
    const how = s.layout === 'vendored'
      ? `vendored copies in ${s.definers?.join(', ')} — joined on the same NAME and VALUE`
      : `defined once in ${s.definers?.join(', ')} — joined by reference${s.corroborated?.length ? `, import-corroborated from ${s.corroborated.join(', ')}` : ''}`;
    items[i].commentBefore = ` value: ${JSON.stringify(String(s.value ?? ''))}\n ${how}`;
  }
  return doc.toString();
}

// One-shot: candidates for a root -> seams. Convenience for the CLI/tests.
export function inferSeams(root, fileFilter = null) {
  return clusterSeams(extractCandidates(root, fileFilter));
}

// Human-readable summary of the RESOURCE seams (the resource analogue of formatSeams).
// Deliberately says what it could NOT determine — roles — because that is the one thing
// the reviewer has to supply.
export function formatResourceSeams(seams, rejected = []) {
  const tail = rejected.length
    ? ['', 'Named constants considered and DECLINED (nothing is dropped silently):',
      ...rejected.slice(0, 40).map((r) => `  • ${r}`),
      ...(rejected.length > 40 ? [`  … +${rejected.length - 40} more`] : [])]
    : [];
  if (!seams.length) {
    return [
      'No cross-compartment RESOURCE seams to infer. Common reasons:',
      '  • the compartments share the resource as a bare STRING LITERAL rather than a named',
      '    constant — wiregraph is literal-blind by design; name the constant on both sides;',
      '  • the constant is function-local rather than module/file scope (only shareable,',
      '    module-scope constants are considered);',
      '  • the value does not identify a resource: it needs a path separator, or a name with',
      '    a PATH/FILE/DIR/LOCK/SOCK/PIPE/SHM/TABLE/QUEUE/CACHE/DB/STORE word in it. A version',
      '    string, a model id, an enum member or a URL is not a shared resource;',
      '  • the same constant NAME exists in two compartments with DIFFERENT values, which is',
      '    a shared spelling, not a shared resource;',
      '  • only one compartment references it — a seam needs two.',
      ...tail,
    ].join('\n');
  }
  const lines = [`Found ${seams.length} cross-compartment RESOURCE seam(s):`, ''];
  for (const s of seams) {
    lines.push(`  [resource] ${s.token} = ${JSON.stringify(String(s.value ?? ''))}  (${s.layout})`);
    lines.push(`      compartments: ${s.compartments.join(', ')} — roles UNRESOLVED (each listed as both writer and reader)`);
    // EVIDENCE, not a join key. The IMPORTS edge links `<module>` to `<module>` and no
    // language mints a symbol for a constant, so it says "A's module depends on B's
    // module" — never "A uses B's constant X". The seam was found by the reference scan
    // either way; this line only says the import graph agrees.
    if (s.corroborated?.length) lines.push(`      import-corroborated (supporting evidence, not the join): ${s.corroborated.join(', ')}`);
    for (const o of s.outliers || []) {
      lines.push(`      ⚠ ${o.compartment} defines the same name as ${JSON.stringify(String(o.value))} — a stale/divergent copy, EXCLUDED from this seam`);
    }
  }
  return lines.concat(tail).join('\n');
}

// Human-readable summary of what was found (for the command output).
// `rejected` mirrors formatResourceSeams' tail: the seams this scan deliberately did NOT
// propose, with the reason. The "you already have hand-written contracts, so there is
// nothing left to infer" line below used to be printed WHILE the scan re-proposed all nine
// of them; naming them individually is what makes the claim checkable instead of galling.
// `langFiles` (optional, from extractSignals) turns "no seams proposed" from an
// unanswerable statement into a checkable one: when a compartment is written in a
// language wiregraph has no route/topic rule for, its seams CANNOT be proposed, and that
// is a fact about wiregraph, not about the code. Measured on a Rust-server project: 2 of 5
// real wire seams proposed, one of them one-sided, three absent, and the scan said
// nothing. Printed BEFORE the declined list and in BOTH the empty and non-empty cases —
// "I found two" is exactly as misleading as "I found none" when three more are invisible.
export function formatSeams(seams, rejected = [], langFiles = null) {
  const blind = wireBlindLanguages(langFiles);
  const coverage = blind.length
    ? ['', 'COVERAGE — route/topic detection is LANGUAGE-LIMITED, so this is not a complete list of',
      'your seams. wiregraph reads HTTP routes and message topics from TypeScript/JavaScript and',
      'Python only. These indexed languages have NO route or topic rule, so a route literal in them',
      'produces no candidate at all and can never be proposed or even declined:',
      ...blind.map((b) => `  • ${b.lang}: ${b.files} file(s) in ${b.compartments.join(', ')}`),
      'For those compartments, declare the seam by hand in a *.asyncapi.yaml spec — a hand-written',
      'contract is matched directly and needs no inference.']
    : [];
  const tail = rejected.length
    ? ['', 'Seams considered and NOT proposed (nothing is dropped silently):',
      ...rejected.slice(0, 40).map((r) => `  • ${r}`),
      ...(rejected.length > 40 ? [`  … +${rejected.length - 40} more`] : [])]
    : [];
  if (!seams.length) {
    return [
      'No cross-compartment WIRE seams to infer. That is often expected — common reasons:',
      '  • you already have hand-written contracts: those are matched directly,',
      '    so there is nothing left to infer (see the contract count in /wiregraph-status);',
      '  • comms use a mechanism the scan does not pair yet (dynamic URLs, in-process',
      '    calls), rather than a literal route/topic string shared across compartments;',
      '  • the compartments are coupled through a SHARED RESOURCE (a file/sentinel path, a',
      '    DB table+key, shared memory, a named pipe) rather than a wire — those are',
      '    reported separately below, as RESOURCE seams;',
      '  • the related compartments are not indexed together in one workspace;',
      '  • wiregraph has no route/topic rule for the language that half is written in — the',
      '    COVERAGE note below says so by name when that applies to this workspace.',
      ...coverage,
      ...tail,
    ].join('\n');
  }
  const lines = [`Found ${seams.length} cross-compartment seam(s):`, ''];
  for (const s of seams) {
    const head = s.kind === 'wire'
      ? `  [wire] ${(s.labels.join('/') || 'http').toUpperCase()} ${s.token}`
      : `  [${s.kind}] ${s.token}`;
    lines.push(head);
    const dir = [];
    if (s.inCompartments.length) dir.push(`in: ${s.inCompartments.join(', ')}`);
    if (s.outCompartments.length) dir.push(`out: ${s.outCompartments.join(', ')}`);
    lines.push(`      compartments: ${s.compartments.join(', ')}${dir.length ? ' — ' + dir.join('; ') : ''}`);
    // A seam with only one side is a REFERENCES pair with no WIRE edge — buildWireEdges
    // counts it as a "one-sided token (no wire = gap)". Saying so here, where the user is
    // reading the proposal, is what stops an incomplete proposal from looking complete.
    if (!s.inCompartments.length || !s.outCompartments.length) {
      lines.push(`      ⚠ only the ${s.outCompartments.length ? 'CALLER' : 'HANDLER'} side was recognised, so this channel derives NO WIRE edge until the other half is declared or becomes visible.`);
    }
  }
  return lines.concat(coverage, tail).join('\n');
}
