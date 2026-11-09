// The web build identifier a `start-route` carries as `appVersion` (Issue
// #145), where the deployment exposes one. The web is deployed on Vercel
// (ADR-0008), which makes the commit it builds from a public system variable,
// `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`, inlined by Next at build time — so it
// is read by its literal name, as lib/api/config.ts reads its own, and turbo
// passes it to the web's build as it does every `NEXT_PUBLIC_*` variable, by
// its Next.js inference. Anywhere else, a local build included, there is none
// and the start goes without.

type Env = Readonly<Record<string, string | undefined>>

export function appVersionOf(env: Env): string | null {
  const commit = env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.trim()
  return commit ? commit : null
}

export const APP_VERSION: string | null = appVersionOf({ NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA })
