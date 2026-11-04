// `pnpm --filter @waste/db provision-company` (and `pnpm db:provision-company`
// at the root): makes a Company outside the seed (C33 of #291) on
// DATABASE_ADMIN_URL — the company onboarding, its system roles with their
// grants, its Decommission Reasons, its first project and its primary
// administrator as an Invitation (`provisionCompany`,
// src/commands/provision-company.ts) — and prints the ids it made.
//
// The owner's door, run as the owner, which sees every company's Invitations
// the address check reads. A non-loopback URL is refused before anything is
// read: on the Pilot a company is made through the owner's own operation, the
// one #390 proposes for `pilot-database.yml`, never from a laptop. Nothing is
// sent and no Login is made; the administrator's Login is the Owner's, bound
// on first sign-in by the address given here.
//
//   pnpm db:provision-company -- --name "Fjordby Affald" --legal-name "Fjordby Affald A/S" \
//     --registration-number 87654321 --country DK \
//     --project "Fjordby Kommune" --project-kind Municipality --language da --currency DKK --timezone Europe/Copenhagen \
//     --admin-email ida.holm@fjordby.example --admin-name "Ida Holm"
import { parseArgs } from "node:util"

import { createDb } from "../src/client"
import { provisionCompany } from "../src/commands/provision-company"
import { Refused } from "../src/commands/shared"
import { newId } from "../src/ids"
import { isLocalHost } from "../src/local-host"

const REQUIRED = ["name", "legal-name", "registration-number", "country", "project", "language", "currency", "timezone", "admin-email", "admin-name"] as const

// pnpm hands the `--` its caller typed on to the script: it ends no options here.
const args = process.argv.slice(2)
if (args[0] === "--") args.shift()

const { values } = parseArgs({
  args,
  options: {
    name: { type: "string" },
    "legal-name": { type: "string" },
    "registration-number": { type: "string" },
    country: { type: "string" },
    project: { type: "string" },
    "project-kind": { type: "string", default: "Municipality" },
    language: { type: "string" },
    currency: { type: "string" },
    timezone: { type: "string" },
    "admin-email": { type: "string" },
    "admin-name": { type: "string" },
  },
  strict: true,
})

const missing = REQUIRED.filter((key) => (values[key] ?? "").trim() === "")
if (missing.length > 0) {
  console.error(`@waste/db: provision-company needs ${missing.map((key) => `--${key}`).join(", ")}`)
  process.exit(1)
}
const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example at the repository root)")
  process.exit(1)
}
if (!isLocalHost(url)) {
  console.error(`@waste/db: provision-company refuses ${new URL(url).hostname}: a company on a hosted database is made through the owner's operation (#390), never from here`)
  process.exit(1)
}

const text = (key: (typeof REQUIRED)[number] | "project-kind") => (values[key] as string).trim()
const owner = createDb(url, { max: 1 })
try {
  const made = await provisionCompany(
    owner.db,
    {
      company: { name: text("name"), legalName: text("legal-name"), registrationNumber: text("registration-number"), country: text("country").toUpperCase() },
      project: { name: text("project"), kind: text("project-kind"), language: text("language"), currency: text("currency").toUpperCase(), timezone: text("timezone") },
      administrator: { email: text("admin-email"), fullName: text("admin-name") },
    },
    newId,
  )
  console.log(`@waste/db: company ${made.companyId} made, onboarding, with project ${made.projectId} and its primary administrator ${made.administratorId} invited as ${text("admin-email").toLowerCase()}`)
} catch (error) {
  if (!(error instanceof Refused)) throw error
  console.error(`@waste/db: provision-company refused: ${error.message}`)
  process.exitCode = 1
} finally {
  await owner.close()
}
