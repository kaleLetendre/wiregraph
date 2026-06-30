// Fixture "client" repo: calls a route the svc-api repo defines. Shares only the
// path /api/register with svc-api (no code-level call between them) — the seam a
// contract bridges.
export async function register(deviceToken: string) {
  await fetch('/api/register', {
    method: 'POST',
    body: JSON.stringify({ device_token: deviceToken }),
  });
}
