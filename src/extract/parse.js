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

const C_LANG = CMod.default || CMod;
const PY_LANG = PyMod.default || PyMod;
const JAVA_LANG = JavaMod.default || JavaMod;
const KOTLIN_LANG = KotlinMod.default || KotlinMod;

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
  const oName = o && (o.type === 'identifier' ? o.text : o.type === 'member_expression' ? field(o, 'property')?.text : null);
  return oName === 'process' || oName === 'meta';
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

function tsSig(node) {
  const r = tsRoute(node);
  if (r) return wireCandidate(r);
  return tsMessage(node) || tsState(node);
}
function pySig(node) {
  const r = pyRoute(node);
  if (r) return wireCandidate(r);
  return pyMessage(node) || pyState(node);
}
function cSig(node) {
  return cState(node);
}

const RULES = {
  typescript: { def: tsDef, call: tsCall, sig: tsSig },
  c: { def: cDef, call: cCall, sig: cSig },
  python: { def: pyDef, call: pyCall, sig: pySig },
  java: { def: javaDef, call: javaCall },
  kotlin: { def: ktDef, call: ktCall },
};

// Parse one file's source. Returns { symbols, calls, candidates } where:
//   symbols:    [{ name, kind, startLine, endLine }]
//   calls:      [{ enclosing, name, line }]  enclosing is the def name path's last
//               symbol's local index, or null for module-level.
//   candidates: [{ kind, token, role, label, enclosing, line }]  contract signals
//               (HTTP routes, message topics, …) for inference; empty for languages
//               without a signal rule.
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

  function walk(node, enclosingIdx) {
    let currentIdx = enclosingIdx;

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
        candidates.push({ kind: c.kind, token: c.token, role: c.role, label: c.label, enclosing: currentIdx, line: node.startPosition.row + 1 });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), currentIdx);
    }
  }

  walk(tree.rootNode, null);
  return { symbols, calls, candidates };
}
