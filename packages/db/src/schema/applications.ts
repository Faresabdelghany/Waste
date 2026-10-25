// Applications and their Decisions (M7 of #293,
// @waste/domain/registry/applications): a customer's written request to
// change how they are served or billed, and the office's verdict on it.
//
// `application` is current state, moved by command (APPLICATION_MOVES): its
// kind, how it reached the office and when, the applicant's own words, and
// its subject — the customer, and the property or the shared collection
// point and the subscription it concerns where it names them, one place at
// most. Its `number` is the company's running count, what a letter quotes,
// taken as the highest plus one under the company's row lock rather than a
// counter on the company, whose audit trigger would otherwise need writing
// again. Whether a decision is in force is a reading of its period, never a
// status.
//
// `application_decision` is a ledger: each Decision appended once, the
// latest the one in force, so an appeal that reopens the Application and is
// decided again keeps the first beside the second. A grant names its first
// day in force, a refusal no period at all, and anything less than a grant
// in full says how to appeal it — the domain's rules, held here too. The
// period is `granted_from`/`granted_to`, never `valid_from`: that name is an
// effective-dated row's, one in force per key under an exclusion constraint,
// where a decision is history and an appeal's overlaps the first's by design
// (the wire calls them validFrom and validTo, a grant's half-open period).
import { APPLICATION_CHANNELS, APPLICATION_KINDS, APPLICATION_STATUSES, DECISION_OUTCOMES } from "@waste/domain/registry/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, index, integer, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { subscription } from "./agreements"
import { oneOf } from "./checks"
import { id, projectScoped, recorded, timestamps } from "./columns"
import { customer, property, sharedCollectionPoint } from "./customers"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const application = wms.table(
  "application",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The company's running count, what a decision letter quotes. */
    number: integer().notNull(),
    kind: text().notNull(),
    status: text().notNull().default("received"),
    channel: text().notNull(),
    receivedOn: date().notNull(),
    customerId: uuid().notNull(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    subscriptionId: uuid(),
    /** What the customer asks, in their own words or the office's note of them. */
    statement: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.customerId], customer),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    projectReference(t, [t.subscriptionId], subscription),
    projectKey(t),
    tenantUnique(t, t.number),
    oneOf(t.kind, APPLICATION_KINDS),
    oneOf(t.status, APPLICATION_STATUSES),
    oneOf(t.channel, APPLICATION_CHANNELS),
    check(tableObjectName(t.id.table, "one_place", "application"), sql`${t.propertyId} is null or ${t.sharedCollectionPointId} is null`),
    check(tableObjectName(t.id.table, "statement_given", "application"), sql`length(btrim(${t.statement})) > 0`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.subscriptionId),
  ],
)

export const applicationDecision = wms.table(
  "application_decision",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    applicationId: uuid().notNull(),
    outcome: text().notNull(),
    /** What the grant holds the customer to, or why it was refused. */
    conditions: text(),
    /** The first day a grant is in force; null for a refusal. */
    grantedFrom: date(),
    /** A grant's first day out of force; null while it runs, and for a refusal. */
    grantedTo: date(),
    /** How to appeal: given for anything less than a grant in full. */
    appealText: text(),
    decidedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.applicationId], application),
    tenantReference(t, [t.decidedBy], userAccount),
    oneOf(t.outcome, DECISION_OUTCOMES),
    // A refusal is in force for no period; a grant names its first day, and its end, where given, comes after it (ADR-0005).
    check(
      tableObjectName(t.id.table, "period_shape", "applicationDecision"),
      sql`case when ${t.outcome} = 'refused' then ${t.grantedFrom} is null and ${t.grantedTo} is null else ${t.grantedFrom} is not null and (${t.grantedTo} is null or ${t.grantedTo} > ${t.grantedFrom}) end`,
    ),
    check(tableObjectName(t.id.table, "appeal_shape", "applicationDecision"), sql`${t.outcome} = 'granted' or length(btrim(coalesce(${t.appealText}, ''))) > 0`),
    // The decisions of an application in the order they were made, the latest first read.
    index(tableObjectName(t.companyId.table, "application_id_idx", "applicationDecision")).on(t.companyId, t.applicationId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.decidedBy),
  ],
)
