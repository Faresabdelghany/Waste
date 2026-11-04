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
