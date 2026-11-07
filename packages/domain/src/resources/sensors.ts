// Fill-level Sensors (O26 of #290, row 9.10): a device the company owns,
// paired over a period with the Container it measures, sending Fill Readings
// through the vendor-neutral ingest (`POST /sensor-readings`). No vendor is
// chosen yet: a vendor's integration posts the fill already computed as a
// percent, since a sensor's offset and the lid's geometry are the vendor's
// arithmetic, and the integration signs in as a Login on the Integration
// Writer role, the system role a company gives its integrations.

/** The most readings one ingest request carries: a vendor's batch is split above it. */
export const SENSOR_READING_BATCH_MAX = 500

/** The full threshold a pairing takes when the office names none: the prototype's overflow alert's. */
export const DEFAULT_FULL_THRESHOLD_PERCENT = 85

/** A whole percent of a container's volume, or of a battery: a reading the vendor computed. */
export const PERCENT = { min: 0, max: 100 } as const

/** A full threshold: a whole percent above nothing. */
export const THRESHOLD_PERCENT = { min: 1, max: 100 } as const

/** A signal strength in whole dBm, as the vendor reports it. */
export const RSSI_DBM = { min: -200, max: 0 } as const

/** Why the ingest refused a reading: no active sensor of the caller's projects has the identifier, the sensor is retired, or the reading is from the future. */
export const FILL_READING_REFUSALS = ["unknown-sensor", "retired-sensor", "ahead-of-clock"] as const
export type FillReadingRefusal = (typeof FILL_READING_REFUSALS)[number]
