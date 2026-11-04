// A staff member's notification preferences (O16 of #290): which events they
// are told about by e-mail, one row per user account and event, its presence
// the opt-in — nobody is told anything they have not asked for (the
// coordinator's default on #351, pending the owner's review). An alert's
// preference carries the lowest severity it reaches the person at
// (`notification_preference_min_severity_shape`: an alert's always, a
// ticket's never). A person's set is replaced whole through
// `PUT /me/notification-preferences`, and audited as their account's.
//
// A project's notification rules (part b) map a customer notice — a Bulky
// Booking booked, cancelled, collected or not collected — to the message
// template it is sent from, one rule per project and event, its presence the
// opt-in: there is no default text (the coordinator's default on #351). The
// template is the project's own (`projectReference`); that it is active and
// for service is the API's rule at the write, and the worker's send honours
// the customer's consent. The set is replaced whole through
// `PUT /projects/:id/notification-rules`, and audited as the project's.
//
// C18 of #291 adds the service notifications as rows of the same rules, and
// `notification_rule_area`: the `notification` planning areas a broadcast's
// rule — a route cancelled or late — narrows its customers to, those whose
// stop lies inside one of them; a broadcast rule naming none reaches every
// stop of the route. That an area is a `notification` area and that only a
// broadcast's rule names one are the API's rules at the write; the set is
// replaced with its rule, and audited as the project's.
import { ALERT_SEVERITIES } from "@waste/domain/resolution/vocabulary"
import { CUSTOMER_NOTICE_EVENTS, NOTIFICATION_EVENTS } from "@waste/domain/notifications/vocabulary"
import { sql } from "drizzle-orm"
import { check, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf } from "./checks"
import { id, projectScoped, tenant, timestamps } from "./columns"
import { messageTemplate } from "./messaging"
import { company, project } from "./organisation"
import { planningArea } from "./planning-areas"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const notificationPreference = wms.table(
  "notification_preference",
  {
    ...id,
    ...tenant,
    ...timestamps,
    userAccountId: uuid().notNull(),
    event: text().notNull(),
    /** For `alert-raised`: the lowest severity the person is told of. */
    minSeverity: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.userAccountId], userAccount),
    tenantUnique(t, t.userAccountId, t.event),
    oneOf(t.event, NOTIFICATION_EVENTS),
    oneOf(t.minSeverity, ALERT_SEVERITIES),
    check(tableObjectName(t.id.table, "min_severity_shape", "notificationPreference"), sql`(${t.event} = 'alert-raised') = (${t.minSeverity} is not null)`),
  ],
)

export const notificationRule = wms.table(
  "notification_rule",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    event: text().notNull(),
    /** The project's template the notice is sent from. */
    templateId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.templateId], messageTemplate),
    projectKey(t),
    tenantUnique(t, t.projectId, t.event),
    tenantIndex(t, t.templateId),
    oneOf(t.event, CUSTOMER_NOTICE_EVENTS),
  ],
)

export const notificationRuleArea = wms.table(
  "notification_rule_area",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ruleId: uuid().notNull(),
    planningAreaId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.ruleId], notificationRule),
    projectReference(t, [t.planningAreaId], planningArea),
    tenantUnique(t, t.ruleId, t.planningAreaId),
    tenantIndex(t, t.planningAreaId),
  ],
)
