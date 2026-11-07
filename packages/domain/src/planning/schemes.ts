// What a Route Scheme's body holds to, wherever it is judged: a create and a
// patch at the boundary, and the route that holds a patch's half against the
// stored row. A scheme recurs on its service days at its cadence, its groups
// run on days it serves and find their stops one way each, and the window an
// occurrence read or a generation run walks is at most a year.
import { SERVICE_DAYS } from "../days"
import { eachOnceSentence } from "../requests"

/**
 * The most a set of a scheme may carry — a group's containers, a rule's
 * fractions and container types: a form's list, not an import. A group's
 * container list is unbounded on the resource, since a set already stored
 * has to read back however long it grew.
 */
export const CONTAINERS_MAX = 200

/**
 * The most collection groups a scheme may be created with. Each group may
 * pick two hundred containers, so a body of fifty is ten thousand rows across
 * one statement per set; a scheme with more groups than that is an import,
 * not a form, and a body past it would run into Postgres's bind-parameter
 * ceiling before it ran into anything of ours.
 */
export const GROUPS_MAX = 50
export const AT_MOST_GROUPS = `A scheme has at most ${GROUPS_MAX} collection groups`
/** What a patch's list past the bound is told: the bound is the create's, and a scheme that has grown past it one group at a time is edited that way too. */
export const AT_MOST_GROUPS_RESTATED = `An edit restates at most ${GROUPS_MAX} collection groups; a scheme with more is edited through its groups' own routes`

export const EACH_FRACTION_ONCE = eachOnceSentence("waste fraction", "a rule matches a fraction or it does not")
export const EACH_CONTAINER_TYPE_ONCE = eachOnceSentence("container type", "a rule is restricted to a type or it is not")
export const EACH_CONTAINER_ONCE = eachOnceSentence("container", "a container has one place in the group's stop order")

/** What a group whose source and stops disagree is told: a rule group carries a rule and no containers, a manual group containers and no rule. */
export const ONE_WAY_TO_FIND_STOPS = "A collection group matches by rule or picks containers, never both"

type Recurrence = { frequency?: string; weekRotation?: string | null; serviceDays?: readonly string[] }

/** What a rotation given with the wrong cadence, or missing with the right one, is told. */
export const WEEK_ROTATION_WITH_FORTNIGHTLY = "Give weekRotation with every-2-weeks and with nothing else"

/**
 * The week rotation belongs to the fortnightly cadence and to no other. A
 * half-seen pair is not judged — that is a patch giving one of the two, and
 * only the route, which has the stored row, can hold the two together.
 */
export function weekRotationShape(value: Recurrence): boolean {
  const { frequency, weekRotation } = value
  if (frequency === undefined || weekRotation === undefined) return true
  return (frequency === "every-2-weeks") === (weekRotation !== null)
}

/** What a daily scheme that leaves a weekday out is told. */
export const DAILY_SERVES_EVERY_DAY = "A daily scheme serves every weekday"

/** A daily scheme serves all seven days; any other cadence serves the days it names. A half-seen pair is not judged. */
export function dailyServesEveryDay(value: Recurrence): boolean {
  const { frequency, serviceDays } = value
  if (frequency === undefined || serviceDays === undefined) return true
  return frequency !== "daily" || SERVICE_DAYS.every((day) => serviceDays.includes(day))
}

/** What a daily scheme given seasons is told: it serves every day all year, so a season has nothing to change. */
export const DAILY_HAS_NO_SEASONS = "A daily scheme serves every day all year and has no seasons"

/** A daily scheme carries no season. A half-seen pair is not judged. */
export function dailyHasNoSeasons(value: { frequency?: string; seasons?: readonly unknown[] }): boolean {
  const { frequency, seasons } = value
  if (frequency === undefined || seasons === undefined) return true
  return frequency !== "daily" || seasons.length === 0
}

/** What a group whose days the scheme does not serve is told, at that group's days. */
export const OUTSIDE_SERVICE_DAYS = "Outside the scheme's service days"

/** Every day a group runs on is a day the scheme serves. */
export const withinServiceDays = (serviceDays: readonly string[], days: readonly string[]): boolean => days.every((day) => serviceDays.includes(day))

/** What a body naming two groups alike is told: the database's key (`collection_group_route_scheme_id_name_key`) would say the same as a 23505. */
export const EACH_GROUP_NAME_ONCE = "A collection group name is used once in a scheme"

/** What a patch naming one of the scheme's groups in two entries is told. */
export const EACH_GROUP_ONCE = eachOnceSentence("collection group", "an entry is the whole group")

/** The longest window the occurrence read and a generation run walk: a year. */
export const OCCURRENCE_WINDOW_MAX_DAYS = 366
export const WINDOW_AT_MOST_A_YEAR = `A window spans at most ${OCCURRENCE_WINDOW_MAX_DAYS} days`
