// The organisation half of Organisation & Access on the wire (Issue #70): the
// tenant itself, its Projects, and the Service Providers it works with. One
// schema per resource and one per write body, because they are different
// things: a resource carries what the server owns (the id it minted, the
// instants the database stamped), a write body carries only what a caller may
// say, and the write bodies are strict, so a member the server owns — an id,
// a timestamp, a company's status — is refused by name instead of silently
// dropped.
//
// A patch is every field optional and at least one given: a patch with
// nothing in it is a request that means nothing, and answering 200 to it
// would hide a client bug. The company's `status` is not among them
// (onboarding to active is an operator's act, not a tenant's), and neither is
// anything the database derives.
//
// The coded fields are checked by shape and not against a list: country is
// ISO 3166-1 alpha-2, currency ISO 4217, language a BCP 47 tag, timezone an
// IANA name. Shipping those registries is a dependency and a release cadence;
// the shape is what keeps a typo out of a column, and the real check is the
// one the consumer of the value runs (Intl for a timezone, a price for a
// currency). `kind` is free text on purpose: the prototype's Municipality,
// Business unit, Contract and Region are labels, not a vocabulary.
//
// The statuses are text with a CHECK in the database and this enum at the
// boundary; packages/db/src/__tests__/statuses.test.ts holds the two lists in
// lockstep, so adding a status is one code change and one migration, never
// half of each.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { Label } from "./text"

/** A company's status: onboarding until its first project runs. */
export const CompanyStatus = z.enum(["active", "onboarding"])
export type CompanyStatus = z.infer<typeof CompanyStatus>

/** A project's status: onboarding until it runs. */
export const ProjectStatus = z.enum(["active", "onboarding"])
export type ProjectStatus = z.infer<typeof ProjectStatus>

/** ISO 3166-1 alpha-2, uppercase (`DK`). */
const Country = z.string().regex(/^[A-Z]{2}$/, "a two-letter uppercase ISO 3166-1 alpha-2 country code, such as DK")

/** ISO 4217, uppercase (`DKK`). */
const Currency = z.string().regex(/^[A-Z]{3}$/, "a three-letter uppercase ISO 4217 currency code, such as DKK")

/** A BCP 47 language tag by shape (`da`, `en-GB`, `zh-Hans-CN`). */
const Language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a BCP 47 language tag, such as da or en-GB")

/** An IANA timezone name by shape (`Europe/Copenhagen`, `Etc/GMT+2`), or `UTC`. */
const Timezone = z
  .string()
  .regex(/^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z][A-Za-z0-9_+-]*)+)$/, "an IANA timezone name, such as Europe/Copenhagen")

/** What the server owns on every resource here. */
const stamped = {
  id: Id,
  /** When the row was made. */
  createdAt: IsoDateTime,
  /** When it last changed; the database keeps it, not the caller. */
  updatedAt: IsoDateTime,
}

/** A patch must change something. */
const somethingToChange = { message: "Give at least one field to change" }
const changesSomething = (patch: object) => Object.keys(patch).length > 0

export const Company = z.object({
  ...stamped,
  name: Label,
  legalName: Label,
  /** As the company registry spells it (a CVR number in Denmark); unique per country. */
  registrationNumber: Label,
  country: Country,
  status: CompanyStatus,
})
export type Company = z.infer<typeof Company>

/** What an administrator may change about their own company. The status is not theirs to set. */
export const CompanyPatch = z
  .strictObject({
    name: Label.optional(),
    legalName: Label.optional(),
    registrationNumber: Label.optional(),
    country: Country.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type CompanyPatch = z.infer<typeof CompanyPatch>

export const Project = z.object({
  ...stamped,
  name: Label,
  /** Free text: Municipality, Business unit, Contract, Region. */
  kind: Label,
  language: Language,
  currency: Currency,
  timezone: Timezone,
  status: ProjectStatus,
})
export type Project = z.infer<typeof Project>

export const ProjectCreate = z.strictObject({
  name: Label,
  kind: Label,
  language: Language,
  currency: Currency,
  timezone: Timezone,
  status: ProjectStatus.default("onboarding").describe("Defaults to onboarding when absent: a project is onboarding until it runs."),
})
export type ProjectCreate = z.infer<typeof ProjectCreate>

export const ProjectPatch = z
  .strictObject({
    name: Label.optional(),
    kind: Label.optional(),
    language: Language.optional(),
    currency: Currency.optional(),
    timezone: Timezone.optional(),
    status: ProjectStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ProjectPatch = z.infer<typeof ProjectPatch>

export const ServiceProvider = z.object({
  ...stamped,
  legalName: Label,
  /** Unique per country within the company. */
  registrationNumber: Label,
  country: Country,
  contactName: Label,
  contactEmail: z.email(),
})
export type ServiceProvider = z.infer<typeof ServiceProvider>

export const ServiceProviderCreate = z.strictObject({
  legalName: Label,
  registrationNumber: Label,
  country: Country,
  contactName: Label,
  contactEmail: z.email(),
})
export type ServiceProviderCreate = z.infer<typeof ServiceProviderCreate>

export const ServiceProviderPatch = z
  .strictObject({
    legalName: Label.optional(),
    registrationNumber: Label.optional(),
    country: Country.optional(),
    contactName: Label.optional(),
    contactEmail: z.email().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ServiceProviderPatch = z.infer<typeof ServiceProviderPatch>
