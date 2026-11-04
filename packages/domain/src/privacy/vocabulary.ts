// Privacy's closed lists (#291 C19, #381). A project's policy names the
// purpose its vehicles' positions are recorded for, which Settings › Privacy
// shows beside the days each kind of personal data is kept. The database's
// CHECK and the contracts' `z.enum` both read the tuple, so a purpose is
// added here alone, as a kebab-case token.

/** Why a project records where its vehicles are: dispatching alone, or dispatching and proving a collection was made. */
export const GPS_PURPOSES = ["dispatch", "dispatch-and-proof"] as const
export type GpsPurpose = (typeof GPS_PURPOSES)[number]

export const PRIVACY_VOCABULARIES = { GPS_PURPOSES } as const
