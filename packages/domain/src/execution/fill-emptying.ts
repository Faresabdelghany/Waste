// The fill-driven emptying (O26 of #290, row 9.10): when a container's
// Sensor reads it at or past its pairing's full threshold and the pairing
// asks for it, the worker books an office emptying of the container ahead of
// its next scheduled one — on a route that already runs its way, so no route
// is invented and no vehicle is sent across town for one bin.
//
// Which route, decided here from what the worker read: the container's next
// emptying of generation's still planned, and the routes of the same scheme
// and collection group — the group that collects it — planned or ready,
// operating from today up to, and not on, that day. Nothing is booked when
// the next emptying is within `FILL_EMPTYING_LEAD_DAYS` (it comes soon
// enough), when generation plans no emptying of it (there is no round to
// bring forward), or when no such route runs before it. The earliest route
// is taken, ties by id, so two ticks choose the same one.
//
// Days are `YYYY-MM-DD` strings on the project's clock, which compare as
// days.

/** The days ahead within which the next scheduled emptying is soon enough: today or tomorrow books nothing. */
export const FILL_EMPTYING_LEAD_DAYS = 1

/** A route as the choice reads it. */
export type EmptyingRoute = { id: string; label: string; operatingDate: string; routeSchemeId: string | null; collectionGroupId: string | null }

/** What the choice came to. */
export type FillEmptyingChoice =
  | { kind: "book"; route: EmptyingRoute }
  | { kind: "soon-enough"; next: EmptyingRoute }
  | { kind: "no-schedule" }
  | { kind: "no-route"; next: EmptyingRoute }

const DAY_MS = 24 * 60 * 60 * 1000
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

/** The route the fill-driven emptying goes on, or why none, from the container's next scheduled emptying and the routes that might take it. */
export function fillEmptyingRoute(next: EmptyingRoute | null, candidates: readonly EmptyingRoute[], today: string): FillEmptyingChoice {
  if (next === null) return { kind: "no-schedule" }
  if (daysBetween(today, next.operatingDate) <= FILL_EMPTYING_LEAD_DAYS) return { kind: "soon-enough", next }
  const [route] = candidates
    .filter(
      (candidate) =>
        candidate.id !== next.id &&
        candidate.routeSchemeId === next.routeSchemeId &&
        candidate.collectionGroupId === next.collectionGroupId &&
        candidate.operatingDate >= today &&
        candidate.operatingDate < next.operatingDate,
    )
    .sort((a, b) => (a.operatingDate === b.operatingDate ? (a.id < b.id ? -1 : 1) : a.operatingDate < b.operatingDate ? -1 : 1))
  return route === undefined ? { kind: "no-route", next } : { kind: "book", route }
}

/** What booking came to, as the alert tells it: booked, refused on the route chosen (its vehicle, its placement), or one of the choice's reasons for none. */
export type FillEmptyingOutcome =
  | { kind: "booked"; route: EmptyingRoute }
  | { kind: "refused"; route: EmptyingRoute; reason: string }
  | Exclude<FillEmptyingChoice, { kind: "book" }>

/** The sentence the alert ends with: what the worker did about the filling. */
export function emptyingSentence(outcome: FillEmptyingOutcome): string {
  switch (outcome.kind) {
    case "booked":
      return `An emptying is booked on ${outcome.route.label} on ${outcome.route.operatingDate}.`
    case "refused":
      return `No emptying is booked on ${outcome.route.label}: ${outcome.reason}.`
    case "soon-enough":
      return `No emptying is booked: its next emptying is on ${outcome.next.label} on ${outcome.next.operatingDate}.`
    case "no-route":
      return `No emptying is booked: no route of its round runs before its next emptying on ${outcome.next.operatingDate}.`
    case "no-schedule":
      return "No emptying is booked: no emptying of it is planned to bring forward."
  }
}
