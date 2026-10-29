// The public door's transaction (Issue #293, ADR-0010): what an anonymous
// request reads runs as `wms_public`, never as the API's own role. The API's
// connection holds the role to SET and not to inherit (sql/public-door.ts), so
// the transaction says `SET LOCAL ROLE`, finds the project that publishes
// itself under the slug — the one project row that role sees by it — and sets
// that project's company, as `withCompany` does for a signed-in request.
// Every statement after that is bounded by the role's column grants and its
// policies; the role and the company end with the transaction.
import { eq, is, sql } from "drizzle-orm"
import { PgTransaction } from "drizzle-orm/pg-core"

import type { Db, Tx } from "./client"
import { PLAIN_ROLE, PUBLIC_ROLE } from "./roles"
import { project } from "./schema/organisation"
import { COMPANY_SETTING } from "./tenant"

/** A published project's branding (M22 of #293): its one colour and two https addresses, each null where the project set none. */
export type PublishedBranding = { brandColor: string | null; logoUrl: string | null; accessibilityStatementUrl: string | null }

/** The published project a public request reads inside: what its own row lets an anonymous reader know. */
export type PublishedProject = { id: string; companyId: string; name: string; language: string; timezone: string; slug: string; branding: PublishedBranding }

if (!PLAIN_ROLE.test(PUBLIC_ROLE)) throw new Error(`public-door: ${PUBLIC_ROLE} is not a plain role name`)

/**
 * Runs `fn` as the public role inside the project published under `slug`, or
 * answers undefined without running it when no project publishes itself so.
 */
export async function withPublishedProject<T>(db: Db, slug: string, fn: (tx: Tx, published: PublishedProject) => Promise<T>): Promise<T | undefined> {
  if (is(db, PgTransaction)) {
    throw new Error("withPublishedProject: given a transaction; it opens its own, since the role it sets would outlive a savepoint")
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${PUBLIC_ROLE}`))
    // The lookup sets the company it finds in the same statement: one round trip, and a row only when there is one to set.
    const [found] = await tx
      .select({
        id: project.id,
        companyId: project.companyId,
        name: project.name,
        language: project.language,
        timezone: project.timezone,
        slug: project.publicSlug,
        brandColor: project.brandColor,
        logoUrl: project.logoUrl,
        accessibilityStatementUrl: project.accessibilityStatementUrl,
        company: sql<string>`set_config(${COMPANY_SETTING}, ${project.companyId}::text, true)`,
      })
      .from(project)
      .where(eq(project.publicSlug, slug))
      .limit(1)
    if (found?.slug == null) return undefined
    const { company: _company, brandColor, logoUrl, accessibilityStatementUrl, ...published } = found
    return fn(tx, { ...published, slug: found.slug, branding: { brandColor, logoUrl, accessibilityStatementUrl } })
  })
}
