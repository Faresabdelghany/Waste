// The process's id minter. Ids are UUID version 7 (ADR-0004) and the API
// mints them for every web write: the id is on the row before the insert, so
// the handler can answer with it and a later slice can log or queue against
// it without reading the row back. The database's `wms.uuidv7()` default
// stays for whatever arrives without one.
//
// The layout and the ordering rule are pure and live in @waste/domain/ids;
// this is the impure half, and the only one in the API: the clock is
// `Date.now` and the randomness is `crypto.getRandomValues`, Node's Web
// Crypto, which is a CSPRNG. The last id minted is held so a burst inside one
// millisecond counts up from it instead of scattering; that is per process,
// which is all the ordering a cursor over `id` needs (two processes' ids
// interleave within a millisecond and no page repeats or skips a row for it,
// since the cursor is an id and not a count).
//
// So the first id of a millisecond is random and the rest of that
// millisecond's are its successors: an id is not a secret, and nothing here
// pretends otherwise. Ids are not capabilities — every read carries the
// caller's `company_id` and its role's grant (auth/principal.ts,
// auth/require.ts), so holding one buys nothing.
import { ID_RANDOM_BYTES, mintId, nextId } from "@waste/domain/ids"

/** Mints the next id of a sequence. */
export type IdMinter = () => string

/**
 * A sequence of its own, over a clock and a source of randomness. The process
 * has one (`newId`); a test makes another to pin either.
 */
export function createIdMinter(
  now: () => number = Date.now,
  fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): IdMinter {
  let previous: string | undefined
  return () => {
    const random = fill(new Uint8Array(ID_RANDOM_BYTES))
    const id = previous === undefined ? mintId(now(), random) : nextId(previous, now(), random)
    previous = id
    return id
  }
}

/** The id for the next record this process writes. */
export const newId: IdMinter = createIdMinter()
