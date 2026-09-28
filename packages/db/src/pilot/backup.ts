// What a Pilot backup is and how one is proved sound (Issue #152, decided in
// #133). scripts/pilot-backup.sh takes the dumps — plain SQL, one schema file
// and one data file for each of the three application schemas, `--no-owner`
// with privileges kept — and this module writes the manifest beside them
// before they are tarred and encrypted to the committed age recipient
// (supabase/pilot-backup.pub): the run and the commit, the UTC time, the
// server's and the client's versions, the database's identity, the schemas
// included, the journal's position and rows, the sha256 of every dump, and
// the fingerprint of the database as it was dumped, kept as fingerprint.txt
// in the archive, since a restored database is proved against the backup's
// own fingerprint and not the committed one, which describes the head.
//
// A schema dump holds no publication membership (pg_dump writes it only with
// the publication, which a dump of three schemas leaves out), and dropping
// the schemas drops it: so the manifest records the `powersync`
// publication's tables as they were, and the restore adds them back inside
// its one transaction (restorePlan), which the rehearsal holds to the
// fingerprint.
//
// `pgboss` is dumped only where it exists: the Pilot before migration 0011
// has none, and the adoption release backs it up in that state. `wms` and
// `drizzle` are required, and the `wms` schema dump must carry the schema
// and at least one table, so a dump of an empty database is never mistaken
// for a backup.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import { createDb } from "../client"
import { fingerprintDatabase, fingerprintDigest } from "../fingerprint"
import { readAppliedMigrations } from "../journal-check"
import { databaseIdentity } from "./identity"

export const BACKUP_SCHEMAS = ["wms", "drizzle", "pgboss"] as const
export type BackupSchema = (typeof BACKUP_SCHEMAS)[number]
/** The schemas a backup must hold; pg-boss's arrives with migration 0011. */
export const REQUIRED_SCHEMAS: readonly BackupSchema[] = ["wms", "drizzle"]
export const MANIFEST_FILE = "manifest.json"
export const FINGERPRINT_COPY = "fingerprint.txt"
export const BACKUP_MANIFEST_SCHEMA = "waste.pilot.backup/1"
/** The publication whose membership a backup records (migration 0008, src/sql/publication.ts). */
export const PUBLICATION = "powersync"
/** A published table as the manifest names it: schema-qualified, plain identifiers only. */
const PUBLISHED_TABLE = /^(?:wms|drizzle|pgboss)\.[a-z_][a-z0-9_]*$/

/** The dump files of the schemas a backup includes, in restore order: every schema file, then every data file. */
export function dumpFiles(schemas: readonly BackupSchema[]): string[] {
  return [...schemas.map((schema) => `${schema}-schema.sql`), ...schemas.map((schema) => `${schema}-data.sql`)]
}

export type BackupManifest = {
  schema: typeof BACKUP_MANIFEST_SCHEMA
  run: { id: string; attempt: string }
  commit: string
  createdAt: string
  server: { version: string; major: number }
  client: { version: string; major: number }
  identity: string
  schemas: BackupSchema[]
  journal: { applied: number; last: string | null; rows: { when: string | null; hash: string }[] }
  files: { name: string; bytes: number; sha256: string }[]
  fingerprint: { file: typeof FINGERPRINT_COPY; sha256: string }
  /** The publication's tables among the backed-up schemas, or null where the database has no such publication. */
  publication: { name: typeof PUBLICATION; tables: string[] } | null
}

/** The sha256 of a file's bytes, as `sha256sum` prints it: read as latin1, one character per byte, so no byte is decoded away. */
const sha256OfFile = (file: string) => createHash("sha256").update(readFileSync(file, "latin1"), "latin1").digest("hex")

/** The client major a `pg_dump --version` line names: `pg_dump (PostgreSQL) 17.6` is 17. */
export function majorOf(version: string): number {
  const match = /\(PostgreSQL\) (\d+)(?:\.\d+)*/.exec(version) ?? /^(\d+)/.exec(version)
  if (match === null) throw new Error(`"${version}" names no PostgreSQL version`)
  return Number(match[1])
}

/** The dumps' own checks: each is there and non-empty, and the wms schema dump holds the schema and a table. */
function checkDumps(dir: string, schemas: readonly BackupSchema[]): void {
  for (const required of REQUIRED_SCHEMAS) if (!schemas.includes(required)) throw new Error(`the backup holds no ${required} schema`)
  for (const name of dumpFiles(schemas)) {
    const file = path.join(dir, name)
    if (!existsSync(file)) throw new Error(`${name} is missing from the backup`)
    if (statSync(file).size === 0) throw new Error(`${name} is empty`)
  }
  const wms = readFileSync(path.join(dir, "wms-schema.sql"), "utf8")
  if (!/^CREATE SCHEMA wms;$/m.test(wms)) throw new Error("wms-schema.sql does not create the wms schema")
  if (!/^CREATE TABLE wms\./m.test(wms)) throw new Error("wms-schema.sql defines no table")
}

export type ManifestInput = {
  url: string
  run: { id: string; attempt: string }
  commit: string
  clientVersion: string
  now?: () => Date
}

/** Writes manifest.json and fingerprint.txt beside the dumps in `dir`, after holding the dumps to their checks. */
export async function writeManifest(dir: string, { url, run, commit, clientVersion, now = () => new Date() }: ManifestInput): Promise<BackupManifest> {
  const schemas = BACKUP_SCHEMAS.filter((schema) => existsSync(path.join(dir, `${schema}-schema.sql`)))
  checkDumps(dir, schemas)
  const fingerprint = await fingerprintDatabase(url)
  writeFileSync(path.join(dir, FINGERPRINT_COPY), fingerprint)
  const { sql, close } = createDb(url, { max: 1 })
  let server: BackupManifest["server"]
  let identity: string
  let rows: Awaited<ReturnType<typeof readAppliedMigrations>>
  let publication: BackupManifest["publication"]
  try {
    const [{ version, number }] = await sql<{ version: string; number: string }[]>`select current_setting('server_version') as version, current_setting('server_version_num') as number`
    server = { version, major: Math.floor(Number(number) / 10_000) }
    identity = await databaseIdentity(sql, url)
    rows = await readAppliedMigrations(sql)
    const [present] = await sql<{ tables: string }[]>`
      select coalesce((select json_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname)
                       from pg_publication_rel pr join pg_class c on c.oid = pr.prrelid join pg_namespace n on n.oid = c.relnamespace
                       where pr.prpubid = p.oid and n.nspname in ('wms', 'drizzle', 'pgboss')), '[]')::text as tables
      from pg_publication p where p.pubname = ${PUBLICATION}`
    publication = present === undefined ? null : { name: PUBLICATION, tables: JSON.parse(present.tables) as string[] }
  } finally {
    await close()
  }
  const ordered = [...rows].sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
  const manifest: BackupManifest = {
    schema: BACKUP_MANIFEST_SCHEMA,
    run,
    commit,
    createdAt: now().toISOString(),
    server,
    client: { version: clientVersion, major: majorOf(clientVersion) },
    identity,
    schemas,
    journal: { applied: ordered.length, last: ordered.at(-1)?.createdAt ?? null, rows: ordered.map((row) => ({ when: row.createdAt, hash: row.hash })) },
    files: dumpFiles(schemas).map((name) => ({ name, bytes: statSync(path.join(dir, name)).size, sha256: sha256OfFile(path.join(dir, name)) })),
    fingerprint: { file: FINGERPRINT_COPY, sha256: fingerprintDigest(fingerprint) },
    publication,
  }
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** Proves a decrypted backup is what its manifest says, file by file, before anything is dropped. */
export function verifyBackup(dir: string): BackupManifest {
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8"))
  } catch {
    throw new Error(`${MANIFEST_FILE} is missing or not JSON`)
  }
  if (manifest.schema !== BACKUP_MANIFEST_SCHEMA) throw new Error(`${MANIFEST_FILE} is not a ${BACKUP_MANIFEST_SCHEMA} manifest`)
  const schemas = manifest.schemas.filter((schema) => (BACKUP_SCHEMAS as readonly string[]).includes(schema))
  if (schemas.length !== manifest.schemas.length) throw new Error(`${MANIFEST_FILE} names a schema this workflow does not back up`)
  const expected = dumpFiles(schemas)
  if (JSON.stringify(manifest.files.map((file) => file.name)) !== JSON.stringify(expected)) throw new Error(`${MANIFEST_FILE} does not list exactly the dumps of ${schemas.join(", ")}`)
  const present = readdirSync(dir).sort()
  const allowed = [...expected, MANIFEST_FILE, FINGERPRINT_COPY].sort()
  const extra = present.filter((name) => !allowed.includes(name))
  if (extra.length > 0) throw new Error(`the backup holds files its manifest does not name: ${extra.join(", ")}`)
  checkDumps(dir, schemas)
  for (const file of manifest.files) {
    const actual = sha256OfFile(path.join(dir, file.name))
    if (actual !== file.sha256) throw new Error(`${file.name} does not match its manifest: sha256 ${actual}, recorded ${file.sha256}`)
  }
  if (manifest.publication !== null && (manifest.publication?.name !== PUBLICATION || !manifest.publication.tables.every((table) => PUBLISHED_TABLE.test(table)))) {
    throw new Error(`${MANIFEST_FILE} names a publication or a published table this workflow does not restore`)
  }
  const fingerprint = path.join(dir, FINGERPRINT_COPY)
  if (!existsSync(fingerprint) || fingerprintDigest(readFileSync(fingerprint, "utf8")) !== manifest.fingerprint.sha256) {
    throw new Error(`${FINGERPRINT_COPY} does not match its manifest`)
  }
  return manifest
}

/** Holds a verified backup to the database it will be restored into and the run it came from. */
export function checkRestoreTarget(manifest: BackupManifest, { identity, commit, run }: { identity: string; commit?: string; run?: { id: string; attempt: string } }): void {
  if (manifest.identity !== identity) throw new Error(`the backup is of ${manifest.identity}; this database is ${identity}`)
  if (commit !== undefined && manifest.commit !== commit) throw new Error(`the backup names commit ${manifest.commit}; its run was of ${commit}`)
  if (run !== undefined && (manifest.run.id !== run.id || manifest.run.attempt !== run.attempt)) {
    throw new Error(`the backup names run ${manifest.run.id} attempt ${manifest.run.attempt}; its artifact is run ${run.id} attempt ${run.attempt}`)
  }
}

/**
 * What `pilot-restore.sh apply` hands psql, in order, for one transaction:
 * the three schemas dropped, every schema dump, the publication's tables
 * added back, every data dump. Built from a verified manifest only.
 */
export function restorePlan(manifest: BackupManifest, dir: string): string[] {
  const plan = ["-c", "DROP SCHEMA IF EXISTS pgboss, drizzle, wms CASCADE"]
  for (const schema of manifest.schemas) plan.push("-f", path.join(dir, `${schema}-schema.sql`))
  const tables = manifest.publication?.tables ?? []
  if (tables.length > 0) {
    const members = tables.map((table) => {
      if (!PUBLISHED_TABLE.test(table)) throw new Error(`${table} is not a table this workflow restores`)
      const [schema, name] = table.split(".")
      return `ONLY "${schema}"."${name}"`
    })
    plan.push("-c", `ALTER PUBLICATION ${PUBLICATION} ADD TABLE ${members.join(", ")}`)
  }
  for (const schema of manifest.schemas) plan.push("-f", path.join(dir, `${schema}-data.sql`))
  return plan
}
