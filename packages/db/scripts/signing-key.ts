// `pnpm --filter @waste/db signing-key` (and `pnpm db:signing-key` at the
// root): the guard every root command that can start the local stack runs
// first (Issue #151). It writes a fresh ES256 signing key to the path
// supabase/config.toml names under `[auth] signing_keys_path` when no file is
// there, and touches nothing otherwise — the CLI fails to load its config
// while that file is missing, so `db:start`, `stack:start` and `db:stop` all
// run this before it. The file is gitignored by name and stays on the
// machine. An argument names another path, for a stack started from a copy
// of the config elsewhere.
import { resolve } from "node:path"

import { ensureSigningKeys } from "../src/local-stack/signing-keys"

const DEFAULT_PATH = resolve(import.meta.dirname, "../../../supabase/signing_keys.json")

const { path, written } = ensureSigningKeys(process.argv[2] === undefined ? DEFAULT_PATH : resolve(process.argv[2]))
console.log(written ? `@waste/db: a fresh ES256 signing key for local Auth is at ${path}` : `@waste/db: local Auth's signing key is already at ${path}`)
