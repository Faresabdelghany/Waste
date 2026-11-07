// A drafted route's road preview (#173): the points in driving order — the
// depot, the stops, the unloading station — measured by the routing
// provider, at least two and at most a route's stops and its two ends.

/** The fewest points a preview measures: one leg. */
export const PREVIEW_POINTS_MIN = 2

/** The points a preview takes beside a route's stops: its depot and its station. */
export const PREVIEW_ENDS = 2

export const PREVIEW_NEEDS_TWO_POINTS = "a preview needs two points or more"

/** What a preview past its most points is told, the route's most stops named. */
export const previewTakesAtMost = (points: number, stops: number): string => `a preview takes at most ${points} points: a route's ${stops} stops, its depot and its station`
