// supabase/config.toml, read where this package acts on one of its values
// rather than copied: the name the CLI gives the database's volume, the
// signing key's path, local Auth's shortest password, and the Postgres major,
// which the hosted project shares and the Pilot's backup and restore pin
// their client to.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const SUPABASE_CONFIG_FILE = fileURLToPath(new URL("../../../../supabase/config.toml", import.meta.url))

export type SupabaseConfig = {
  /** `project_id`: the CLI names every container and volume after it. */
  projectId: string
  /** `[db] major_version`: the local stack's Postgres major, the hosted project's, and the client's the backup, the restore and their rehearsal require. */
  postgresMajor: number
  /** `[auth] signing_keys_path`, resolved against the file's folder. */
  signingKeysPath: string
  /** `[auth] minimum_password_length`. */
  minimumPasswordLength: number
}

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

export function readSupabaseConfig(file: string = SUPABASE_CONFIG_FILE): SupabaseConfig {
  const settings = tomlSettings(readFileSync(file, "utf8"))
  const text = (key: string): string => {
    const value = settings.get(key)
    if (value === undefined) throw new Error(`${file} sets no ${key}`)
    return value
  }
  const integer = (key: string): number => {
    const value = Number(text(key))
    if (!Number.isInteger(value)) throw new Error(`${file}: ${key} is not a whole number`)
    return value
  }
  return {
    projectId: text("project_id"),
    postgresMajor: integer("db.major_version"),
    signingKeysPath: resolve(dirname(file), text("auth.signing_keys_path")),
    minimumPasswordLength: integer("auth.minimum_password_length"),
  }
}

/** The volume the CLI keeps the local database in, named after `project_id`. */
export const databaseVolume = (config: SupabaseConfig): string => `supabase_db_${config.projectId}`
