// The package's one sha256 (Issue #152): of a text — a migration as the
// migrator hashes it, a fingerprint, a login record — and of a file's bytes, as
// `sha256sum` prints it, for a backup's dumps.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/** A file's bytes, read as latin1 — one character per byte — so no byte is decoded away. */
export const sha256OfFile = (file: string): string => createHash("sha256").update(readFileSync(file, "latin1"), "latin1").digest("hex")
