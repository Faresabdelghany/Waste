// supabase/config.toml, read where this package acts on one of its values
// rather than copied: the Postgres major, which the hosted project shares and
// the Pilot's backup and restore pin their client to, and the local stack's
// volume name, signing key path and shortest password. Each value is read
// when it is asked for, and only its own key has to be there.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const SUPABASE_CONFIG_FILE = fileURLToPath(new URL("../../../supabase/config.toml", import.meta.url))

/** A TOML file's `key = value` lines, keyed `section.key`: the strings, numbers and booleans config.toml sets, and no more of TOML than that. */
export function tomlSettings(text: string): Map<string, string> {
  const settings = new Map<string, string>()
  let section = ""
  for (const line of text.split(/\r?\n/).map((raw) => raw.trim())) {
    const header = /^\[([\w.-]+)\]$/.exec(line)
    if (header !== null) section = `${header[1]}.`
    const setting = /^([\w-]+)\s*=\s*(?:"([^"]*)"|([^\s"#[]+))\s*(?:#.*)?$/.exec(line)
    if (setting !== null) settings.set(`${section}${setting[1]}`, setting[2] ?? setting[3])
  }
  return settings
}

function setting(key: string, file: string): string {
  const value = tomlSettings(readFileSync(file, "utf8")).get(key)
  if (value === undefined) throw new Error(`${file} sets no ${key}`)
  return value
}

function wholeNumber(key: string, file: string): number {
  const value = Number(setting(key, file))
  if (!Number.isInteger(value)) throw new Error(`${file}: ${key} is not a whole number`)
  return value
}

/** `[db] major_version`: the local stack's Postgres major, the hosted project's, and the client's the backup, the restore and their rehearsal require. */
export const postgresMajor = (file: string = SUPABASE_CONFIG_FILE): number => wholeNumber("db.major_version", file)

/** `[auth] minimum_password_length`: the shortest password Auth accepts. */
export const minimumPasswordLength = (file: string = SUPABASE_CONFIG_FILE): number => wholeNumber("auth.minimum_password_length", file)

/** `[auth] signing_keys_path`, resolved against the file's folder. */
export const signingKeysPath = (file: string = SUPABASE_CONFIG_FILE): string => resolve(dirname(file), setting("auth.signing_keys_path", file))

/** The volume the CLI keeps the local database in, named after `project_id`. */
export const databaseVolume = (file: string = SUPABASE_CONFIG_FILE): string => `supabase_db_${setting("project_id", file)}`
