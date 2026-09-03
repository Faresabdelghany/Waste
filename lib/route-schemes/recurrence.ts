// Route Scheme recurrence engine.
// Pure date math over ISO `yyyy-mm-dd` strings — no UI, store, or fixture
// dependencies — so the scheme form preview and the route generation engine
// share one definition of "which dates does this scheme serve".
//
// Semantics (validated in the prototype on branch prototype/route-schemes):
//   matches(date):
//     date within [effectiveFrom, effectiveTo] (inclusive; empty To = open)
//     weekday(date) ∈ serviceDays
//     every-2-weeks → ISO-week parity of date == the scheme's week rotation
//     once-a-month → dayOfMonth(date) <= 7 (the first occurrence of each
//                    selected weekday in the month)
//   Route identity = (schemeId, serviceDate) — deterministic, so
//   regeneration can upsert instead of duplicating.

export const SERVICE_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const

export type ServiceDay = (typeof SERVICE_DAYS)[number]

export const SERVICE_DAY_SHORT_LABELS: Record<ServiceDay, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
}

export type RecurrenceFrequency = "weekly" | "every-2-weeks" | "monthly"

export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  weekly: "Every week",
  "every-2-weeks": "Every 2 weeks",
  monthly: "Once a month",
}

/**
 * Nominal collections per week each cadence delivers on one service day —
 * the shared scale the reconciliation validation (issue #21) compares scheme
 * recurrence against promised service frequencies on. Monthly is 12
 * collections across a 52-week year, not 1/4: the first-weekday rule serves
 * calendar months. The promise side derives its rate from the interval
 * vocabulary (lib/data/service-frequencies promisedCollectionsPerWeek), so
 * every-N-weeks promises order naturally against these without needing a
 * scheme-cadence counterpart.
 */
export const RECURRENCE_WEEKLY_RATES: Record<RecurrenceFrequency, number> = {
  weekly: 1,
  "every-2-weeks": 1 / 2,
  monthly: 12 / 52,
}

export type WeekRotation = "odd" | "even"

export type SchemeRecurrence = {
  frequency: RecurrenceFrequency
  serviceDays: ServiceDay[]
  /** Which ISO-week parity an every-2-weeks scheme serves. */
  weekRotation?: WeekRotation
  effectiveFrom: string
  /** Empty string = open-ended (the form requires it; the math tolerates it). */
  effectiveTo: string
  /** Planned start time ("06:30"); carried for facts, not used in date math. */
  startTime?: string
}

const parseIso = (iso: string) => new Date(`${iso}T00:00:00Z`)
const toIso = (date: Date) => date.toISOString().slice(0, 10)

export function addDays(iso: string, days: number): string {
  const date = parseIso(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return toIso(date)
}

/** Today as ISO in the browser's local time — the "now" all date pickers seed from. */
export function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

export function serviceDayOf(iso: string): ServiceDay {
  // getUTCDay: 0 = Sunday; SERVICE_DAYS is Monday-first.
  return SERVICE_DAYS[(parseIso(iso).getUTCDay() + 6) % 7]
}

export function isoWeek(iso: string): number {
  const date = parseIso(iso)
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
  const week1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  return (
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 864e5 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7,
    )
  )
}

// Odd/even ISO-week rotations are calendar-anchored, not a strict fortnightly
// cadence: a 53-week ISO year (2026 is one) ends on week 53 (odd) and the next
// year starts on week 1 (odd), so an odd-rotation scheme serves two consecutive
// weeks at that boundary and an even-rotation scheme skips three. That is how
// odd/even-week municipal collection behaves in the real world (the retired
// Collection Weeks module's rotation labels mapped to the same parity); a
// scheme needing an unbroken 14-day cadence across such a boundary needs a
// new scheme version there.
export function isoWeekRotation(iso: string): WeekRotation {
  return isoWeek(iso) % 2 === 1 ? "odd" : "even"
}

export function matchesRecurrence(recurrence: SchemeRecurrence, iso: string): boolean {
  if (recurrence.effectiveFrom && iso < recurrence.effectiveFrom) return false
  if (recurrence.effectiveTo && iso > recurrence.effectiveTo) return false
  if (!recurrence.serviceDays.includes(serviceDayOf(iso))) return false
  if (
    recurrence.frequency === "every-2-weeks" &&
    isoWeekRotation(iso) !== recurrence.weekRotation
  ) {
    return false
  }
  if (recurrence.frequency === "monthly" && parseIso(iso).getUTCDate() > 7) return false
  return true
}

// Open-ended monthly schemes need ~8 months of scanning for an 8-date
// preview; two years bounds the walk for any well-formed recurrence.
const SCAN_LIMIT_DAYS = 731

export function nextServiceDates(
  recurrence: SchemeRecurrence,
  options: { from: string; count: number },
): string[] {
  const dates: string[] = []
  if (recurrence.serviceDays.length === 0 || options.count <= 0) return dates
  let cursor =
    recurrence.effectiveFrom && recurrence.effectiveFrom > options.from
      ? recurrence.effectiveFrom
      : options.from
  for (let step = 0; step < SCAN_LIMIT_DAYS && dates.length < options.count; step += 1) {
    if (recurrence.effectiveTo && cursor > recurrence.effectiveTo) break
    if (matchesRecurrence(recurrence, cursor)) dates.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return dates
}

/**
 * Route identity: (schemeId, serviceDate) for the implicit legacy collection
 * group; explicit groups (D36) append their id, so one date can carry one
 * route per group while every already-generated legacy route keeps its key.
 */
export function routeIdentityKey(
  schemeId: string,
  serviceDate: string,
  groupKey?: string,
): string {
  return groupKey ? `${schemeId}:${serviceDate}:${groupKey}` : `${schemeId}:${serviceDate}`
}

export function formatServiceDate(iso: string): string {
  return parseIso(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
}

export function sortServiceDays(days: readonly ServiceDay[]): ServiceDay[] {
  return [...days].sort((a, b) => SERVICE_DAYS.indexOf(a) - SERVICE_DAYS.indexOf(b))
}

/**
 * The cadence alone — "Every week", "Every 2 weeks (even ISO weeks)",
 * "Once a month" — shared by recurrenceSentence and the schemes list's
 * Recurrence column (issue #30), so the fortnight-rotation copy lives once.
 */
export function recurrenceCadenceLabel(
  recurrence: Pick<SchemeRecurrence, "frequency" | "weekRotation">,
): string {
  const label = RECURRENCE_FREQUENCY_LABELS[recurrence.frequency]
  return recurrence.frequency === "every-2-weeks"
    ? `${label} (${recurrence.weekRotation} ISO weeks)`
    : label
}

export function recurrenceSentence(recurrence: SchemeRecurrence): string {
  if (recurrence.serviceDays.length === 0) return "No service days selected"
  const days = sortServiceDays(recurrence.serviceDays)
    .map((day) => SERVICE_DAY_SHORT_LABELS[day])
    .join(", ")
  if (recurrence.frequency === "monthly") return `Once a month (first ${days} of the month)`
  return `${recurrenceCadenceLabel(recurrence)} on ${days}`
}

export function parseServiceDays(value: string): ServiceDay[] {
  const tokens = value
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token): token is ServiceDay => (SERVICE_DAYS as readonly string[]).includes(token))
  return sortServiceDays([...new Set(tokens)])
}

/**
 * The shared guard for reading a record's structured `serviceDays` out of its
 * submitted form values: the values object may be missing entirely, and the
 * field may hold a non-string in merged or hand-edited stores. Returns []
 * when nothing parses. Calendar working days (`values.workingDays`) keep
 * their own read — different field.
 */
export function serviceDaysFromValues(
  values: Record<string, unknown> | null | undefined,
): ServiceDay[] {
  const raw = values?.serviceDays
  return parseServiceDays(typeof raw === "string" ? raw : "")
}

export const isRecurrenceFrequency = (
  value: unknown,
): value is RecurrenceFrequency =>
  typeof value === "string" && Object.hasOwn(RECURRENCE_FREQUENCY_LABELS, value)

// Shape alone is not enough: "9999-99-99" matches the pattern but parses to
// an Invalid Date, and "2026-02-30" silently rolls over to March — the
// round trip catches both.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const isIsoDate = (value: string) =>
  ISO_DATE_PATTERN.test(value) &&
  !Number.isNaN(parseIso(value).getTime()) &&
  toIso(parseIso(value)) === value

const isRotation = (value: unknown): value is WeekRotation =>
  value === "odd" || value === "even"

/**
 * Reads a scheme's recurrence from its submitted form values (the
 * `route-studio.schemes` field ids, also kept on created records as
 * `submittedValues`). Returns null while the recurrence is still incomplete:
 * no frequency, no service day, no effective-from, or an every-2-weeks
 * frequency without a week rotation.
 */
export function recurrenceFromValues(
  values: Record<string, string | boolean | undefined>,
): SchemeRecurrence | null {
  const frequency = values.frequency
  if (!isRecurrenceFrequency(frequency)) return null
  const serviceDays = serviceDaysFromValues(values)
  if (serviceDays.length === 0) return null
  const effectiveFrom = typeof values.effectiveFrom === "string" ? values.effectiveFrom : ""
  // Malformed dates (possible in hand-edited or corrupted submittedValues)
  // must not reach the date walk — an invalid cursor would throw mid-render.
  if (!isIsoDate(effectiveFrom)) return null
  const effectiveTo = typeof values.effectiveTo === "string" ? values.effectiveTo : ""
  if (effectiveTo && !isIsoDate(effectiveTo)) return null
  const weekRotation = isRotation(values.weekRotation) ? values.weekRotation : undefined
  if (frequency === "every-2-weeks" && !weekRotation) return null
  return {
    frequency,
    serviceDays,
    ...(frequency === "every-2-weeks" ? { weekRotation } : {}),
    effectiveFrom,
    effectiveTo,
    ...(typeof values.plannedStartTime === "string" && values.plannedStartTime
      ? { startTime: values.plannedStartTime }
      : {}),
  }
}
