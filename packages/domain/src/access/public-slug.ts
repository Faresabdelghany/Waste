// The public slug (Issue #293, M1, ADR-0010): the name a Project publishes
// itself under on the public door, `/public/<slug>`, and the citizen pages'
// `/p/<slug>`. Lowercase words of letters and digits joined by single
// hyphens, so it is a URL path segment as typed, and unique across every
// company, since one public address names one project. The database's CHECK
// and the contracts' regex read the one spelling here.

/** The shape a public slug takes, as a regular expression's source. */
export const PUBLIC_SLUG_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$"

/** The shortest and longest slug: three letters reads as a name, and 63 is a DNS label's limit, should a project ever be its own host. */
export const PUBLIC_SLUG_LENGTH = { min: 3, max: 63 } as const

/** Whether a text is a slug a project may publish under. */
export function isPublicSlug(text: string): boolean {
  return text.length >= PUBLIC_SLUG_LENGTH.min && text.length <= PUBLIC_SLUG_LENGTH.max && new RegExp(PUBLIC_SLUG_PATTERN).test(text)
}
