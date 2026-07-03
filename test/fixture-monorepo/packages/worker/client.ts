// Monorepo package "worker": calls the api package's route. Shares only the path
// /internal/sync with api (no import, no code-level call) — the seam a contract
// bridges. Different compartment, same git repo.
export async function pushBatch(batchId: string) {
  await fetch('/internal/sync', {
    method: 'POST',
    body: JSON.stringify({ batch_id: batchId }),
  });
}
