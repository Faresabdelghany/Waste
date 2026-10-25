// Customers › Applications on the API (M7 of #293): a customer's request and
// the office's Decision on it, `application-<uuid>` from the start. The
// record reads the latest Decision beside the Application — its outcome,
// where its period stands on the project's day, its conditions and appeal
// text — and names the customer, the place and the subscription through the
// store's resolver. The status moves by command alone (review, decide,
// withdraw, reopen), so the adapter lists no statuses; a patch corrects an
// undecided Application's own fields, never its project or customer. The
// words are lib/data/applications.ts'; the routes are
// apps/api/src/routes/applications.ts.
import type { Application, ApplicationCreate, ApplicationPatch, Decision, DecisionHistory } from "@waste/contracts/applications"
import { applicationReading } from "@waste/domain/registry/applications"
import { APPLICATION_CHANNELS, APPLICATION_KINDS } from "@waste/domain/registry/vocabulary"

import { APPLICATION_SERVER_ID_KEY, APPLICATION_STATUS_KEY, APPLICATIONS_MODULE, channelLabel, dayOf, DECISION_KEY, decideBodyOf, kindLabel, outcomeLabel, periodText, type RecordedDecision } from "@/lib/data/applications"
import { PROPERTY_PREFIX, SHARED_POINT_PREFIX, SUBSCRIPTION_PREFIX, isSubscriptionRecord } from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { isPropertyRecord, isSharedPointRecord } from "@/lib/data/properties"

import { command, create, get, listAll, patch, type ApiClient } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, stampFacts, statusLabel, typed, webIdOf, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { dayIn } from "./planning"
import { projectMoved, projectServerIdOf, refusal, requiredText, tokenOf } from "./places"
import { nameVia, typedReference, webIdVia } from "./references"
import { customerAdapter } from "./registry"

export const APPLICATION_PREFIX = "application"
export const APPLICATION_RECORD_KIND = "Application"
const CUSTOMER_PREFIX = "customer"

/** The form's keys for the subject, each a web id. */
const SUBJECT_KEYS = { customerId: CUSTOMER_PREFIX, propertyId: PROPERTY_PREFIX, sharedCollectionPointId: SHARED_POINT_PREFIX, subscriptionId: SUBSCRIPTION_PREFIX } as const

export const ONE_PLACE = "An application names a property or a shared collection point, not both"
const customerKept = "An application stays with its customer: record another application for another customer"
const projectKept = "An application stays in its project: record another application in the other project"

/** The decided Application's reading on the project's day: "Granted · in force", "Refused", or its status where undecided. */
function readingOf(application: Application, context: MappingContext, timezone: string | undefined): string {
  const day = dayIn(context.now ?? new Date(), timezone)
  return applicationReading(application.status, application.decision, day)
}

export function toApplicationRecord(application: Application, context: MappingContext): BusinessRecord {
  const project = context.resolve.byServerId(application.projectId)
  const projectWebId = project?.id ?? webIdVia(context, "project", application.projectId)
  const timezone = project === undefined ? undefined : typed(project, "timezone")
  const customer = nameVia(context, CUSTOMER_PREFIX, application.customerId)
  const place =
    application.propertyId !== null ? nameVia(context, PROPERTY_PREFIX, application.propertyId) : application.sharedCollectionPointId !== null ? nameVia(context, SHARED_POINT_PREFIX, application.sharedCollectionPointId) : undefined
  const reading = readingOf(application, context, timezone)
  const decision = application.decision
  const facts: Record<string, string> = {
    Number: String(application.number),
    Kind: kindLabel(application.kind),
    Channel: channelLabel(application.channel),
    Received: application.receivedOn,
    Customer: customer,
    ...(application.propertyId !== null ? { Property: place ?? "" } : {}),
    ...(application.sharedCollectionPointId !== null ? { "Shared point": place ?? "" } : {}),
    ...(application.subscriptionId !== null ? { Subscription: nameVia(context, SUBSCRIPTION_PREFIX, application.subscriptionId) } : {}),
    Decision: decision === null ? "Not decided" : reading,
    ...(project?.name === undefined ? {} : { Project: project.name }),
  }
  if (decision !== null) {
    facts.Outcome = outcomeLabel(decision.outcome)
    if (decision.validFrom !== null) facts["In force"] = periodText(decision.validFrom, decision.validTo)
    if (decision.conditions !== null) facts.Conditions = decision.conditions
    if (decision.appealText !== null) facts["How to appeal"] = decision.appealText
  }
  const decidedOn = decision === null ? "" : dayIn(new Date(decision.decidedAt), timezone)
  if (decision !== null) facts.Decided = decidedOn
  const recorded: RecordedDecision | null =
    decision === null ? null : { id: decision.id, outcome: decision.outcome, conditions: decision.conditions, validFrom: decision.validFrom, validTo: decision.validTo, appealText: decision.appealText, decidedOn }
  const subject = (key: keyof typeof SUBJECT_KEYS) => (application[key] === null ? "" : webIdVia(context, SUBJECT_KEYS[key], application[key] as string))
  return {
    id: webIdOf(APPLICATION_PREFIX, application.id),
    name: `Application ${application.number} · ${kindLabel(application.kind)}`,
    context: [customer, place].filter((part) => part !== undefined).join(" · "),
    status: statusLabel(application.status),
    ...inheritedPresentation(undefined),
    ...stampFacts(application, context.now),
    value: reading,
    description: application.statement,
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [projectWebId],
    recordKind: APPLICATION_RECORD_KIND,
    submittedValues: {
      projectId: projectWebId,
      number: String(application.number),
      kind: application.kind,
      channel: application.channel,
      receivedOn: application.receivedOn,
      customerId: subject("customerId"),
      propertyId: subject("propertyId"),
      sharedCollectionPointId: subject("sharedCollectionPointId"),
      subscriptionId: subject("subscriptionId"),
      statement: application.statement,
      [APPLICATION_STATUS_KEY]: application.status,
      [APPLICATION_SERVER_ID_KEY]: application.id,
      [DECISION_KEY]: recorded === null ? "" : JSON.stringify(recorded),
    },
  }
}

/** The subject the form names, by server id: the customer required, the places and the subscription where given, one place at most. */
function subjectOf(record: BusinessRecord, context: MappingContext): { customerId?: string; propertyId: string | null; sharedCollectionPointId: string | null; subscriptionId: string | null } | LocalRefusal {
  const customerId = typedReference(record, "customerId", CUSTOMER_PREFIX, context, "Pick a customer the API holds", { owns: customerAdapter.owns })
  if (isLocalRefusal(customerId)) return customerId
  const propertyId = typedReference(record, "propertyId", PROPERTY_PREFIX, context, "Pick a property the API holds", { owns: isPropertyRecord })
  if (isLocalRefusal(propertyId)) return propertyId
  const sharedCollectionPointId = typedReference(record, "sharedCollectionPointId", SHARED_POINT_PREFIX, context, "Pick a shared point the API holds", { owns: isSharedPointRecord })
  if (isLocalRefusal(sharedCollectionPointId)) return sharedCollectionPointId
  if (propertyId !== undefined && sharedCollectionPointId !== undefined) return refusal("sharedCollectionPointId", ONE_PLACE)
  const subscriptionId = typedReference(record, "subscriptionId", SUBSCRIPTION_PREFIX, context, "Pick a subscription the API holds", { owns: isSubscriptionRecord })
  if (isLocalRefusal(subscriptionId)) return subscriptionId
  return { customerId, propertyId: propertyId ?? null, sharedCollectionPointId: sharedCollectionPointId ?? null, subscriptionId: subscriptionId ?? null }
}

const KIND_REFUSED = "Pick what the customer applies for"
const CHANNEL_REFUSED = "Pick how the application reached the office"

export function toApplicationCreateBody(record: BusinessRecord, context: MappingContext): ApplicationCreate | LocalRefusal {
  const projectId = projectServerIdOf(record, context)
  if (isLocalRefusal(projectId)) return projectId
  const kind = tokenOf(record, "kind", APPLICATION_KINDS, "kind", "an application") ?? refusal("kind", KIND_REFUSED)
  if (isLocalRefusal(kind)) return kind
  const channel = tokenOf(record, "channel", APPLICATION_CHANNELS, "channel", "an application") ?? refusal("channel", CHANNEL_REFUSED)
  if (isLocalRefusal(channel)) return channel
  const receivedOn = dayOf(typed(record, "receivedOn"))
  if (receivedOn === undefined) return refusal("receivedOn", "Pick the day the application reached the office")
  const subject = subjectOf(record, context)
  if (isLocalRefusal(subject)) return subject
  if (subject.customerId === undefined) return refusal("customerId", "Pick the customer who applies")
  const statement = requiredText(record, "statement", "An application", "the customer's statement")
  if (isLocalRefusal(statement)) return statement
  return {
    projectId,
    kind: kind as ApplicationCreate["kind"],
    channel: channel as ApplicationCreate["channel"],
    receivedOn,
    customerId: subject.customerId,
    ...(subject.propertyId === null ? {} : { propertyId: subject.propertyId }),
    ...(subject.sharedCollectionPointId === null ? {} : { sharedCollectionPointId: subject.sharedCollectionPointId }),
    ...(subject.subscriptionId === null ? {} : { subscriptionId: subject.subscriptionId }),
    statement,
  }
}

export function toApplicationPatchBody(before: BusinessRecord, after: BusinessRecord, context: MappingContext): ApplicationPatch | null | LocalRefusal {
  if (projectMoved(before, after)) return refusal("projectId", projectKept)
  if ((typed(after, "customerId") ?? "") !== (typed(before, "customerId") ?? "")) return refusal("customerId", customerKept)
  const read = toApplicationCreateBody(after, context)
  if (isLocalRefusal(read)) return read
  const was = toApplicationCreateBody(before, context)
  const patch: ApplicationPatch = {}
  const moved = <K extends keyof ApplicationCreate>(key: K) => isLocalRefusal(was) || (was[key] ?? null) !== (read[key] ?? null)
  if (moved("kind")) patch.kind = read.kind
  if (moved("channel")) patch.channel = read.channel
  if (moved("receivedOn")) patch.receivedOn = read.receivedOn
  if (moved("statement")) patch.statement = read.statement
  if (moved("propertyId")) patch.propertyId = read.propertyId ?? null
  if (moved("sharedCollectionPointId")) patch.sharedCollectionPointId = read.sharedCollectionPointId ?? null
  if (moved("subscriptionId")) patch.subscriptionId = read.subscriptionId ?? null
  return Object.keys(patch).length === 0 ? null : patch
}

/** The commands, each answering the Application as it now stands. */
export const REVIEW = "review"
export const DECIDE = "decide"
export const WITHDRAW = "withdraw"
export const REOPEN = "reopen"

const bare = (name: string, refused: string): RecordCommand<Application> => ({
  run: (client, serverId) => command<Application>(client, `/applications/${serverId}/${name}`),
  refused: (record) => `${record.name} ${refused}`,
})

export const APPLICATION_COMMANDS: Readonly<Record<string, RecordCommand<Application>>> = {
  [REVIEW]: bare(REVIEW, "was not taken into review"),
  [WITHDRAW]: bare(WITHDRAW, "was not withdrawn"),
  [REOPEN]: bare(REOPEN, "was not reopened"),
  [DECIDE]: {
    toBody: (input) => decideBodyOf(input as Record<string, string>),
    run: (client, serverId, body) => command<Application>(client, `/applications/${serverId}/decide`, body),
    refused: (record) => `${record.name} was not decided`,
  },
}

/** An Application's Decisions, oldest first: the first and each an appeal led to. */
export const applicationDecisions = (client: ApiClient, serverId: string): Promise<Decision[]> => get<DecisionHistory>(client, `/applications/${serverId}/decisions`).then((history) => history.items)

export const applicationAdapter: ResourceAdapter<Application> = {
  prefix: APPLICATION_PREFIX,
  auditTable: "application",
  // A row the workspace has just made is `applications-application-<clock>` until the server answers: owned by its form's recordKind.
  owns: ofKind(APPLICATION_PREFIX, [APPLICATION_RECORD_KIND]),
  statuses: undefined,
  list: (client) => listAll<Application>(client, "/applications"),
  toRecord: toApplicationRecord,
  toCreateBody: toApplicationCreateBody,
  toPatchBody: toApplicationPatchBody,
  create: (client, body) => create<Application>(client, "/applications", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Application>(client, `/applications/${serverId}`, body),
  read: (client, serverId) => get<Application>(client, `/applications/${serverId}`),
  commands: APPLICATION_COMMANDS,
}

/** Customers › Applications: read after the customers, the places and the agreements their subjects name. */
export const applicationsModule: ServerModule = {
  workspaceId: APPLICATIONS_MODULE.workspaceId,
  moduleId: APPLICATIONS_MODULE.moduleId,
  resources: [applicationAdapter],
}
