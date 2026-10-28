// Customers › Site access on the API (#393, M4 of #293): the register of
// plates and cards a project's recycling centres admit by,
// `credential-<uuid>` from the start. A credential is a business's — its
// customer and the agreement its visits are charged to — or a household's
// property, named through the store's resolver; its kind, value, holder and
// start are what it is, so a patch moves its label and its end alone (the
// form's last day in force, the wire's first day out). Its status — in
// force, upcoming, ended, blocked — is read on its project's day, and it is
// blocked and unblocked by command alone, never deleted. The words are
// lib/data/site-visits.ts'; the routes
// apps/api/src/routes/access-credentials.ts.
import type { AccessCredential, AccessCredentialCreate, AccessCredentialPatch } from "@waste/contracts/site-visits"
import { normaliseCredentialValue } from "@waste/domain/visits/charges"
import { ACCESS_CREDENTIAL_KINDS, type AccessCredentialKind } from "@waste/domain/visits/vocabulary"

import { AGREEMENT_PREFIX, isAgreementRecord, PROPERTY_PREFIX } from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { isPropertyRecord } from "@/lib/data/properties"
import { CREDENTIAL_BLOCKED_KEY, CREDENTIAL_KIND_KEY, CREDENTIAL_KIND_LABELS, CREDENTIAL_VALUE_KEY, credentialStatusOf, SITE_ACCESS_MODULE } from "@/lib/data/site-visits"

import { command, create, get, listAll, patch, type ApiClient } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, stampFacts, typed, webIdOf, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { projectTimezoneOf, wallClockIn } from "./clock"
import { firstDayOut, lastDayIn } from "./planning"
import { projectMoved, projectServerIdOf, refusal } from "./places"
import { nameVia, typedReference, webIdVia } from "./references"
import { customerAdapter } from "./registry"

export const CREDENTIAL_PREFIX = "credential"
export const CREDENTIAL_RECORD_KIND = "Access credential"
const CUSTOMER_PREFIX = "customer"

/** The record's key for the last day in force, as the form spells the end. */
export const CREDENTIAL_LAST_DAY_KEY = "lastDay"

const kept = "A credential's kind, number and holder are what it is: end it and register another"

/** The project's today, on its own clock: the day a credential's status is read on. */
const todayOf = (projectWebId: string, context: MappingContext): string =>
  wallClockIn((context.now ?? new Date()).toISOString(), projectTimezoneOf({ projectIds: [projectWebId] }, context)).slice(0, 10)

export function toAccessCredentialRecord(credential: AccessCredential, context: MappingContext): BusinessRecord {
  const project = context.resolve.byServerId(credential.projectId)
  const projectWebId = project?.id ?? webIdVia(context, "project", credential.projectId)
  const business = credential.customerId !== null
  const holder = business ? nameVia(context, CUSTOMER_PREFIX, credential.customerId ?? "") : nameVia(context, PROPERTY_PREFIX, credential.propertyId ?? "")
  const kind = CREDENTIAL_KIND_LABELS[credential.kind]
  const period = credential.validTo === null ? `From ${credential.validFrom}` : `${credential.validFrom} to ${lastDayIn(credential.validTo)}`
  const facts: Record<string, string> = {
    Kind: kind,
    Number: credential.value,
    ...(credential.label === null ? {} : { Label: credential.label }),
    ...(business ? { Customer: holder, Agreement: nameVia(context, AGREEMENT_PREFIX, credential.agreementId ?? "") } : { Property: holder }),
    "In force": period,
    ...(credential.blockedReason === null ? {} : { "Blocked because": credential.blockedReason }),
    ...(project?.name === undefined ? {} : { Project: project.name }),
  }
  const reference = (prefix: string, serverId: string | null) => (serverId === null ? "" : webIdVia(context, prefix, serverId))
  return {
    id: webIdOf(CREDENTIAL_PREFIX, credential.id),
    name: credential.label === null ? credential.value : `${credential.value} · ${credential.label}`,
    context: `${kind} · ${holder}`,
    status: credentialStatusOf(credential, todayOf(projectWebId, context)),
    ...inheritedPresentation(undefined),
    ...stampFacts(credential, context.now),
    value: period,
    description: business ? "A business's: its visits are charged to the agreement" : "A household's: its visits are counted against the property's year",
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [projectWebId],
    recordKind: CREDENTIAL_RECORD_KIND,
    submittedValues: {
      projectId: projectWebId,
      [CREDENTIAL_KIND_KEY]: credential.kind,
      [CREDENTIAL_VALUE_KEY]: credential.value,
      label: credential.label ?? "",
      customerId: reference(CUSTOMER_PREFIX, credential.customerId),
      agreementId: reference(AGREEMENT_PREFIX, credential.agreementId),
      propertyId: reference(PROPERTY_PREFIX, credential.propertyId),
      validFrom: credential.validFrom,
      [CREDENTIAL_LAST_DAY_KEY]: credential.validTo === null ? "" : lastDayIn(credential.validTo),
      [CREDENTIAL_BLOCKED_KEY]: credential.blockedAt !== null,
    },
  }
}

const isKind = (value: string | undefined): value is AccessCredentialKind => ACCESS_CREDENTIAL_KINDS.includes(value as AccessCredentialKind)

/** The end the record names, as the wire's first day out; null where it names none, or a refusal where it comes before the start. */
function endOf(record: BusinessRecord): string | null | LocalRefusal {
  const last = typed(record, CREDENTIAL_LAST_DAY_KEY)
  if (last === undefined) return null
  const from = typed(record, "validFrom") ?? ""
  return last < from ? refusal(CREDENTIAL_LAST_DAY_KEY, "The last day in force comes on or after the first") : firstDayOut(last)
}

/** `POST /access-credentials` from a record the dialog made: the holder a business's or a household's, every id by the server's. */
export function toAccessCredentialCreateBody(record: BusinessRecord, context: MappingContext): AccessCredentialCreate | LocalRefusal {
  const projectId = projectServerIdOf(record, context)
  if (isLocalRefusal(projectId)) return projectId
  const kind = typed(record, CREDENTIAL_KIND_KEY)
  if (!isKind(kind)) return refusal(CREDENTIAL_KIND_KEY, "Pick a plate or a card")
  const value = normaliseCredentialValue(typed(record, CREDENTIAL_VALUE_KEY) ?? "")
  if (value === "") return refusal(CREDENTIAL_VALUE_KEY, kind === "plate" ? "Type the plate" : "Type the card number")
  const validFrom = typed(record, "validFrom")
  if (validFrom === undefined) return refusal("validFrom", "Pick the first day in force")
  const validTo = endOf(record)
  if (isLocalRefusal(validTo)) return validTo
  const label = typed(record, "label")
  const holder = { label: label ?? null, validFrom, validTo }
  const propertyId = typedReference(record, "propertyId", PROPERTY_PREFIX, context, "Pick a property the API holds", { owns: isPropertyRecord })
  if (isLocalRefusal(propertyId)) return propertyId
  if (propertyId !== undefined) return { projectId, kind, value, propertyId, ...holder }
  const customerId = typedReference(record, "customerId", CUSTOMER_PREFIX, context, "Pick a customer the API holds", { owns: customerAdapter.owns })
  if (isLocalRefusal(customerId)) return customerId
  if (customerId === undefined) return refusal("customerId", "Pick the household's property, or the business and its agreement")
  const agreementId = typedReference(record, "agreementId", AGREEMENT_PREFIX, context, "Pick an agreement the API holds", { owns: isAgreementRecord })
  if (isLocalRefusal(agreementId)) return agreementId
  if (agreementId === undefined) return refusal("agreementId", "Pick the agreement the business's visits are charged to")
  return { projectId, kind, value, customerId, agreementId, ...holder }
}

/** `PATCH /access-credentials/:id`: the label and the end that moved; the rest is the credential's own. */
export function toAccessCredentialPatchBody(before: BusinessRecord, after: BusinessRecord): AccessCredentialPatch | null | LocalRefusal {
  if (projectMoved(before, after)) return refusal("projectId", kept)
  for (const key of [CREDENTIAL_KIND_KEY, CREDENTIAL_VALUE_KEY, "customerId", "agreementId", "propertyId", "validFrom"] as const) {
    if ((typed(after, key) ?? "") !== (typed(before, key) ?? "")) return refusal(key, kept)
  }
  const body: AccessCredentialPatch = {}
  const label = typed(after, "label") ?? null
  if (label !== (typed(before, "label") ?? null)) body.label = label
  const validTo = endOf(after)
  if (isLocalRefusal(validTo)) return validTo
  const was = endOf(before)
  if (validTo !== (isLocalRefusal(was) ? null : was)) body.validTo = validTo
  return Object.keys(body).length === 0 ? null : body
}

/** The commands, each answering the credential as it now stands. */
export const BLOCK_CREDENTIAL = "block"
export const UNBLOCK_CREDENTIAL = "unblock"

export const ACCESS_CREDENTIAL_COMMANDS: Readonly<Record<string, RecordCommand<AccessCredential>>> = {
  [BLOCK_CREDENTIAL]: {
    toBody: (input) => {
      const reason = typeof input.reason === "string" ? input.reason.trim() : ""
      return reason === "" ? refusal("reason", "Say why the credential is blocked") : { reason }
    },
    run: (client, serverId, body) => command<AccessCredential>(client, `/access-credentials/${serverId}/block`, body),
    refused: (record) => `${record.name} was not blocked`,
  },
  [UNBLOCK_CREDENTIAL]: {
    run: (client, serverId) => command<AccessCredential>(client, `/access-credentials/${serverId}/unblock`),
    refused: (record) => `${record.name} was not unblocked`,
  },
}

export const accessCredentialAdapter: ResourceAdapter<AccessCredential> = {
  prefix: CREDENTIAL_PREFIX,
  auditTable: "access_credential",
  // A row the dialog has just made is `site-access-credential-<clock>` until the server answers: owned by its recordKind.
  owns: ofKind(CREDENTIAL_PREFIX, [CREDENTIAL_RECORD_KIND]),
  statuses: undefined,
  list: (client: ApiClient) => listAll<AccessCredential>(client, "/access-credentials"),
  toRecord: toAccessCredentialRecord,
  toCreateBody: toAccessCredentialCreateBody,
  toPatchBody: toAccessCredentialPatchBody,
  create: (client, body) => create<AccessCredential>(client, "/access-credentials", body).then((created) => created.body),
  update: (client, serverId, body) => patch<AccessCredential>(client, `/access-credentials/${serverId}`, body),
  read: (client, serverId) => get<AccessCredential>(client, `/access-credentials/${serverId}`),
  commands: ACCESS_CREDENTIAL_COMMANDS,
}

/** Customers › Site access: read after the customers, the properties and the agreements its rows name, and on the project's day its statuses are read on. */
export const siteAccessModule: ServerModule = {
  workspaceId: SITE_ACCESS_MODULE.workspaceId,
  moduleId: SITE_ACCESS_MODULE.moduleId,
  resources: [accessCredentialAdapter],
  readsTheDay: true,
}
