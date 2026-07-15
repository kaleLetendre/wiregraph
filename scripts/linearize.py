#!/usr/bin/env python3
"""
linearize.py — flatten a wiregraph call slice into one top-to-bottom pseudo-source file.

A single feature is usually smeared across many files (domain / application / data /
presentation, or just deep call chains), so reading a flow means tab-hopping. This tool
reassembles the vertical slice: starting from one method (or class), it follows the
wiregraph CALLS graph and inlines each reachable body ONCE, in source-reading order, with
a `file:line` banner and a back-reference on repeats. The result is a single file you read
like a script.

It is a READING AID — the output does not compile. It is language-agnostic: it reads
whatever wiregraph indexed (Kotlin, Java, Python, JS/TS, …).

Data source: the project's embedded wiregraph SQLite graph
(`<project>/.wiregraph/graph.db`, or $WIREGRAPH_DB, or --db). Source text is read from
each symbol's compartment root recorded in the graph, so the slice works across
multi-compartment workspaces. If the graph is missing, run:
    node <wiregraph>/src/build.js <project> --db <project>/.wiregraph/graph.db --reset
(or the /wiregraph-rebuild command).

Usage:
    scripts/linearize.py ProcessOrderUseCase.execute
    scripts/linearize.py execute --file ProcessOrderUseCase --breadth medium
    scripts/linearize.py OrderSaga --breadth full --out order-saga.slice.txt

Breadth (how far across compartment boundaries to inline):
    tight   — only the root symbol's own compartment
    medium  — the root compartment + compartments it directly calls into (default)
    full    — every compartment

Ordering note: the graph stores CALLS at symbol granularity but NOT the call-site line,
so sibling call order is recovered by scanning each body top-to-bottom for the callee's
name. Calls made only through an interface/lambda (name absent from the body text) are
appended after the text-ordered ones.
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from dataclasses import dataclass

# ── project + db resolution ────────────────────────────────────────────────
# Where to look for a project-local .wiregraph/graph.db. The script itself lives in
# the wiregraph plugin, so it must NOT assume it sits inside the target project.
PROJECT_ROOT = (
    os.environ.get("WIREGRAPH_PROJECT")
    or os.environ.get("CLAUDE_PROJECT_DIR")
    or os.getcwd()
)


def find_db(explicit: str | None) -> str:
    candidates = []
    if explicit:
        candidates.append(explicit)
    if os.environ.get("WIREGRAPH_DB"):
        candidates.append(os.environ["WIREGRAPH_DB"])
    candidates.append(os.path.join(PROJECT_ROOT, ".wiregraph", "graph.db"))
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    sys.exit(
        "No wiregraph graph.db found. Looked in:\n  "
        + "\n  ".join(candidates)
        + "\n\nBuild one with:\n  node <wiregraph>/src/build.js "
        + f"{PROJECT_ROOT} --db {PROJECT_ROOT}/.wiregraph/graph.db --reset\n"
        + "  (or run the /wiregraph-rebuild command)"
    )


# ── source classification (language-agnostic heuristics) ────────────────────
_TEST_SEGMENT = re.compile(r"(^|/)(tests?|__tests__|testFixtures|androidTest|spec)(/|$)")
_TEST_FILE = re.compile(
    r"(_test\.\w+$|"          # foo_test.py, foo_test.go
    r"^test_.*\.\w+$|"        # test_foo.py
    r"\.(test|spec)\.\w+$|"   # foo.test.ts, foo.spec.js
    r"(Test|Tests|Spec|IT)\.\w+$)"  # FooTest.kt, FooSpec.scala, FooIT.java
)


def is_test(path: str) -> bool:
    base = os.path.basename(path)
    return bool(_TEST_SEGMENT.search(path) or _TEST_FILE.search(base))


# names not worth inlining — accessors, data-class/stdlib boilerplate, logging shorthands
TRIVIAL_NAMES = {
    "equals", "hashCode", "toString", "copy", "component1", "component2",
    "component3", "component4", "component5", "let", "also", "apply", "run",
    "with", "takeIf", "takeUnless", "require", "requireNotNull", "check",
    "checkNotNull", "error", "TODO", "to", "print", "println", "invoke",
    "getValue", "setValue", "provideDelegate", "lazy", "emptyList",
    "emptyMap", "emptySet", "listOf", "mapOf", "setOf", "mutableListOf",
    "mutableMapOf", "buildList", "d", "e", "i", "w", "v",
}


def is_trivial(name: str) -> bool:
    if name in TRIVIAL_NAMES:
        return True
    if re.fullmatch(r"(get|set|is|has)[A-Z]\w*", name):
        return True
    if len(name) <= 1:
        return True
    return False


# ── graph model ────────────────────────────────────────────────────────────
MEMBER_KINDS = {"method", "function", "constructor"}
CONTAINER_KINDS = {"class", "module"}


@dataclass
class Sym:
    id: str
    compartment: str
    path: str
    name: str
    kind: str
    start: int
    end: int
    lang: str = ""

    @property
    def module(self) -> str:  # the compartment IS the module grouping in wiregraph
        return self.compartment

    @property
    def key(self):  # canonical identity within the graph
        return (self.compartment, self.path, self.name, self.start)


class Graph:
    def __init__(self, db_path: str):
        self.c = sqlite3.connect(db_path)
        self.roots: dict[str, str] = {}            # compartment name -> filesystem root
        self.by_id: dict[str, Sym] = {}
        self.by_key: dict[tuple, str] = {}          # key -> id
        self.by_name: dict[str, list[str]] = {}     # name -> [id]
        self.by_file: dict[tuple, list[Sym]] = {}   # (compartment, path) -> [Sym] (start-sorted)
        self._load_compartments()
        self._load_symbols()
        # outgoing CALLS edges, deduped: src_key -> {dst_key: (resolution, cnt)}
        self.calls: dict[tuple, dict[tuple, tuple]] = {}
        self._load_calls()

    def _load_compartments(self):
        try:
            for name, root in self.c.execute("SELECT name, root FROM compartments"):
                if name:
                    self.roots[name] = root
        except sqlite3.OperationalError:
            pass  # older graph without a compartments table — fall back to PROJECT_ROOT

    def _load_symbols(self):
        for sid, comp, path, name, kind, lang, start, end in self.c.execute(
            "SELECT id, compartment, file, name, kind, lang, startLine, endLine FROM symbols"
        ):
            end = end if end and end >= start else start
            s = Sym(sid, comp or "", path, name, kind, start, end, lang or "")
            self.by_id[sid] = s
            self.by_key.setdefault(s.key, sid)
            self.by_name.setdefault(name, []).append(sid)
            self.by_file.setdefault((comp, path), []).append(s)
        for lst in self.by_file.values():
            lst.sort(key=lambda x: x.start)

    def members(self, container: Sym) -> list[Sym]:
        """Member symbols declared inside a container span, deduped by name, in source order."""
        seen, out = set(), []
        for s in self.by_file.get((container.compartment, container.path), []):
            if container.start < s.start <= container.end and s.kind in MEMBER_KINDS:
                if s.name in seen:
                    continue
                seen.add(s.name)
                out.append(self.sym(s.key) or s)
        return out

    def _load_calls(self):
        for src, dst, res, cnt in self.c.execute(
            "SELECT src, dst, resolution, cnt FROM edges WHERE type='CALLS'"
        ):
            ss, ds = self.by_id.get(src), self.by_id.get(dst)
            if not ss or not ds:
                continue
            bucket = self.calls.setdefault(ss.key, {})
            prev = bucket.get(ds.key)
            # prefer a 'unique' resolution if any edge to this dst is unique
            resolution = "unique" if (res == "unique" or (prev and prev[0] == "unique")) else res
            bucket[ds.key] = (resolution, (prev[1] if prev else 0) + (cnt or 1))

    def sym(self, key) -> Sym | None:
        sid = self.by_key.get(key)
        return self.by_id.get(sid) if sid else None

    def callees(self, key):
        return self.calls.get(key, {})

    def neighbor_compartments(self, comp: str) -> set[str]:
        """Compartments the given compartment calls directly into (1 cross-compartment hop)."""
        out = {comp}
        for src_key, bucket in self.calls.items():
            if src_key[0] != comp:
                continue
            for dst_key in bucket:
                out.add(dst_key[0])
        return out


# ── root resolution ────────────────────────────────────────────────────────
ENTRY_HINTS = ["execute", "invoke", "run", "handle", "process", "start", "onEvent", "dispatch", "main"]


def resolve_root(g: Graph, spec: str, file_hint: str | None) -> Sym:
    cls, meth = (spec.split(".", 1) + [None])[:2] if "." in spec else (None, spec)
    target_name = meth if meth else spec

    def score(s: Sym):
        return (not is_test(s.path),)

    cands = [g.by_id[i] for i in g.by_name.get(target_name, [])]
    if cls:  # Class.method → require the class name in the file path
        cands = [s for s in cands if cls.lower() in s.path.lower()]
    if file_hint:
        cands = [s for s in cands if file_hint.lower() in s.path.lower()]
    cands = [s for s in cands if not is_test(s.path)] or cands

    if cands:
        cands.sort(key=score, reverse=True)
        return g.sym(cands[0].key) or cands[0]

    # maybe `spec` is a class/file name → pick an entry method inside that file
    cls_syms = [
        g.by_id[i]
        for n in g.by_name
        for i in g.by_name[n]
        if spec.lower() in g.by_id[i].path.lower()
    ]
    cls_syms = [s for s in cls_syms if not is_test(s.path)] or cls_syms
    for hint in ENTRY_HINTS:
        for s in cls_syms:
            if s.name == hint:
                return g.sym(s.key) or s
    if cls_syms:
        names = sorted({s.name for s in cls_syms})
        sys.exit(
            f"'{spec}' is not a unique method. Methods seen in matching files:\n  "
            + ", ".join(names)
            + "\nRe-run as  Class.method  or add --file."
        )
    sys.exit(f"Could not resolve root symbol '{spec}'.")


# ── linearizer ─────────────────────────────────────────────────────────────
class Linearizer:
    def __init__(self, g: Graph, breadth: str, max_depth: int, max_syms: int, prune: bool, ambiguous: str, include_tests: bool):
        self.g = g
        self.breadth = breadth
        self.max_depth = max_depth
        self.max_syms = max_syms
        self.prune = prune
        self.ambiguous = ambiguous  # skip | stub | follow
        self.include_tests = include_tests
        self.emitted: set[tuple] = set()
        self.out: list[str] = []
        self.tree: list[str] = []
        self.count = 0
        self.truncated = False
        self.root_module = "?"
        self._allowed: set[str] | None = None
        self._src_cache: dict[tuple, list[str]] = {}

    def lines_of(self, compartment: str, path: str) -> list[str]:
        cache_key = (compartment, path)
        if cache_key not in self._src_cache:
            base = self.g.roots.get(compartment, PROJECT_ROOT)
            real = os.path.join(base, path)
            try:
                with open(real, encoding="utf-8", errors="replace") as f:
                    self._src_cache[cache_key] = f.read().splitlines()
            except OSError:
                self._src_cache[cache_key] = []
        return self._src_cache[cache_key]

    def body(self, s: Sym) -> list[str]:
        return self.lines_of(s.compartment, s.path)[s.start - 1 : s.end]

    def allowed_modules(self):
        if self.breadth == "tight":
            return {self.root_module}
        if self.breadth == "medium":
            if self._allowed is None:
                self._allowed = self.g.neighbor_compartments(self.root_module)
            return self._allowed
        return None  # full

    def in_scope(self, path: str) -> bool:
        return self.include_tests or not is_test(path)

    def can_inline(self, s: Sym) -> bool:
        if not self.in_scope(s.path):
            return False
        allowed = self.allowed_modules()
        return allowed is None or s.module in allowed

    @staticmethod
    def token_of(s: Sym) -> str:
        if s.name in ("<init>", "constructor", "__init__"):
            return os.path.splitext(os.path.basename(s.path))[0]  # class name from filename
        return s.name

    def first_pos(self, caller_text: list[str], token: str) -> int:
        if not token:
            return 10**9
        pat = re.compile(r"\b" + re.escape(token) + r"\b")
        for ln, line in enumerate(caller_text):
            if pat.search(line):
                return ln
        return 10**9

    def stub(self, s: Sym, depth: int):
        pad = "  " * depth
        decl = ""
        for line in self.body(s)[:6]:
            decl += line.strip() + " "
            if "{" in line or "=" in line or line.strip().endswith(")") or line.strip().endswith(":"):
                break
        decl = decl.split("{")[0].strip().rstrip("=").strip()
        self.out.append(f"{pad}// → [{s.module}] {decl or s.name}(…)   ·   {s.path}:{s.start}  (boundary, not inlined)")

    def amb_stub(self, name: str, group: list[Sym], depth: int):
        if self.ambiguous == "follow":
            group = sorted(group, key=lambda c: c.module != self.root_module)
            best = group[0]
            if self.can_inline(best):
                self.emit(best, depth)
            else:
                self.stub(best, depth)
            return
        pad = "  " * depth
        where = ", ".join(dict.fromkeys(f"{c.module}:{os.path.basename(c.path)}:{c.start}" for c in group))
        self.out.append(f"{pad}// ≈ {name}(…) → ambiguous, dispatches to one of: {where}  (not inlined)")

    def emit(self, s: Sym, depth: int, via: str = ""):
        pad = "  " * depth
        breadcrumb = ("  " * depth) + ("└ " if depth else "") + f"{s.name}   {s.path}:{s.start}"

        if s.key in self.emitted:
            self.out.append(f"{pad}// ↑ see {s.name} above   ·   {s.path}:{s.start}")
            return
        if self.count >= self.max_syms:
            if not self.truncated:
                self.out.append(f"{pad}// … TRUNCATED at --max {self.max_syms} symbols. Raise --max or narrow --breadth/--depth.")
                self.truncated = True
            return

        self.emitted.add(s.key)
        self.count += 1
        self.tree.append(breadcrumb + (f"   [{via}]" if via else ""))

        self.out.append("")
        self.out.append(f"{pad}// ┌─────────────────────────────────────────────────────────────")
        self.out.append(f"{pad}// │ {s.name}   ·   [{s.module}]   ·   {s.path}:{s.start}-{s.end}")
        self.out.append(f"{pad}// └─────────────────────────────────────────────────────────────")
        for line in self.body(s):
            self.out.append(pad + line)

        if depth >= self.max_depth:
            self.out.append(f"{pad}// … max depth {self.max_depth} reached; callees of {s.name} not expanded")
            return

        callees = self.g.callees(s.key)
        text = self.body(s)
        uniq: list[Sym] = []
        amb: dict[str, list[Sym]] = {}
        for k, (res, _) in callees.items():
            if k == s.key:
                continue
            if self.prune and is_trivial(k[2]):
                continue
            cs = self.g.sym(k)
            if cs is None or not self.in_scope(cs.path):
                continue
            if res == "unique":
                uniq.append(cs)
            else:
                amb.setdefault(cs.name, []).append(cs)

        # order unique callees and ambiguous groups together by first text appearance
        items: list[tuple[int, str, tuple]] = []
        for cs in uniq:
            items.append((self.first_pos(text, self.token_of(cs)), cs.name, ("sym", cs)))
        for name, group in amb.items():
            items.append((self.first_pos(text, name), name, ("amb", name, group)))
        items.sort(key=lambda t: (t[0], t[1]))

        for item in (payload for _, _, payload in items):
            if item[0] == "sym":
                cs = item[1]
                assert isinstance(cs, Sym)
                if self.can_inline(cs):
                    self.emit(cs, depth + 1)
                else:
                    self.stub(cs, depth + 1)
            elif self.ambiguous != "skip":
                self.amb_stub(item[1], item[2], depth + 1)

    def run(self, root: Sym) -> str:
        self.root_module = root.module
        members = self.g.members(root) if root.kind in CONTAINER_KINDS else []
        if members:
            for m in members:
                self.emit(m, 0)
        else:
            self.emit(root, 0)
        header = [
            "// ══════════════════════════════════════════════════════════════════",
            f"// LINEARIZED SLICE — root: {root.name}   ({root.path}:{root.start})",
            f"// breadth={self.breadth}  depth<={self.max_depth}  compartment={self.root_module}",
            f"// {self.count} symbols inlined across {len({(k[0], k[1]) for k in self.emitted})} files"
            + ("   [TRUNCATED]" if self.truncated else ""),
            "// READING AID — does not compile. Generated by scripts/linearize.py",
            "// ══════════════════════════════════════════════════════════════════",
            "//",
            "// CALL TREE",
        ]
        header += ["// " + t for t in self.tree]
        header += ["//", "// ── LINEARIZED BODIES " + "─" * 46]
        return "\n".join(header + self.out) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Flatten a wiregraph call slice into one readable pseudo-source file.")
    ap.add_argument("root", help="root symbol: Class.method | method | ClassName")
    ap.add_argument("--file", help="substring to disambiguate which file the root lives in")
    ap.add_argument("--breadth", choices=["tight", "medium", "full"], default="medium",
                    help="how far across compartment boundaries to inline (default: medium)")
    ap.add_argument("--depth", type=int, default=12)
    ap.add_argument("--max", type=int, default=250, help="max symbols to inline (safety cap)")
    ap.add_argument("--no-prune", action="store_true", help="do not drop accessors/stdlib/logging calls")
    ap.add_argument("--ambiguous", choices=["skip", "stub", "follow"], default="stub",
                    help="name-collision edges: skip (hide), stub (one line, default), follow (inline best guess)")
    ap.add_argument("--include-tests", action="store_true",
                    help="follow into test sources too (needed when the root is a test method)")
    ap.add_argument("--db", help="path to wiregraph graph.db (default: auto-detect)")
    ap.add_argument("--out", help="output file (default: stdout)")
    args = ap.parse_args()

    g = Graph(find_db(args.db))
    root = resolve_root(g, args.root, args.file)
    lin = Linearizer(g, args.breadth, args.depth, args.max, prune=not args.no_prune,
                     ambiguous=args.ambiguous, include_tests=args.include_tests)
    text = lin.run(root)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {lin.count} symbols → {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
