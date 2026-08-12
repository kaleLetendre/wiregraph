// tree-sitter parsing + per-language rules for what counts as a definition and
// what counts as a call. The traversal maintains an enclosing-definition stack
// so each call is attributed to the function/method it physically sits inside
// (or the file's synthetic <module> symbol for top-level calls).

import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import CMod from 'tree-sitter-c';
import PyMod from 'tree-sitter-python';
import JavaMod from 'tree-sitter-java';
import KotlinMod from '@tree-sitter-grammars/tree-sitter-kotlin';
import RustMod from 'tree-sitter-rust';

const C_LANG = CMod.default || CMod;
const PY_LANG = PyMod.default || PyMod;
const JAVA_LANG = JavaMod.default || JavaMod;
const KOTLIN_LANG = KotlinMod.default || KotlinMod;
const RUST_LANG = RustMod.default || RustMod;

const parsers = {};
function parserFor(variant) {
  if (parsers[variant]) return parsers[variant];
  const p = new Parser();
  if (variant === 'tsx') p.setLanguage(TS.tsx);
  else if (variant === 'typescript') p.setLanguage(TS.typescript);
  else if (variant === 'c') p.setLanguage(C_LANG);
  else if (variant === 'python') p.setLanguage(PY_LANG);
  else if (variant === 'java') p.setLanguage(JAVA_LANG);
  else if (variant === 'kotlin') p.setLanguage(KOTLIN_LANG);
  else if (variant === 'rust') p.setLanguage(RUST_LANG);
  else throw new Error(`unknown grammar variant: ${variant}`);
  parsers[variant] = p;
  return p;
}

function field(node, name) {
  return node.childForFieldName ? node.childForFieldName(name) : null;
}

// --- TypeScript / JavaScript rules ------------------------------------------

function tsDef(node) {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'function' } : null;
    }
    case 'method_definition': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'method' } : null;
    }
    case 'class_declaration': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'class' } : null;
    }
    case 'variable_declarator':
    case 'public_field_definition': {
      const val = field(node, 'value');
      if (val && (val.type === 'arrow_function' || val.type === 'function' ||
                  val.type === 'function_expression')) {
        const n = field(node, 'name');
        return n ? { name: n.text, kind: 'function' } : null;
      }
      return null;
    }
    default:
      return null;
  }
}

function tsCall(node) {
  if (node.type === 'call_expression') {
    const fn = field(node, 'function');
    if (!fn) return null;
    if (fn.type === 'identifier') return fn.text;
    if (fn.type === 'member_expression') {
      const prop = field(fn, 'property');
      return prop ? prop.text : null;
    }
    return null;
  }
  if (node.type === 'new_expression') {
    const ctor = field(node, 'constructor');
    if (ctor && ctor.type === 'identifier') return ctor.text;
    return null;
  }
  return null;
}

// --- C rules ----------------------------------------------------------------

function unwrapCName(declNode) {
  let n = declNode;
  while (n) {
    if (n.type === 'function_declarator') {
      const d = field(n, 'declarator');
      if (!d) return null;
      if (d.type === 'identifier') return d.text;
      return unwrapCName(d);
    }
    if (n.type === 'pointer_declarator' || n.type === 'parenthesized_declarator') {
      n = field(n, 'declarator');
      continue;
    }
    if (n.type === 'identifier') return n.text;
    return null;
  }
  return null;
}

function cDef(node) {
  if (node.type === 'function_definition') {
    const name = unwrapCName(field(node, 'declarator'));
    return name ? { name, kind: 'function' } : null;
  }
  return null;
}

function cCall(node) {
  if (node.type === 'call_expression') {
    const fn = field(node, 'function');
    if (!fn) return null;
    if (fn.type === 'identifier') return fn.text;
    if (fn.type === 'field_expression') {
      const f = field(fn, 'field');
      return f ? f.text : null;
    }
    return null;
  }
  return null;
}

// --- Python rules -----------------------------------------------------------

// A function_definition is a method when its nearest enclosing scope is a class
// body (climbing past an optional decorator wrapper); otherwise it's a function.
function pyEnclosingIsClass(node) {
  let p = node.parent;
  if (p && p.type === 'decorated_definition') p = p.parent;
  return !!(p && p.type === 'block' && p.parent && p.parent.type === 'class_definition');
}

function pyDef(node) {
  switch (node.type) {
    case 'function_definition': {
      const n = field(node, 'name');
      if (!n) return null;
      return { name: n.text, kind: pyEnclosingIsClass(node) ? 'method' : 'function' };
    }
    case 'class_definition': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'class' } : null;
    }
    default:
      return null;
  }
}

function pyCall(node) {
  if (node.type !== 'call') return null;
  const fn = field(node, 'function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;       // foo()
  if (fn.type === 'attribute') {                       // obj.method() -> method
    const attr = field(fn, 'attribute');
    return attr ? attr.text : null;
  }
  return null;
}

// --- Java rules -------------------------------------------------------------

function javaDef(node) {
  switch (node.type) {
    case 'class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
    case 'record_declaration': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'class' } : null;
    }
    case 'method_declaration': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'method' } : null;
    }
    case 'constructor_declaration': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'constructor' } : null;
    }
    default:
      return null;
  }
}

function javaCall(node) {
  if (node.type === 'method_invocation') {           // foo() / obj.foo()
    const n = field(node, 'name');
    return n ? n.text : null;
  }
  if (node.type === 'object_creation_expression') {  // new Foo<Bar>() -> Foo
    const t = field(node, 'type');
    if (!t) return null;
    return t.text.replace(/<[\s\S]*$/, '').split('.').pop().trim() || null;
  }
  return null;
}

// --- Kotlin rules -----------------------------------------------------------

// A function_declaration is a method when it sits directly in a class/object body.
function ktEnclosingIsClass(node) {
  return !!(node.parent && node.parent.type === 'class_body');
}

function ktDef(node) {
  switch (node.type) {
    case 'class_declaration':
    case 'object_declaration': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'class' } : null;
    }
    case 'function_declaration': {
      const n = field(node, 'name');
      if (!n) return null;
      return { name: n.text, kind: ktEnclosingIsClass(node) ? 'method' : 'function' };
    }
    default:
      return null;
  }
}

// Kotlin call_expression has no name field: the callee is its first child — a bare
// identifier (foo() / Service()), or a navigation_expression (s.handle()) whose
// last identifier is the member being called.
function ktCall(node) {
  if (node.type !== 'call_expression') return null;
  const callee = node.namedChild(0);
  if (!callee) return null;
  if (callee.type === 'identifier' || callee.type === 'simple_identifier') return callee.text;
  if (callee.type === 'navigation_expression') {
    let name = null;
    for (let i = 0; i < callee.namedChildCount; i++) {
      const c = callee.namedChild(i);
      if (c.type === 'identifier' || c.type === 'simple_identifier') name = c.text;
    }
    return name;
  }
  return null;
}

// --- Rust rules -------------------------------------------------------------

// A `function_item` is a METHOD when it sits in the declaration_list of an `impl` block
// (inherent OR trait impl — the grammar shape is identical, `impl_item` with an extra
// `trait:` field) or of a `trait` (a default method body). Everything else — file scope,
// or a `mod`'s declaration_list — is a free function. Same shape as pyEnclosingIsClass /
// ktEnclosingIsClass, which also key on the immediately-enclosing body node.
function rustEnclosingIsImpl(node) {
  const p = node.parent;
  if (!p || p.type !== 'declaration_list') return false;
  const g = p.parent;
  return !!(g && (g.type === 'impl_item' || g.type === 'trait_item'));
}

// struct/enum/union/trait/mod all map to kind 'class' — the existing CONTAINER kind, and
// exactly what javaDef does with interface/enum/record and ktDef with `object`. `mod`
// specifically must NOT be kind 'module': that kind is reserved for the synthetic
// per-file `<module>` symbol, and every consumer filters it out (resolve.js's def index,
// find_symbol's default, the symbol counts), so a `mod` tagged that way would be indexed
// and then invisible. A trait's `function_signature_item` (a bodiless declaration) is
// deliberately NOT a symbol — there is nothing to get_source and the impls carry the code.
function rustDef(node) {
  switch (node.type) {
    case 'struct_item':
    case 'enum_item':
    case 'union_item':
    case 'trait_item':
    case 'mod_item': {
      const n = field(node, 'name');
      return n ? { name: n.text, kind: 'class' } : null;
    }
    case 'function_item': {
      const n = field(node, 'name');
      if (!n) return null;
      return { name: n.text, kind: rustEnclosingIsImpl(node) ? 'method' : 'function' };
    }
    default:
      return null;
  }
}

// Rust callee shapes, all reduced to the LAST path segment — the same name resolveCalls
// indexes DEFINITIONS under, and the same choice every other language makes (tsCall's
// member `property`, cCall's `field`, javaCall's `name`, ktCall's last navigation
// identifier):
//   foo()          identifier         -> "foo"
//   module::foo()  scoped_identifier  -> "foo"  (the `name` field; the `path` is a
//   Type::new()    scoped_identifier  -> "new"   MODULE or TYPE namespace, not a callee,
//                                                and resolution is name-based anyway)
//   x.method()     field_expression   -> "method"
//   foo::<T>()     generic_function   -> unwrap to its `function` and recurse
// A parenthesized/closure/index callee (`(f)()`, `fs[0]()`) yields null: there is no
// name to resolve, exactly as tsCall returns null for a non-identifier callee.
function rustCallee(fn) {
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'scoped_identifier') return field(fn, 'name')?.text || null;
  if (fn.type === 'field_expression') return field(fn, 'field')?.text || null;
  if (fn.type === 'generic_function') return rustCallee(field(fn, 'function'));
  return null;
}

function rustCall(node) {
  if (node.type !== 'call_expression') return null;
  return rustCallee(field(node, 'function'));
}

// --- HTTP route detection (for contract inference) --------------------------
// Recognizes server route DEFINITIONS and client route CALLS so wiregraph can
// infer cross-service wire contracts from code. Returns { method, path, side }
// where side is 'server' | 'client' | 'unknown'. Requiring a leading-'/' path
// (after stripping scheme+host from a full URL) filters out the bulk of non-route
// .get()/.post() calls (e.g. map.get('x')). Direction (side) is a best-effort
// guess from the receiver name; the shared PATH is the real cross-repo seam, so
// an 'unknown' side is still recorded and the inference step resolves direction.

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const NEST_VERBS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All']);
const PY_SERVER_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'route']);
const SERVER_OBJECTS = new Set(['app', 'router', 'server', 'route', 'routes', 'fastify', 'express', 'bp', 'blueprint', 'api', 'ns']);
const CLIENT_OBJECTS = new Set(['axios', 'http', 'https', 'client', 'request', 'requests', 'httpx', 'session', 'got', 'ky', 'superagent']);

// Inner value of a plain string / template literal (one layer of quotes stripped);
// null if the node isn't a simple string literal.
function strLiteral(node) {
  if (!node) return null;
  const t = node.type;
  if (t === 'string' || t === 'template_string' || t === 'string_literal') {
    let s = node.text;
    if (s.length >= 2 && /^[`'"]/.test(s)) s = s.slice(1, -1);
    return s;
  }
  return null;
}

// Normalize a candidate to a route path: strip scheme+host from a full URL, drop
// query/hash, require a leading '/'. Returns null if it isn't path-shaped.
function routePath(s) {
  if (!s) return null;
  const url = /^https?:\/\/[^/]+(\/[^\s?#]*)/.exec(s);
  if (url) return url[1];
  if (s.startsWith('/')) return s.split(/[?#]/)[0];
  return null;
}

// First positional argument node of a call (TS 'arguments' / Py 'argument_list').
function firstArg(node) {
  const args = field(node, 'arguments');
  return args ? args.namedChild(0) : null;
}

// Receiver identifier of a member/attribute access (last segment), else null.
function receiverName(objNode) {
  if (!objNode) return null;
  if (objNode.type === 'identifier') return objNode.text;
  if (objNode.type === 'member_expression') return field(objNode, 'property')?.text || null;
  if (objNode.type === 'attribute') return field(objNode, 'attribute')?.text || null;
  return null;
}

function sideFor(obj) {
  if (SERVER_OBJECTS.has(obj)) return 'server';
  if (CLIENT_OBJECTS.has(obj)) return 'client';
  return 'unknown';
}

function tsRoute(node) {
  if (node.type !== 'call_expression') return null;
  const fn = field(node, 'function');
  if (!fn) return null;
  const path = routePath(strLiteral(firstArg(node)));
  if (!path) return null;
  if (fn.type === 'identifier') {
    if (fn.text === 'fetch') return { method: 'get', path, side: 'client' };       // fetch('/x')
    if (NEST_VERBS.has(fn.text) && node.parent && node.parent.type === 'decorator') // @Get('/x')
      return { method: fn.text.toLowerCase(), path, side: 'server' };
    return null;
  }
  if (fn.type === 'member_expression') {                                            // app.get / axios.get
    const verb = (field(fn, 'property')?.text || '').toLowerCase();
    if (!HTTP_VERBS.has(verb)) return null;
    return { method: verb, path, side: sideFor(receiverName(field(fn, 'object'))) };
  }
  return null;
}

function pyRoute(node) {
  if (node.type !== 'call') return null;
  const fn = field(node, 'function');
  if (!fn || fn.type !== 'attribute') return null;                                  // @app.get / requests.get
  const path = routePath(strLiteral(firstArg(node)));
  if (!path) return null;
  const verb = (field(fn, 'attribute')?.text || '').toLowerCase();
  const obj = receiverName(field(fn, 'object'));
  const method = verb === 'route' ? 'get' : verb;                                   // Flask @app.route default
  if (PY_SERVER_VERBS.has(verb)) {
    return { method, path, side: CLIENT_OBJECTS.has(obj) ? 'client' : SERVER_OBJECTS.has(obj) ? 'server' : 'unknown' };
  }
  if (HTTP_VERBS.has(verb)) return { method, path, side: sideFor(obj) };
  return null;
}

// --- messaging / event detection --------------------------------------------
// Pub/sub call sites whose first string-literal arg is the topic/queue/event.
// The method name gives direction: publish/emit/send = out (producer),
// subscribe/on/consume = in (consumer). Topic distinctiveness is filtered later
// (in the inference step) so this stays a cheap syntactic match.
const PRODUCE_METHODS = new Set(['publish', 'emit', 'send', 'produce', 'basicpublish', 'sendtoqueue', 'dispatch', 'xadd']);
const CONSUME_METHODS = new Set(['subscribe', 'on', 'consume', 'basicconsume', 'addlistener', 'xread']);
function msgRole(method) {
  const m = String(method || '').toLowerCase().replace(/_/g, '');
  if (PRODUCE_METHODS.has(m)) return 'out';
  if (CONSUME_METHODS.has(m)) return 'in';
  return null;
}
function memberMessage(node, method) {
  const role = msgRole(method);
  if (!role) return null;
  const topic = strLiteral(firstArg(node));
  if (!topic || topic.length < 3 || /\s/.test(topic)) return null;
  return { kind: 'message', token: topic, role, label: String(method).toLowerCase() };
}
function tsMessage(node) {
  if (node.type !== 'call_expression') return null;
  const fn = field(node, 'function');
  if (!fn || fn.type !== 'member_expression') return null;
  return memberMessage(node, field(fn, 'property')?.text);
}
function pyMessage(node) {
  if (node.type !== 'call') return null;
  const fn = field(node, 'function');
  if (!fn || fn.type !== 'attribute') return null;
  return memberMessage(node, field(fn, 'attribute')?.text);
}

// Per-language signal rule: a node yields at most one contract candidate
// { kind, token, role, label } — an HTTP route ('wire') or a message topic
// ('message'). role is normalized to 'in' (server/consumer) | 'out'
// (client/producer) | 'unknown' so the inference step is kind-agnostic.
function wireCandidate(r) {
  return { kind: 'wire', token: r.path, label: r.method,
    role: r.side === 'server' ? 'in' : r.side === 'client' ? 'out' : 'unknown' };
}
// --- shared-state detection (env vars) --------------------------------------
// An env var read in 2+ repos is a shared-config contract (renaming the var
// breaks every reader). Scoped to env-access syntax (high signal) and filtered
// against ubiquitous names so common vars don't become bogus seams. (DB tables /
// config keys are deferred — too noisy without ORM/SQL context.)
const STATE_STOP = new Set([
  'NODE_ENV', 'PORT', 'HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'LANG', 'TERM', 'TZ',
  'CI', 'DEBUG', 'NODE_OPTIONS', 'HOSTNAME', 'TMPDIR', 'EDITOR', 'LOGNAME', 'SHLVL',
  'OLDPWD', 'DISPLAY',
]);
function stateCandidate(name) {
  if (!name || STATE_STOP.has(name)) return null;
  return { kind: 'state', token: name, role: 'unknown', label: 'env' };
}
// TS: object is `process.env` or `import.meta.env`.
function isTsEnvObject(n) {
  if (!n || n.type !== 'member_expression') return false;
  if (field(n, 'property')?.text !== 'env') return false;
  const o = field(n, 'object');
  if (!o) return false;
  if (o.type === 'identifier') return o.text === 'process';                           // process.env
  if (o.type === 'meta_property') return o.text === 'import.meta';                     // import.meta.env
  if (o.type === 'member_expression') return field(o, 'property')?.text === 'meta';    // defensive fallback
  return false;
}
function tsState(node) {
  if (node.type === 'member_expression' && isTsEnvObject(field(node, 'object'))) {
    return stateCandidate(field(node, 'property')?.text);                 // process.env.NAME
  }
  if (node.type === 'subscript_expression' && isTsEnvObject(field(node, 'object'))) {
    return stateCandidate(strLiteral(field(node, 'index')));              // process.env['NAME']
  }
  return null;
}
function pyState(node) {
  if (node.type === 'subscript') {                                       // os.environ['NAME']
    const val = field(node, 'value');
    if (val?.type === 'attribute' && field(val, 'attribute')?.text === 'environ') {
      return stateCandidate(strLiteral(field(node, 'subscript')));
    }
    return null;
  }
  if (node.type === 'call') {
    const fn = field(node, 'function');
    if (fn?.type === 'attribute') {
      const method = field(fn, 'attribute')?.text;
      if (method === 'getenv') return stateCandidate(strLiteral(firstArg(node)));         // os.getenv('NAME')
      if (method === 'get' && field(fn, 'object')?.type === 'attribute'
          && field(field(fn, 'object'), 'attribute')?.text === 'environ') {
        return stateCandidate(strLiteral(firstArg(node)));                                 // os.environ.get('NAME')
      }
    }
    if (fn?.type === 'identifier' && fn.text === 'getenv') return stateCandidate(strLiteral(firstArg(node)));
  }
  return null;
}
function cState(node) {                                                  // getenv("NAME")
  if (node.type !== 'call_expression') return null;
  const fn = field(node, 'function');
  if (fn?.type === 'identifier' && fn.text === 'getenv') return stateCandidate(strLiteral(firstArg(node)));
  return null;
}

// --- import detection (library/SDK boundaries) ------------------------------
// The specifier of an import/require/#include. Cross-repo resolution happens in
// src/contracts/imports.js (it needs the whole workspace + each repo's package
// name); here we just emit the raw specifier tagged kind:'import'.
function tsImport(node) {
  if (node.type === 'import_statement') {
    const src = strLiteral(field(node, 'source'));
    return src ? { kind: 'import', token: src, role: 'out', label: 'import' } : null;
  }
  if (node.type === 'call_expression') {
    const fn = field(node, 'function');
    if (fn?.type === 'identifier' && fn.text === 'require') {
      const src = strLiteral(firstArg(node));
      if (src) return { kind: 'import', token: src, role: 'out', label: 'require' };
    }
  }
  return null;
}
function cImport(node) {
  if (node.type === 'preproc_include') {
    const path = field(node, 'path');
    if (path?.type === 'string_literal') {            // "foo.h" (local), not <foo.h> (system)
      let s = path.text;
      if (s.length >= 2) s = s.slice(1, -1);
      return s ? { kind: 'import', token: s, role: 'out', label: 'include' } : null;
    }
  }
  return null;
}

// --- named string constants (resource-seam inference) -----------------------
// A resource contract's join key is a shared CONSTANT NAME (see the resource-spec
// format: tokens are names, never paths). For the VENDORED-COPY layout — each
// compartment carries its own copy of the constants module, so there is no
// cross-compartment IMPORTS edge to resolve through — the name alone would fuse
// unrelated constants that merely share a common name (DATA_DIR), so the join also
// needs the VALUE. A 'const' candidate therefore carries both: `name` (also mirrored
// into `token`, which is what the generic contract machinery matches on) and
// `value`, the literal it is bound to.
//
// Only STRING-valued constants are emitted — a number or boolean cannot be a
// resource identifier. Clustering these into seams is the inference step's job
// (src/contracts/infer.js), not this module's; here we only extract.

const MAX_CONST_VALUE = 512; // an embedded blob/SQL/base64 is not a resource identifier

// The literal text of a plain string node with its delimiters stripped. Stricter
// than strLiteral, which exists to read a call argument and assumes a well-formed
// one-char quote: this must also REJECT a prefixed literal (Python f"…"/r"…"/b"…",
// C L"…"/u8"…") whose value is not a fixed string, and strip a Python triple quote
// by the right amount. Returns null when the node is not a plain string literal.
function constString(node) {
  if (!node) return null;
  const t = node.type;
  if (t !== 'string' && t !== 'template_string' && t !== 'string_literal') return null;
  const raw = node.text;
  // Python exposes explicit delimiter nodes; use them so `f"`/`r"`/`b"` are rejected
  // and `"""` is stripped three chars, not one.
  const start = node.child(0), end = node.child(node.childCount - 1);
  if (start && start.type === 'string_start' && end && end.type === 'string_end') {
    if (!/^[`'"]+$/.test(start.text)) return null;
    return raw.slice(start.text.length, raw.length - end.text.length);
  }
  if (!/^[`'"]/.test(raw)) return null;                 // L"x", u8"x", a Java text block, …
  return strLiteral(node);
}

// --- the VALUE is source text, and every test on it must run on the real string ---
//
// constString hands back the SOURCE SLICE between the quotes, escapes and all. Every
// consumer downstream (the resource-value shape rule, the vendored name+value join, the
// value printed into the draft) then tests a string that is not the one the program
// holds at runtime, and the failures are not theoretical — all four were measured:
//
//   * `'Run\tthe\tthing.'` has no literal whitespace in its SOURCE, so a "no whitespace
//     in a resource id" test passes prose;
//   * `'/Users/me/Library/Application Support/Acme/state.json'` is a genuine path that
//     the same test rejects — and macOS/Windows paths and quoted DB identifiers with
//     spaces are then invisible BY CONSTRUCTION;
//   * `'/var/run/café.json'` written NFC in one compartment and NFD in the other are two
//     different strings, so the vendored join sees two values and drops the seam;
//   * a template literal `` `${BASE}/state.json` `` is not a constant at all — two
//     compartments with DIFFERENT `BASE` share its SOURCE text and would join on it.
//
// So: decode escapes, NFC-normalise, and refuse an interpolated literal outright. The
// escape table is the intersection of JS/Python/C/Java/Kotlin/Rust — the six indexed
// languages agree on everything here except the exotic tails (Python `\N{…}`, C octal),
// which decode to themselves and are not resource identifiers anyway.
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', a: '\x07' };
export function decodeConstValue(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.includes('${')) return null;   // interpolation — not a constant value
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= raw.length) { out += ch; continue; }
    const e = raw[++i];
    if (e === 'x' || (e === 'u' && raw[i + 1] !== '{')) {
      const n = e === 'x' ? 2 : 4;
      const hex = raw.slice(i + 1, i + 1 + n);
      if (hex.length === n && /^[0-9a-fA-F]+$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += n; continue; }
      out += e; continue;
    }
    if (e === 'u' && raw[i + 1] === '{') {
      const close = raw.indexOf('}', i + 2);
      const hex = close > 0 ? raw.slice(i + 2, close) : '';
      if (hex && /^[0-9a-fA-F]+$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i = close; continue; }
      out += e; continue;
    }
    out += (e in ESCAPES) ? ESCAPES[e] : e;   // \\ \' \" \` \/ and anything unknown
  }
  return out.normalize('NFC');
}

// A const candidate. `value` is the DECODED literal, or NULL meaning "a definition of
// this name is present here, but its value is not a plain string" — an env-var fallback,
// a concatenation, an interpolated template, a `let`/`var` rebinding. That distinction is
// load-bearing for inference: `values` used to hold only EXTRACTED definitions, so a
// compartment whose copy of the constant was computed rather than literal produced NO
// candidate at all and was then treated as a pure USER of somebody else's value —
// joining a seam on a path it does not use. A value-unknown definition is exactly the
// evidence needed to exclude it. `nameStart`/`nameEnd` are the declared NAME node's
// offsets, which is what the definition-site exclusion keys on (see constDefIndex).
function constCandidate(name, value, nameNode) {
  if (!name) return null;
  const v = value == null ? null : decodeConstValue(value);
  const usable = v != null && v.length > 0 && v.length <= MAX_CONST_VALUE;
  const rec = {
    kind: 'const', token: name, name, value: usable ? v : null,
    role: 'unknown', label: 'const',
  };
  if (nameNode) { rec.nameStart = nameNode.startIndex; rec.nameEnd = nameNode.endIndex; }
  return rec;
}

// TS/JS: `const X = "…"` / `export const X = "…"` (an `export` wraps the SAME
// lexical_declaration, so no extra case). Matched at the variable_declarator so a
// multi-declarator line yields one candidate each; `let`/`var` are not constants.
// tsDef also inspects variable_declarator — for a FUNCTION initialiser — and the two
// are disjoint by construction: a function value is never a string literal.
// MODULE SCOPE is required, mirroring pyConst's parent-chain guard. A function-local
// `const` is not something another compartment can share, and it is a measured
// false-positive source rather than a theoretical one: in wiregraph's own src/, 19 of
// the 24 const candidates the unrestricted rule emitted were locals, and a local named
// `key` with an IDENTICAL value appeared in export-gexf.js and export-html.js — which
// is exactly the "same name, same value, two compartments" signature the vendored-copy
// resource join keys on. The filter lives HERE rather than in the clusterer so every
// consumer (inference, the build path, any future one) sees the same restriction, and
// so the cost of the locals is never paid at all.
//
// `let` / `var` at module scope are NOT constants and never carry a value here — but they
// are still a DEFINITION of the name in this compartment, and inference has to know that:
// a compartment that rebinds the name is not a passive user of somebody else's value.
// They are therefore emitted with `value: null`, the same "definition present, value
// unknown" record a non-literal initialiser produces.
function tsConst(node) {
  if (node.type !== 'variable_declarator') return null;
  const decl = node.parent;
  if (!decl) return null;
  const isLexical = decl.type === 'lexical_declaration';
  if (!isLexical && decl.type !== 'variable_declaration') return null;   // `var`
  const isConst = isLexical && field(decl, 'kind')?.text === 'const';
  // `export const X = …` wraps the SAME lexical_declaration in an export_statement, so
  // unwrap those (a re-export chain is still module scope); anything else — a
  // statement_block, a class body, an arrow body — is not.
  let p = decl.parent;
  while (p?.type === 'export_statement') p = p.parent;
  if (p?.type !== 'program') return null;
  const nameNode = field(node, 'name');
  if (nameNode?.type !== 'identifier') return null;                      // destructuring pattern
  return constCandidate(nameNode.text, isConst ? constString(field(node, 'value')) : null, nameNode);
}

// Python: MODULE-LEVEL `X = "…"` only. Python has no const keyword, so scope is the
// only signal: a name bound inside a function body is a local, and a class-body
// binding is an attribute — neither is a shared constant. module -> expression_statement
// -> assignment is exactly module scope (a nested one sits under a `block`).
function pyConst(node) {
  if (node.type !== 'assignment') return null;
  const st = node.parent;
  if (!st || st.type !== 'expression_statement' || st.parent?.type !== 'module') return null;
  const left = field(node, 'left');
  if (!left || left.type !== 'identifier') return null;                 // skip tuple/subscript targets
  return constCandidate(left.text, constString(field(node, 'right')), left);
}

// C declarator name: like unwrapCName but for OBJECT declarators (`*X`, `X[]`) rather
// than function ones. Kept separate so cDef's function path is untouched.
// Returns the identifier NODE (not its text): the definition-site exclusion keys on the
// declared name's byte offsets, so the node has to survive the unwrap.
function cDeclName(n) {
  while (n) {
    if (n.type === 'identifier') return n;
    if (n.type === 'pointer_declarator' || n.type === 'array_declarator'
        || n.type === 'parenthesized_declarator') { n = field(n, 'declarator'); continue; }
    return null;
  }
  return null;
}
// `const` appears as a type_qualifier child of the declaration (alongside an optional
// `static` storage_class_specifier), not on the declarator.
function isConstDeclaration(decl) {
  if (!decl || decl.type !== 'declaration') return false;
  for (let i = 0; i < decl.childCount; i++) {
    const c = decl.child(i);
    if (c.type === 'type_qualifier' && c.text === 'const') return true;
  }
  return false;
}
// C: `#define X "…"`, plus `static const char *X = "…"` / `const char X[] = "…"`.
// The declaration form matches at the init_declarator so `const char *A = "a", *B = "b";`
// yields one candidate each. A #define's value is an unstructured preproc_arg, so it is
// required to be exactly one quoted run (adjacent-string concatenation or a trailing
// comment is skipped rather than mangled).
function cConst(node) {
  if (node.type === 'preproc_def') {
    const nameNode = field(node, 'name');
    if (!nameNode) return null;
    // A `#define` body is an unstructured preproc_arg; only ONE quoted run is a value we
    // can read (adjacent-string concatenation, a macro, a `\`-continued expression are
    // all "definition present, value unknown" rather than reasons to forget the define).
    const v = (field(node, 'value')?.text || '').trim();
    return constCandidate(nameNode.text, /^"(?:[^"\\]|\\.)*"$/.test(v) ? v.slice(1, -1) : null, nameNode);
  }
  if (node.type === 'init_declarator' && isConstDeclaration(node.parent) && isFileScope(node.parent)) {
    const nameNode = cDeclName(field(node, 'declarator'));
    if (!nameNode) return null;
    return constCandidate(nameNode.text, constString(field(node, 'value')), nameNode);
  }
  return null;
}
// FILE SCOPE, the C analogue of tsConst's module-scope guard: a `static const char *p =
// "…"` declared INSIDE a function body is a local, not a constant two compartments can
// share. Conditional compilation is still file scope, so preprocessor wrappers are
// unwrapped rather than rejected. (`#define` needs no such test — the C preprocessor has
// no block scope, so a #define is always file-wide wherever it is written.)
function isFileScope(decl) {
  let p = decl?.parent;
  while (p && /^preproc_(if|ifdef|else|elif)/.test(p.type)) p = p.parent;
  return p?.type === 'translation_unit';
}

// Java: `static final String X = "…"`. Matched at the variable_declarator (multi-declarator
// fields), requiring BOTH modifiers — a bare `final` field is per-instance, and a bare
// `static` one is mutable. `modifiers` is an unnamed child, so it is found by scan.
function javaConst(node) {
  if (node.type !== 'variable_declarator') return null;
  const decl = node.parent;
  if (!decl || decl.type !== 'field_declaration') return null;
  let isStatic = false, isFinal = false;
  for (let i = 0; i < decl.childCount; i++) {
    const m = decl.child(i);
    if (m.type !== 'modifiers') continue;
    for (let j = 0; j < m.childCount; j++) {
      const t = m.child(j).type;
      if (t === 'static') isStatic = true;
      else if (t === 'final') isFinal = true;
    }
  }
  if (!isStatic || !isFinal) return null;
  const nameNode = field(node, 'name');
  if (!nameNode) return null;
  return constCandidate(nameNode.text, constString(field(node, 'value')), nameNode);
}

// Kotlin: `const val X = "…"` (top level or in an object). property_declaration carries
// no field names in this grammar, so walk its named children: `modifiers` must hold the
// `const` property_modifier, `variable_declaration` holds the identifier (and an optional
// type), and the initialiser is the remaining trailing child — a `getter` for a computed
// property lands there too and is rejected by constString.
//
// ANNOTATED TOP-LEVEL PROPERTIES DO NOT PARSE AS PROPERTIES. `@Suppress("unused")` (or
// `@JvmField`, or any annotation) above an UNTYPED top-level `const val X = "…"` makes
// this grammar error-recover into `assignment > annotated_expression > infix_expression`,
// where `const`, `val` and the name are three bare identifiers and the initialiser is the
// assignment's right-hand side — no property_declaration anywhere, so the rule above
// simply never fired and the constant vanished. (Annotated properties inside an
// `object { … }` body, and annotated properties with an explicit `: String` type, DO
// parse as property_declaration — which is why this only bites the plainest form.)
// Measured consequence: a vendored pair whose second copy carried a `@Suppress` was seen
// by inference as defined in ONE compartment and mislabelled layout 'shared-module'.
function ktAnnotatedConst(node) {
  if (node.type !== 'assignment') return null;
  const lhs = node.namedChild(0);
  if (!lhs || lhs.type !== 'annotated_expression') return null;
  let infix = null;
  for (let i = 0; i < lhs.namedChildCount; i++) if (lhs.namedChild(i).type === 'infix_expression') infix = lhs.namedChild(i);
  if (!infix) return null;
  const words = [];
  for (let i = 0; i < infix.namedChildCount; i++) words.push(infix.namedChild(i));
  // exactly `const val NAME`
  if (words.length !== 3 || words[0].text !== 'const' || words[1].text !== 'val') return null;
  const nameNode = words[2];
  if (!/^[A-Za-z_]/.test(nameNode.text)) return null;
  const init = node.namedChild(node.namedChildCount - 1);
  return constCandidate(nameNode.text, constString(init === lhs ? null : init), nameNode);
}

function ktConst(node) {
  const annotated = ktAnnotatedConst(node);
  if (annotated) return annotated;
  if (node.type !== 'property_declaration') return null;
  let isConst = false, nameNode = null, init = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === 'modifiers') {
      for (let j = 0; j < c.namedChildCount; j++) if (c.namedChild(j).text === 'const') isConst = true;
    } else if (c.type === 'variable_declaration') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const id = c.namedChild(j);
        if (id.type === 'identifier' || id.type === 'simple_identifier') { nameNode = id; break; }
      }
    } else {
      init = c;
    }
  }
  if (!isConst || !nameNode) return null;
  return constCandidate(nameNode.text, constString(init), nameNode);
}

// Rust: `const X: &str = "…"` and `static X: &str = "…"`. Both are name-addressable
// compile-time/'static bindings and both are what a Rust crate uses where C would use a
// `#define`, so both are extracted.
//
// `static mut` is a REBINDING, and carries `value: null` for exactly the reason tsConst
// gives a module-scope `let`/`var` one: the initialiser is not what the program
// necessarily holds, but the compartment does DECLARE the name, so it is not a passive
// user of somebody else's value and must not be joined to one.
//
// MODULE / FILE SCOPE is required, the Rust spelling of tsConst's `program` guard and
// cConst's isFileScope. A `const` inside a function body has parent `block` and is a
// local — the measured false-positive shape. An ASSOCIATED const (`impl Foo { const
// TIMEOUT: &str = … }`, or a trait's) is not a local: it is addressed as `Foo::TIMEOUT`
// from anywhere including another crate, which is precisely the position Java's
// `static final` field and Kotlin's `object`-member `const val` occupy, and both of
// those are extracted.
//
// A RAW string (`r"…"` / `r#"…"#`) parses as `raw_string_literal`, which constString
// rejects, so it lands as a value-unknown DEFINITION. That is deliberate rather than an
// oversight: constCandidate runs decodeConstValue over every value it keeps, and the
// whole point of a raw literal is that `\t` is a backslash and a `t`, so decoding one
// would hand inference a value the program does not hold — and `r"C:\temp\state"` (the
// case raw strings are actually used for) would decode to a tab. A value-unknown
// definition costs a seam; a WRONG value invents one.
function rustModuleScope(node) {
  const p = node.parent;
  if (!p) return false;
  if (p.type === 'source_file') return true;
  if (p.type !== 'declaration_list') return false;
  const g = p.parent;
  return !!(g && (g.type === 'mod_item' || g.type === 'impl_item' || g.type === 'trait_item'));
}

function rustConst(node) {
  if (node.type !== 'const_item' && node.type !== 'static_item') return null;
  if (!rustModuleScope(node)) return null;
  const nameNode = field(node, 'name');
  if (!nameNode) return null;
  // `mutable_specifier` is an unnamed-field child of the static_item, so it is found by
  // scan (the same way javaConst finds `modifiers`).
  let mutable = false;
  for (let i = 0; i < node.childCount; i++) if (node.child(i).type === 'mutable_specifier') mutable = true;
  return constCandidate(nameNode.text, mutable ? null : constString(field(node, 'value')), nameNode);
}

// Rust env read: `std::env::var("NAME")` / `env::var("NAME")` (and the `_os` variant),
// the analogue of cState's `getenv`. The `env::` QUALIFIER is required — unlike `getenv`,
// a bare `var(…)` (from `use std::env::var`) is far too common a name to treat as an env
// access, and stateCandidate feeds a cross-compartment seam where a false token is worse
// than a missed one.
function rustState(node) {
  if (node.type !== 'call_expression') return null;
  let fn = field(node, 'function');
  if (fn?.type === 'generic_function') fn = field(fn, 'function');
  if (fn?.type !== 'scoped_identifier') return null;
  const name = field(fn, 'name')?.text;
  if (name !== 'var' && name !== 'var_os') return null;
  const path = field(fn, 'path');
  if (!path) return null;
  // `env::var` -> path is the identifier `env`; `std::env::var` -> path is a nested
  // scoped_identifier whose own `name` is `env`.
  const qualifier = path.type === 'scoped_identifier' ? field(path, 'name')?.text : path.text;
  if (qualifier !== 'env') return null;
  return stateCandidate(strLiteral(firstArg(node)));
}

// NO IMPORT RULE FOR RUST — a deliberate decision, not an omission. A `use` path is a
// crate-relative NAMESPACE path, not a file path, and contracts/imports.js resolves only
// (a) a `.`-relative specifier against the filesystem and (b) a bare specifier against
// another compartment's package.json `name`. Neither maps:
//   * `crate::` / `self::` / `super::` are BY DEFINITION inside the current crate, and
//     the crate is the compartment (Cargo.toml is the boundary) — so every one of them
//     is a same-compartment import, which imports.js deliberately skips anyway.
//   * an external-crate path (`serde::…`, `sibling_crate::…`) names a CRATE, not a file.
//     Turning it into the `<module>` symbol of a real file would require reimplementing
//     Rust's module system (`mod` declarations, `foo.rs` vs `foo/mod.rs`, `#[path]`,
//     `pub use` re-exports) plus a TOML reader for `[package] name` and its `-`/`_`
//     normalization. A guess that lands on the wrong file is a false IMPORTS edge and
//     false `corroborated` evidence on a resource seam.
// Emitting nothing is the established answer for a language whose imports don't resolve:
// Python, Java and Kotlin emit no import candidates either (see infer.js's note), which
// is exactly why the vendored name+value join is mandatory rather than a fallback.
function rustSig(node) {
  return rustState(node) || rustConst(node);
}

// Each language's const rule runs LAST: the node types it matches (variable_declarator,
// assignment, preproc_def/init_declarator, field_declaration's declarator,
// property_declaration) are disjoint from every existing rule's, so no existing
// candidate can be displaced.
function tsSig(node) {
  const r = tsRoute(node);
  if (r) return wireCandidate(r);
  return tsMessage(node) || tsState(node) || tsImport(node) || tsConst(node);
}
function pySig(node) {
  const r = pyRoute(node);
  if (r) return wireCandidate(r);
  return pyMessage(node) || pyState(node) || pyConst(node);
}
function cSig(node) {
  return cState(node) || cImport(node) || cConst(node);
}
// Java and Kotlin had no signal rule at all; the named string constant is their first.
function javaSig(node) {
  return javaConst(node);
}
function ktSig(node) {
  return ktConst(node);
}

const RULES = {
  typescript: { def: tsDef, call: tsCall, sig: tsSig },
  c: { def: cDef, call: cCall, sig: cSig },
  python: { def: pyDef, call: pyCall, sig: pySig },
  java: { def: javaDef, call: javaCall, sig: javaSig },
  kotlin: { def: ktDef, call: ktCall, sig: ktSig },
  rust: { def: rustDef, call: rustCall, sig: rustSig },
};

// The ONE place a parsed candidate is re-shaped for a downstream consumer: the build
// path (src/extract/index.js) and the inference path (src/contracts/infer.js) used to
// carry independent copies of this object literal, so a field added to one was
// silently dropped by the other. Both now call this. `enclosing` is deliberately NOT
// carried through — it is a per-file symbol index, meaningless once candidates from
// many files are pooled — which preserves the previous shape exactly. `f` is a
// walkSources record ({ compartment, relPath, … }).
export function shapeCandidate(c, f) {
  const rec = {
    kind: c.kind, token: c.token, role: c.role, label: c.label,
    compartment: f.compartment, file: f.relPath, line: c.line,
  };
  if (c.value !== undefined) {
    rec.name = c.name; rec.value = c.value;
    // The declared NAME's offsets. Carried through because the definition-site exclusion
    // keys on POSITION, not on the line: a line key drops every USE of a constant that
    // shares its definition line — `export const P = '/x'; export function f(){ return P; }`
    // loses the writer half entirely, and the resulting one-sided seam blames the user's
    // code. Two constants on one line, and a mention of the name in a trailing comment on
    // the definition line, have the same defect under a line key.
    if (c.nameStart !== undefined) { rec.nameStart = c.nameStart; rec.nameEnd = c.nameEnd; }
  }
  return rec;
}

// Parse one file's source. Returns { symbols, calls, candidates } where:
//   symbols:    [{ name, kind, startLine, endLine }]
//   calls:      [{ enclosing, name, line }]  enclosing is the def name path's last
//               symbol's local index, or null for module-level.
//   candidates: [{ kind, token, role, label, enclosing, line }]  contract signals
//               (HTTP routes, message topics, …) for inference; empty for languages
//               without a signal rule. A kind:'const' candidate carries two extra
//               fields, `name` (== token) and `value`, since the vendored-copy
//               resource join needs the constant's value as well as its name.
//
// We return raw symbol descriptors plus calls keyed by a local symbol index so
// the caller can mint global ids without this module knowing about repos.
export function parseSource(source, lang, variant) {
  const rules = RULES[lang];
  if (!rules) return { symbols: [], calls: [], candidates: [] };

  const parser = parserFor(variant);
  const tree = parser.parse(source);

  const symbols = [];
  const calls = [];
  const candidates = [];
  // [start, end) offsets of every COMMENT node, ascending. A comment is prose: a token
  // that occurs only inside one is a mention, not a reference, and the whole
  // token-matching pipeline (matchContracts' REFERENCES, resource-seam reference
  // discovery) reads RAW FILE TEXT and could not tell the difference. Measured: one
  // `// TODO(someday): … LEDGER_STATE_PATH.` promoted a third compartment to a full
  // participant and produced 6 RESOURCE edges, 4 of them fictional, while trace_contract
  // reported the contract 1/1 satisfied. Ranges are captured HERE because every file is
  // already parsed exactly once — the alternative, a regex strip at scan time, cannot
  // tell a `//` inside a string from a comment.
  const comments = [];

  function walk(node, enclosingIdx) {
    let currentIdx = enclosingIdx;
    // `comment` (TS/JS, C, Python), `line_comment`/`block_comment` (Java),
    // `line_comment`/`multiline_comment` (Kotlin), `line_comment`/`block_comment` (Rust).
    //
    // OUTERMOST ONLY. Rust is the first grammar here that NESTS comment nodes: a doc
    // comment is `(line_comment doc: (doc_comment))`, and `/* /* */ */` nests
    // block_comments — both children whose type also ends in `comment`. Pushing the inner
    // node too would put a range INSIDE another range in the list, and inRanges
    // (extract/contracts.js) binary-searches it assuming DISJOINT ascending ranges: a
    // nested entry can steer the search past the containing outer range and report
    // "not a comment" for text that plainly is one. No other grammar puts a comment
    // inside a comment, so this guard leaves every existing language's ranges identical.
    if (node.type.endsWith('comment') && !node.parent?.type.endsWith('comment')) {
      comments.push([node.startIndex, node.endIndex]);
    }

    const def = rules.def(node);
    if (def && def.name) {
      const idx = symbols.length;
      symbols.push({
        name: def.name,
        kind: def.kind,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
      currentIdx = idx;
    }

    const callName = rules.call(node);
    if (callName) {
      calls.push({ enclosing: currentIdx, name: callName, line: node.startPosition.row + 1 });
    }

    if (rules.sig) {
      const c = rules.sig(node);
      if (c && c.token) {
        const rec = { kind: c.kind, token: c.token, role: c.role, label: c.label, enclosing: currentIdx, line: node.startPosition.row + 1 };
        if (c.value !== undefined) {
          rec.name = c.name; rec.value = c.value;
          if (c.nameStart !== undefined) { rec.nameStart = c.nameStart; rec.nameEnd = c.nameEnd; }
        }
        candidates.push(rec);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), currentIdx);
    }
  }

  walk(tree.rootNode, null);
  comments.sort((a, b) => a[0] - b[0]);
  return { symbols, calls, candidates, comments };
}
