// The name a vehicle is shown by — on the wire, in a sentence, in a warning
// or an alert — read from a row in TypeScript or from its columns in SQL;
// vehicle-label.test.ts holds the two to each other.
import { sql, type SQL, type SQLWrapper } from "drizzle-orm"

/** The name a vehicle is shown by: its callsign, else its registration. */
export const vehicleLabel = (row: { registration: string; callsign: string | null }): string => row.callsign ?? row.registration

/** `vehicleLabel` in SQL, over a vehicle's two columns as the statement names them. */
export const vehicleLabelOf = (columns: { registration: SQLWrapper; callsign: SQLWrapper }): SQL<string> => sql<string>`coalesce(${columns.callsign}, ${columns.registration})`
