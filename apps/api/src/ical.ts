// An iCalendar feed (RFC 5545) of all-day events (Issue #293, M2): what a
// resident subscribes to from an address's collection days. An all-day event
// is a date and no time (`VALUE=DATE`), the same day wherever the calendar
// shows it, so no VTIMEZONE is needed; the project's timezone rides along as
// `X-WR-TIMEZONE` for the clients that read it, and the one instant, the
// stamp, is UTC. Each event's UID is stable across reads, so a calendar that
// fetches the feed again moves a shifted day rather than adding another.
//
// Text is escaped (backslash, semicolon, comma, new line) and every line is
// folded at 75 octets, continuation lines beginning with a space, and ended
// with CRLF, as the RFC asks.

/**
 * One all-day event: a day, what it says, and whether it is a day that will
 * not happen. `sequence` is 0 for the event as first planned and 1 once it is
 * moved or cancelled, so a client that keeps the higher revision of a UID
 * takes the change.
 */
export type CalendarEvent = { uid: string; date: string; summary: string; description: string | null; cancelled: boolean; sequence: number }

export type Calendar = { name: string; timezone: string; events: readonly CalendarEvent[]; now: Date }

/** The media type a feed answers with. */
export const CALENDAR_MEDIA_TYPE = "text/calendar; charset=utf-8"

const escapeText = (text: string): string => text.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n")

const basicDate = (iso: string): string => iso.replaceAll("-", "")

const nextDay = (iso: string): string => {
  const [year, month, day] = iso.split("-").map(Number)
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1)).toISOString().slice(0, 10)
}

const stampOf = (at: Date): string => `${at.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`

const encoder = new TextEncoder()

/** One content line folded at 75 octets: never inside a character, continuation lines indented by one space. */
export function fold(line: string): string {
  const parts: string[] = []
  let current = ""
  let octets = 0
  for (const character of line) {
    const size = encoder.encode(character).length
    const limit = parts.length === 0 ? 75 : 74
    if (octets + size > limit) {
      parts.push(current)
      current = ""
      octets = 0
    }
    current += character
    octets += size
  }
  parts.push(current)
  return parts.join("\r\n ")
}

/** The feed, CRLF-terminated. */
export function icsOf({ name, timezone, events, now }: Calendar): string {
  const stamp = stampOf(now)
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Waste//Collection days//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${escapeText(timezone)}`,
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${event.sequence}`,
      `DTSTART;VALUE=DATE:${basicDate(event.date)}`,
      `DTEND;VALUE=DATE:${basicDate(nextDay(event.date))}`,
      `SUMMARY:${escapeText(event.summary)}`,
      ...(event.description === null ? [] : [`DESCRIPTION:${escapeText(event.description)}`]),
      ...(event.cancelled ? ["STATUS:CANCELLED"] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ]
  return `${lines.map(fold).join("\r\n")}\r\n`
}
