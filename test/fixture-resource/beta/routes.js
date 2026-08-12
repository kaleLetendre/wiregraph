// The wire half: this compartment serves the route alpha calls.
export function registerRoutes(app) {
  app.post('/api/resource-ping', (req, res) => res.json({ ok: true }));
}
