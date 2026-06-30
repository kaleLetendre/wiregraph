// Fixture for wiregraph tests. a_main calls a_helper (intra-file) and a_util
// (cross-file, same repo) — the cross-file edge is what the incremental
// dangling-edge check must preserve. dup() also lives in dup_b.c (ambiguous).

int a_util(int x);

int a_helper(int n) {
  return n + 1;
}

int dup(int z) {
  return z;
}

int a_main(int n) {
  int h = a_helper(n);
  int u = a_util(n);
  return h + u + dup(n);
}
