// `notification_rule` as 0084 (O16 of #290, part b) left it: a project's
// bookings' notices alone, before the service notifications (C18 of #291,
// migration 0085) grew its events and gave it the project key its areas
// reference it by. booking-notices-rendering.test.ts diffs to this spelling
// and service-notifications-rendering.test.ts from it, since an applied file
// is never edited and the schema module spells the table as it is today.
import { uuid, text } from "drizzle-orm/pg-core"

import { oneOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { messageTemplate } from "../schema/messaging"
import { company, project } from "../schema/organisation"
import { companyReference, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { wms } from "../schema/wms"

/** The notices as of 0084: a Bulky Booking's four. */
export const CUSTOMER_NOTICE_EVENTS_AS_OF_0084 = ["bulky-booking-booked", "bulky-booking-cancelled", "bulky-booking-collected", "bulky-booking-not-collected"] as const

export const notificationRuleAsOf0084 = wms.table(
  "notification_rule",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    event: text().notNull(),
    templateId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.templateId], messageTemplate),
    tenantUnique(t, t.projectId, t.event),
    tenantIndex(t, t.templateId),
    oneOf(t.event, CUSTOMER_NOTICE_EVENTS_AS_OF_0084),
  ],
)
