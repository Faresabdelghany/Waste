// What a project's notification rules hold to (C18 of #291): each customer
// notice sent from one template, and only a broadcast — a route cancelled or
// late — narrowed to areas, a handful of them, each once.

/** What a set naming one notice twice is told. */
export const ONE_RULE_PER_NOTICE = "A notice is sent from one template; name each notice once"

/** What a rule naming areas for a notice that is not a broadcast is told. */
export const AREAS_ARE_A_BROADCASTS = "Only a route cancelled or late is narrowed to areas; this notice goes to its own customer"

/** The most areas a broadcast names: a project's notification zones, a handful. */
export const NOTICE_AREAS_MAX = 50

/** What a rule naming an area twice is told. */
export const EACH_AREA_ONCE = "Name each area once"
