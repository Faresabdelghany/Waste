// The one link between an Alert and a Ticket (Issue #109 §7.17), as apps/api
// reads it: `linkAlert` lives in `@waste/db/commands/alert-links` since part
// B, because `openTicket` runs it for the `alertId` a ticket create names and
// `openTicket` moved to where both processes read it. Two doors still set
// `alert.ticket_id` — `POST /tickets` with `alertId`, inside `openTicket`,
// and `POST /alerts/:id/link-ticket` (routes/alerts.ts) — and an alert is
// held to the same three rules whichever it came through: it is an alert of
// the project (a 400 at the field, `NOT_AN_ALERT`, the sentence
// routes/references.ts's `requireAlert` answered before the move), it is not
// resolved (409, the domain's sentence) and it names no other ticket (409,
// `linkedToAnother`, naming the one it names by its label). The statement
// throws the shared `Refused`, which the error handler (problem.ts) answers
// as the problem of its status, so the two routes answer what they always
// answered: the 400 at `alertId`, the 409s with their sentences.
export { findAlert, linkAlert, linkedToAnother, NOT_AN_ALERT, type Scope as LinkScope } from "@waste/db/commands/alert-links"
