// THE compartment-declaration rule set. One implementation, shared by BOTH sides.
//
// A project in `recursive` mode DECLARES its compartments in its own state.json
// instead of having them inferred from `.git` / a build manifest:
//
//   { "mode": "recursive", "compartments": [ { "path": "server/ecs", "name": "ecs" } ] }
//
// There are two consumers, and they used to disagree:
//
//   WRITE path — scripts/lib/compartments.mjs `declare` / `validate`, which rejects a
//     bad declaration loudly and writes nothing.
//   READ path  — src/extract/walk.js `findCompartmentRoots`, which is what the BUILD
//     actually partitions on.
//
// state.json is a plain, user-editable, hand-editable file, so the read path sees
// declarations the write path never approved: a hand edit, a merge conflict resolution,
// a directory renamed on disk after a valid declaration was written. When the read path
// applied a WEAKER rule set than the write path, every one of those divergences produced
// a build that SUCCEEDED with a silently wrong partition — duplicate compartment rows,
// get_source resolving to the wrong file, whole compartments vanishing — rather than
// degrading to inference. So the rules live here, once, and BOTH sides call them.
//
// Everything rejected here is a failure that is SILENT once it reaches the graph. The
// verdict is deliberately ALL-OR-NOTHING: a declaration is a PARTITION, and half a
// partition is not a smaller partition, it is a different (wrong) one. Honouring the
// entries that happen to parse while dropping the rest is exactly how an all-junk
// declaration used to collapse a project to a single compartment with no warning.

import { statSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, sep, basename } from 'node:path';
import { IGNORE_DIRS } from './lang.js';

// THE TWO CHARACTERS THE INFERRED PARTITION MINTS INTO A NAME, and the reason a DECLARED
// name may not contain either. When two boundary dirs share a basename,
// disambiguateInferredNames (src/extract/walk.js) renames the colliding ones to their path
// relative to the walked root — `network` becomes `client/network` + `server/network` — and
// uniquifies a degenerate leftover as `<base>#2`. Those names are MACHINE-MINTED and
// deliberately outside the namespace a human may declare, which is what lets
// src/store/sqlite-query.js#disambiguatedCompartments recover "this compartment was
// auto-renamed" FROM THE GRAPH ALONE, with no extra state to keep in sync: a name carrying
// one of these characters is an auto-renamed name, in either mode. Let a declaration spell
// one and graph_status reports a name the user chose as a collision that never happened,
// and find_symbol's bare-name hint offers a bare name nothing was ever renamed from.
//
// walk.js builds its names FROM THESE CONSTANTS, so the reserved set and the set actually
// minted cannot drift: a third marker character has to be added here to be usable there,
// and adding it here is what makes declarations reject it.
export const INFERRED_PATH_SEP = '/';
export const INFERRED_UNIQ_SEP = '#';
export const DISAMBIGUATION_CHARS = [INFERRED_PATH_SEP, INFERRED_UNIQ_SEP];

// A compartment NAME is embedded verbatim in every id — `compartment:<name>`,
// `file:<name>:<relPath>`, `sym:<name>:<relPath>:...` — so a name carrying the id
// separator `:` would make two different nodes spell the same id (compartment `a:b` with
// relPath `c.js`, and compartment `a` with relPath `b:c.js` — a `:` in a filename is legal
// on every platform wiregraph indexes — are both `file:a:b:c.js`). `\` is rejected beside
// it as the same separator's Windows-path twin. CONTROL CHARACTERS are
// rejected for the same class of reason one level up: the declaration fingerprint and
// several report lines join names with separators, and a name free to contain any byte
// can forge a join boundary (a name holding a raw U+0001 made a two-compartment declaration hash
// identically to a one-compartment one, so a real partition change escaped detection).
//
// `/` AND `#` ARE REJECTED FOR A DIFFERENT REASON — the paragraph above is not true of
// them, and the rejection message must not claim it is. Neither can forge an id: ids join
// on `:`, and `file:server/network:x.rs` has exactly one reading. Neither can forge a
// fingerprint boundary either, because partitionValue (scripts/lib/state.mjs) JSON-encodes
// every component before hashing it. They are rejected because they are RESERVED for the
// auto-disambiguated names described above — that namespace split is the entire mechanism
// by which an auto-renamed compartment stays recognizable from the graph alone.
const NAME_BAD_CHARS = new RegExp(`[:\\\\${DISAMBIGUATION_CHARS.join('')}]|[\\u0000-\\u001f\\u007f]`);

// Normalize a declared path to the stored form: relative to the project root, with
// no `./` prefix and no trailing separator. The project root itself is stored as '.'.
// Purely LEXICAL — never realpath. See the SYMLINK HAZARD note in walk.js: the walk
// prefix-matches raw absolute strings built by join()ing down from the walked root, so a
// realpath here would make every prefix match fail whenever the root is reached through
// a symlink, collapsing the whole partition with no error.
export function normalizeDeclaredPath(project, raw) {
  const rel = relative(project, resolve(project, raw));
  return rel === '' ? '.' : rel;
}

// The first path COMPONENT below `project` that is itself a symlink, or null.
//
// Why this is a rejection and not a curiosity: `statSync` FOLLOWS symlinks, so a
// symlink-to-a-directory passes an "is it a directory?" test — but the walk asks
// `Dirent.isDirectory()`, which is FALSE for a symlink-to-dir, so walkOneRoot never
// descends into one. A symlinked declared root therefore validated clean and produced a
// permanently EMPTY compartment: the same outcome as the IGNORE_DIRS case, from a
// different cause, so it gets the same verdict. It also defeats the "outside the project
// root" rejection, which is purely lexical on the stored relative path and cannot see
// that `linked/` resolves to /elsewhere.
//
// Deliberately NOT applied to `project` itself or to any ancestor of it: the walked root
// is very often reached through a symlink (a linked member, /tmp on some platforms), and
// that is both supported and tested. Only components BELOW the root matter, because only
// those are ones the walk has to descend through.
//
// Deliberately NOT applied to detectContractsDirs (src/contracts-dirs.js), which follows
// a symlink-to-dir ON PURPOSE — a contracts dir is READ from directly, never walked into
// by Dirent, so the hazard does not exist there.
function symlinkedComponent(project, relPath) {
  if (relPath === '.') return null;
  let cur = project;
  for (const seg of relPath.split(sep)) {
    cur = join(cur, seg);
    let st;
    try { st = lstatSync(cur); } catch { return null; } // missing — the existence check reports it
    if (st.isSymbolicLink()) return relative(project, cur);
  }
  return null;
}

// Validate a declaration against the project ON DISK. Returns
// { ok, errors: [string], compartments: [{path, name}] } — `compartments` is the
// NORMALIZED list, meaningful ONLY when ok. When !ok the declaration is UNUSABLE as a
// whole; callers must not honour the partial list (see the all-or-nothing note above).
export function validateDeclaration(project, list) {
  const errors = [];
  if (!Array.isArray(list)) {
    return { ok: false, errors: ['compartments must be a JSON array of { "path": ..., "name": ... } objects'], compartments: [] };
  }

  const out = [];
  const byPath = new Map();
  for (const [i, raw] of list.entries()) {
    const at = `entry ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${at}: must be an object with "path" and "name"`); continue; }
    const { path: rawPath, name: rawName } = raw;
    if (typeof rawPath !== 'string' || !rawPath.trim()) { errors.push(`${at}: "path" must be a non-empty string`); continue; }
    if (typeof rawName !== 'string' || !rawName.trim()) { errors.push(`${at}: "name" must be a non-empty string`); continue; }
    const name = rawName.trim();
    // TWO REASONS, NAMED SEPARATELY. This message used to blame the id separator for all
    // of them, which is false for '/' and '#' — and it left the author of a colliding
    // project with no legal spelling in sight, because the collision warning PRINTS
    // `server/network` and then this line rejected the very name it printed, citing a
    // reason the author could check and find untrue.
    if (NAME_BAD_CHARS.test(name)) {
      errors.push(`${at}: name "${name}" contains ':', '/', '#', '\\' or a control character. ':', '\\' and control characters are id and fingerprint separators, so such a name would let two different partitions spell the same id; '/' and '#' are RESERVED for the names wiregraph mints ITSELF when the inferred partition disambiguates a basename collision (\`client/network\`, \`network#2\`), so a declared name carrying one could not be told apart from an auto-renamed one. Declare a plain name instead — e.g. "server_network" for the compartment at server/network.`);
      continue;
    }

    // 4. Outside the project root. Absolute paths are rejected outright: loadState
    //    rebinds state.project to the directory it read from on a rename/move, so an
    //    absolute declared path dangles after a rename and every file silently reverts
    //    to the root compartment.
    if (isAbsolute(rawPath)) {
      errors.push(`${at}: path "${rawPath}" is absolute — declared paths must be RELATIVE to the project root, or a rename/move of the project silently collapses the whole partition`);
      continue;
    }
    const path = normalizeDeclaredPath(project, rawPath);
    if (path === '..' || path.startsWith('..' + sep)) {
      errors.push(`${at}: path "${rawPath}" resolves outside the project root (${project})`);
      continue;
    }

    // 2. Under an IGNORE_DIRS segment — the walk never descends there, so the
    //    compartment would exist in the declaration and hold zero files forever.
    const ignored = path.split(sep).find((seg) => IGNORE_DIRS.has(seg));
    if (ignored) {
      errors.push(`${at}: path "${path}" lies under "${ignored}", which wiregraph never walks (IGNORE_DIRS) — the compartment would always be empty`);
      continue;
    }

    // 3. Does not exist / is not a directory. Checked on EVERY read, not only at
    //    declare time: renaming or deleting a declared source directory is ordinary
    //    work, and it re-partitions the graph exactly as editing the declaration does.
    const abs = resolve(project, path);
    let st = null;
    try { st = statSync(abs); } catch { /* reported below */ }
    if (!st) { errors.push(`${at}: path "${path}" does not exist under ${project}`); continue; }
    if (!st.isDirectory()) { errors.push(`${at}: path "${path}" is not a directory`); continue; }

    // 3b. Reached through a symlink — accepted by statSync, never walked by Dirent.
    const link = symlinkedComponent(project, path);
    if (link) {
      errors.push(`${at}: path "${path}" is reached through a symlink ("${link}") — the walk tests Dirent.isDirectory(), which is FALSE for a symlink-to-directory, so it never descends there and the compartment would always be empty (and a symlink can point outside the project entirely, which the relative-path check cannot see). Declare the real directory instead.`);
      continue;
    }

    const prior = byPath.get(path);
    if (prior) { errors.push(`${at}: path "${path}" is declared twice (as "${prior}" and "${name}")`); continue; }
    byPath.set(path, name);
    out.push({ path, name });
  }

  // 1. BASENAME/NAME COLLISION — the one that corrupts data rather than merely losing
  //    it. compartmentId is name-only, so two compartments sharing a name collapse into
  //    ONE row via INSERT OR REPLACE, keeping whichever `root` landed last; relPaths
  //    computed against the OTHER root then resolve under it and get_source reads the
  //    WRONG FILE. canLink guards this ACROSS members; nothing guarded it WITHIN a root.
  //
  //    The ROOT FALLBACK counts as a compartment here: any file under no declared root
  //    attributes to basename(project) with the project root as its root (walk.js
  //    compartmentNameFor), so a declared name equal to the project's basename collides
  //    exactly the same way — unless that declaration IS the project root ('.'), in
  //    which case there is only one root and the fallback is unreachable.
  const claims = new Map(); // name -> Set(dir)
  const claim = (name, dir) => {
    if (!claims.has(name)) claims.set(name, new Set());
    claims.get(name).add(dir);
  };
  for (const c of out) claim(c.name, resolve(project, c.path));
  claim(basename(project), project);
  for (const [name, dirs] of claims) {
    if (dirs.size < 2) continue;
    const where = [...dirs].map((d) => (d === project ? '. (the project root, the fallback compartment for every undeclared file)' : relative(project, d))).sort();
    errors.push(`compartment name "${name}" is claimed by ${dirs.size} different roots (${where.join(', ')}) — compartment ids are name-only, so these would collapse into one row and get_source would read the wrong file. Give them distinct names.`);
  }

  return { ok: errors.length === 0, errors, compartments: out };
}
