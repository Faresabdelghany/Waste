// `pnpm --filter @waste/db seed` (and `pnpm db:seed` at the root): writes the
// demo company to DATABASE_ADMIN_URL, locally or on the hosted project, which
// is the point of its fixed ids. Idempotent, so running it after every
// migration costs nothing: a run that finds the database already saying all of
// it writes no row and exits 0 like any other.
import { count } from "@waste/domain/text"

import { seedDemo } from "../src/seed/demo"

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example at the repository root)")
  process.exit(1)
}
const { companyId, changed, counts } = await seedDemo(url)
const held = [
  count(counts.projects, "project"),
  count(counts.serviceProviders, "service provider"),
  count(counts.roles, "role"),
  count(counts.roleGrants, "grant"),
  count(counts.users, "user"),
].join(", ")
const registry = [
  count(counts.wasteFractions, "waste fraction"),
  count(counts.containerTypes, "container type"),
  count(counts.serviceFrequencies, "service frequency", "service frequencies"),
  count(counts.products, "product"),
  count(counts.customers, "customer"),
  count(counts.properties, "property", "properties"),
  count(counts.propertyParties, "party", "parties"),
  count(counts.propertyGroups, "property group"),
  count(counts.propertyGroupMembers, "group member"),
  count(counts.sharedCollectionPoints, "shared collection point"),
  count(counts.sharedCollectionPointMembers, "point member"),
  count(counts.agreements, "agreement"),
  count(counts.subscriptions, "subscription"),
  count(counts.containers, "container"),
  count(counts.containerServicePlacements, "placement"),
].join(", ")
console.log(
  `@waste/db: demo company ${companyId} on ${new URL(url).hostname} holds ${held}; ` +
    `its Registry ${registry}; ` +
    (changed === 0 ? "nothing to change" : `${count(changed, "row")} written`),
)
