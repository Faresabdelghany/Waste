// What an Alert's bodies hold to at the boundary: it is about something.

/** What an alert about nothing is told. */
export const NAMES_A_SUBJECT = "An alert names what it is about: a route, a vehicle, a driver or a container"

/** At least one of the four links is given: the table's `alert_subject_shape`. */
export const namesASubject = (body: { routeId?: string | null; vehicleId?: string | null; driverId?: string | null; containerId?: string | null }): boolean =>
  body.routeId != null || body.vehicleId != null || body.driverId != null || body.containerId != null
