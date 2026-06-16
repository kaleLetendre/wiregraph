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

const RULES = {
  typescript: { def: tsDef, call: tsCall },
  c: { def: cDef, call: cCall },
  python: { def: pyDef, call: pyCall },
  java: { def: javaDef, call: javaCall },
  kotlin: { def: ktDef, call: ktCall },
};

// Parse one file's source. Returns { symbols, calls } where:
//   symbols: [{ name, kind, startLine, endLine }]
//   calls:   [{ enclosing, name, line }]  enclosing is the def name path's last
//            symbol's local index, or null for module-level.
//
// We return raw symbol descriptors plus calls keyed by a local symbol index so
// the caller can mint global ids without this module knowing about repos.
export function parseSource(source, lang, variant) {
  const rules = RULES[lang];
  if (!rules) return { symbols: [], calls: [] };

  const parser = parserFor(variant);
  const tree = parser.parse(source);

  const symbols = [];
  const calls = [];

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

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), currentIdx);
    }
  }

  walk(tree.rootNode, null);
  return { symbols, calls };
}
