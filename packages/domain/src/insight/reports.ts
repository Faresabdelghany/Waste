// The window of days a report reads (#292): at most a year, both ends
// inclusive, and none of its days before the first this system knows.

/** The longest window a report reads: a year, a leap year's included. */
export const REPORT_WINDOW_MAX_DAYS = 366

/** What a window longer than that is told. */
export const REPORT_WINDOW_TOO_LONG = `A report's window is at most ${REPORT_WINDOW_MAX_DAYS} days; ask for a year at a time`

/** The first day a report reads: Postgres has no year 0, and nothing this system records is older. */
export const REPORT_FIRST_DAY = "2000-01-01"

/** What a day before it is told. */
export const REPORT_DAY_TOO_EARLY = `A report reads days from ${REPORT_FIRST_DAY} on`
