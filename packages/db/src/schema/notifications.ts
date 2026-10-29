// A staff member's notification preferences (O16 of #290): which events they
// are told about by e-mail, one row per user account and event, its presence
// the opt-in — nobody is told anything they have not asked for (the
// coordinator's default on #351, pending the owner's review). An alert's
// preference carries the lowest severity it reaches the person at
// (`notification_preference_min_severity_shape`: an alert's always, a
// ticket's never). A person's set is replaced whole through
// `PUT /me/notification-preferences`, and audited as their account's.
import { ALERT_SEVERITIES } from "@waste/domain/resolution/vocabulary"
import { NOTIFICATION_EVENTS } from "@waste/domain/notifications/vocabulary"
import { sql } from "drizzle-orm"
import { check, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf } from "./checks"
import { id, tenant, timestamps } from "./columns"
import { company } from "./organisation"
import { companyReference, tenantReference, tenantUnique } from "./references"
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
