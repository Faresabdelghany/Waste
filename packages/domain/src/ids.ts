// Minting a record id (ADR-0004). Ids are UUID version 7: 48 bits of
// millisecond clock first, so a table's primary key orders by the time the
// row was made, an index appends instead of scattering, and a cursor over
// `id` is a cursor over time (apps/api/src/pagination.ts). The API mints one
// for every web write and a driver's device mints one for every command it
// queues offline, which is how the same command replayed twice stays one
// record; the database's `wms.uuidv7()` default catches anything that arrives
// without one.
//
// Pure, like everything here: the clock and the randomness are arguments, so
// the layout can be proved bit by bit and a million ids can be walked with a
// fixed clock. apps/api/src/ids.ts is the one place that supplies `Date.now`
// and `crypto.getRandomValues`.
//
// The layout, RFC 9562 §5.7, over the sixteen bytes:
//
//   0..5   unix_ts_ms, big-endian
//   6      version nibble `7`, then the top 4 bits of rand_a
//   7      the rest of rand_a
//   8      variant bits `10`, then the top 6 bits of rand_b
//   9..15  the rest of rand_b
//
// Two ids minted in the same millisecond would otherwise land in random
// order, so `nextId` takes the 74 random bits as a counter and adds one
// (the "monotonic random" method of §6.2): the version and variant bits stay
// where they are, and a full counter carries into the millisecond, which
// costs the sequence nothing but a clock one ahead of itself. Hex is
// lowercase and the byte order is the string order, so `b > a` as strings is
// `b` was minted after `a`.

/** How many random bytes a mint needs: bytes 6..15, version and variant bits overwritten. */
export const ID_RANDOM_BYTES = 10

/** The largest millisecond 48 bits can carry (the year 10889). */
export const MAX_UNIX_MILLIS = 0xffff_ffff_ffff

const BYTES = 16
const VERSION_BYTE = 6
const VARIANT_BYTE = 8

const HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"))

/** 8-4-4-4-12 lowercase hex with the version and variant nibbles version 7 asks for. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function checkClock(unixMillis: number): void {
  if (!Number.isInteger(unixMillis) || unixMillis < 0 || unixMillis > MAX_UNIX_MILLIS) {
    throw new Error(`an id's clock is a whole number of milliseconds from 0 to ${MAX_UNIX_MILLIS}, not ${unixMillis}`)
  }
}

function checkRandom(randomBytes: Uint8Array): void {
  if (randomBytes.length !== ID_RANDOM_BYTES) {
    throw new Error(`an id needs exactly ${ID_RANDOM_BYTES} random bytes, not ${randomBytes.length}`)
  }
}

function format(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < BYTES; i += 1) hex += HEX[bytes[i]]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function parse(id: string): Uint8Array {
  if (!ID.test(id)) throw new Error(`not a UUID version 7: ${JSON.stringify(id)}`)
  const hex = id.replaceAll("-", "").toLowerCase()
  const bytes = new Uint8Array(BYTES)
  for (let i = 0; i < BYTES; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** The milliseconds in bytes 0..5. */
function clockOf(bytes: Uint8Array): number {
  let millis = 0
  for (let i = 0; i < 6; i += 1) millis = millis * 256 + bytes[i]
  return millis
}

function lay(unixMillis: number, randomBytes: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(BYTES)
  let millis = unixMillis
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = millis % 256
    millis = Math.floor(millis / 256)
  }
  bytes.set(randomBytes, VERSION_BYTE)
  bytes[VERSION_BYTE] = 0x70 | (bytes[VERSION_BYTE] & 0x0f)
  bytes[VARIANT_BYTE] = 0x80 | (bytes[VARIANT_BYTE] & 0x3f)
  return bytes
}

/**
 * The id for this millisecond and these ten random bytes. Two mints in the
 * same millisecond are two unordered ids; `nextId` is what a sequence uses.
 */
export function mintId(unixMillis: number, randomBytes: Uint8Array): string {
  checkClock(unixMillis)
  checkRandom(randomBytes)
  return format(lay(unixMillis, randomBytes))
}

/** Adds one to the 74 random bits in place, carrying into the millisecond when they are full. */
function increment(bytes: Uint8Array): void {
  for (let i = BYTES - 1; i > VARIANT_BYTE; i -= 1) {
    if (bytes[i] !== 0xff) {
      bytes[i] += 1
      return
    }
    bytes[i] = 0
  }
  const underVariant = bytes[VARIANT_BYTE] & 0x3f
  if (underVariant !== 0x3f) {
    bytes[VARIANT_BYTE] = 0x80 | (underVariant + 1)
    return
  }
  bytes[VARIANT_BYTE] = 0x80
  if (bytes[7] !== 0xff) {
    bytes[7] += 1
    return
  }
  bytes[7] = 0
  const underVersion = bytes[VERSION_BYTE] & 0x0f
  if (underVersion !== 0x0f) {
    bytes[VERSION_BYTE] = 0x70 | (underVersion + 1)
    return
  }
  bytes[VERSION_BYTE] = 0x70
  for (let i = 5; i >= 0; i -= 1) {
    if (bytes[i] !== 0xff) {
      bytes[i] += 1
      return
    }
    bytes[i] = 0
  }
  throw new Error("the id clock overflowed 48 bits")
}

/**
 * The id after `previous`, always strictly greater than it as a string. A
 * clock that has moved on mints afresh; a clock that has not (or has run
 * backwards, which a host's clock does) counts the random field up from the
 * previous id, so a burst inside one millisecond stays in the order it was
 * minted.
 */
export function nextId(previous: string, unixMillis: number, randomBytes: Uint8Array): string {
  checkClock(unixMillis)
  checkRandom(randomBytes)
  const bytes = parse(previous)
  if (unixMillis > clockOf(bytes)) return format(lay(unixMillis, randomBytes))
  increment(bytes)
  return format(bytes)
}
