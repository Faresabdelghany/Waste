// What the API e2e suite is told about its world (Issue #151), each with the
// local stack's own value as the default so `pnpm test:e2e:api` runs after
// `pnpm stack:start` with nothing set; CI sets the addresses explicitly and a
// developer overrides in their environment. turbo.json declares every name
// here on `test:e2e:api`, or strict env mode would drop it.
//
// The password is the one every local Login gets: the public default in
// packages/db/src/local-stack/logins.ts (`DEFAULT_LOCAL_LOGIN_PASSWORD`),
// spelled again here because the web may import nothing from @waste/db. It
// opens a stack on the machine that started it and nothing else.

export const E2E = {
  /** The seeded primary administrator (packages/db/src/seed/demo.ts). */
  loginEmail: process.env.E2E_LOGIN_EMAIL ?? "fares.abdelghany@kystbyen.example",
  /** Every local Login's password, unless the stack was started with `LOCAL_LOGIN_PASSWORD`. */
  loginPassword: process.env.E2E_LOGIN_PASSWORD ?? "local-waste-password",
  /**
   * The tester the suite invites through the API and signs in as. Its Login
   * is in every local plan (`E2E_TESTER_LOGIN`, packages/db/src/local-stack/
   * logins.ts, the same address); another address needs to have been in
   * `LOCAL_EXTRA_LOGINS` at stack start. Its User Account is the suite's to
   * make.
   */
  testerEmail: process.env.E2E_TESTER_EMAIL ?? "e2e-tester@waste-e2e.example",
  /** The API's own origin, for the runner's calls beside the browser's and for its readiness probe (root CLAUDE.md: :3001). */
  apiUrl: (process.env.E2E_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
  /** The worker's probes (root CLAUDE.md: :3002). */
  workerUrl: (process.env.E2E_WORKER_URL ?? "http://127.0.0.1:3002").replace(/\/+$/, ""),
} as const

/** A name no other run has used: the tenant is shared and nothing is cleaned up. */
export const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
