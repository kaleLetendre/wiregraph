// Extension -> language, plus the directories we never descend into.

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.runtime', '.codegraph', '.shipyard', 'dist', 'build', 'out',
  '.next', 'coverage', 'vendor', '__pycache__', '.venv', 'venv', '.idea',
  '.vscode', 'cmake-build-debug', 'cmake-build-release', '.aws-sam',
  '.tox', '.eggs', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.gradle', 'target', '.mvn',
]);

// Map extension -> { lang, variant }. variant is used by the TS grammar to pick
// the tsx vs plain dialect.
const EXT = {
  '.ts': { lang: 'typescript', variant: 'typescript' },
  '.mts': { lang: 'typescript', variant: 'typescript' },
  '.cts': { lang: 'typescript', variant: 'typescript' },
  '.tsx': { lang: 'typescript', variant: 'tsx' },
  // JS dialects parse acceptably with the TS grammar for call/def extraction.
  '.js': { lang: 'typescript', variant: 'tsx' },
  '.jsx': { lang: 'typescript', variant: 'tsx' },
  '.mjs': { lang: 'typescript', variant: 'tsx' },
  '.cjs': { lang: 'typescript', variant: 'tsx' },
  '.c': { lang: 'c', variant: 'c' },
  '.h': { lang: 'c', variant: 'c' },
  '.py': { lang: 'python', variant: 'python' },
  '.java': { lang: 'java', variant: 'java' },
  '.kt': { lang: 'kotlin', variant: 'kotlin' },
  '.kts': { lang: 'kotlin', variant: 'kotlin' },
};

export function langForFile(path) {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT[path.slice(dot).toLowerCase()] || null;
}
