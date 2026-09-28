// What a Pilot backup is and how one is proved sound (Issue #152, decided in
// #133). scripts/pilot-backup.sh takes the dumps — plain SQL, one schema file
// and one data file for each schema the migrations own (OWNED_SCHEMAS,
// migrate.ts), `--no-owner` with privileges kept — and this module writes the
// manifest beside them before they are tarred and encrypted to the committed
// age recipient (supabase/pilot-backup.pub): the run and the commit, the UTC
// time, the server's and the client's versions, the database's identity, the
// schemas included, the journal's position and rows, the sha256 of every dump,
// and the fingerprint of the database as it was dumped, kept as
// fingerprint.txt in the archive, since a restored database is proved against
// the backup's own fingerprint and not the committed one, which describes the
// head.
//
// A schema dump holds no publication membership (pg_dump writes it only with
// the publication, which a dump of three schemas leaves out), and dropping
// the schemas drops it: so the manifest records the `powersync`
// publication's tables as they were, and the restore adds them back inside
// its one transaction (restorePlan), which the rehearsal holds to the
// fingerprint.
//
// `pgboss` is dumped only where it exists: the Pilot before migration 0011
// has none, and the adoption release backs it up in that state. Every other
// owned schema is required, the manifest holds the dumps to the schemas the
// database has (so a script that forgot one fails here), and the `wms` schema
// dump must carry the schema and at least one table, so a dump of an empty
// database is never mistaken for a backup.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import { createDb } from "../client"
import { fingerprintDatabase, fingerprintDigest } from "../fingerprint"
import { readAppliedMigrations } from "../journal-check"
import { OWNED_SCHEMAS } from "../migrate"
import { textList } from "../query/text-list"
import { wms } from "../schema/wms"
import { sha256OfFile } from "../sha256"
import { PGBOSS_SCHEMA } from "../sql/pgboss"
import { PUBLICATION } from "../sql/publication"
import type { RunRef } from "./github"
import { databaseIdentity } from "./identity"

/** The schemas a backup may leave out where the database has none yet: pg-boss's, which arrives with migration 0011. */
const OPTIONAL_SCHEMAS: readonly string[] = [PGBOSS_SCHEMA]
export const MANIFEST_FILE = "manifest.json"
export const FINGERPRINT_COPY = "fingerprint.txt"
export const BACKUP_MANIFEST_SCHEMA = "waste.pilot.backup/1"
/** A published table as the manifest names it: an owned schema and a plain identifier. */
const PUBLISHED_TABLE = new RegExp(`^(?:${OWNED_SCHEMAS.join("|")})\\.[a-z_][a-z0-9_]*$`)
/** What a restore runs first, inside its one transaction. */
export const DROP_OWNED_SCHEMAS = `DROP SCHEMA IF EXISTS ${[...OWNED_SCHEMAS].reverse().join(", ")} CASCADE`

/** The dump files of the schemas a backup includes, in restore order: every schema file, then every data file. */
export function dumpFiles(schemas: readonly string[]): string[] {
  return [...schemas.map((schema) => `${schema}-schema.sql`), ...schemas.map((schema) => `${schema}-data.sql`)]
}

export type BackupManifest = {
  schema: typeof BACKUP_MANIFEST_SCHEMA
  run: RunRef
  commit: string
  createdAt: string
  server: { version: string; major: number }
  client: { version: string; major: number }
  identity: string
  schemas: string[]
  journal: { applied: number; last: string | null; rows: { when: string | null; hash: string }[] }
  files: { name: string; bytes: number; sha256: string }[]
  fingerprint: { file: typeof FINGERPRINT_COPY; sha256: string }
  /** The publication's tables among the owned schemas, or null where the database has no such publication. */
  publication: { name: typeof PUBLICATION; tables: string[] } | null
}

/** The client major a `pg_dump --version` line names: `pg_dump (PostgreSQL) 17.6` is 17. */
export function majorOf(version: string): number {
  const match = /\(PostgreSQL\) (\d+)(?:\.\d+)*/.exec(version) ?? /^(\d+)/.exec(version)
  if (match === null) throw new Error(`"${version}" names no PostgreSQL version`)
  return Number(match[1])
}

/** The dumps' own checks: each is there and non-empty, and the wms schema dump holds the schema and a table. */
function checkDumps(dir: string, schemas: readonly string[]): void {
  for (const required of OWNED_SCHEMAS.filter((schema) => !OPTIONAL_SCHEMAS.includes(schema))) {
    if (!schemas.includes(required)) throw new Error(`the backup holds no ${required} schema`)
  }
  for (const name of dumpFiles(schemas)) {
    const file = path.join(dir, name)
    if (!existsSync(file)) throw new Error(`${name} is missing from the backup`)
    if (statSync(file).size === 0) throw new Error(`${name} is empty`)
  }
  const domain = readFileSync(path.join(dir, `${wms.schemaName}-schema.sql`), "utf8")
  if (!new RegExp(`^CREATE SCHEMA ${wms.schemaName};$`, "m").test(domain)) throw new Error(`${wms.schemaName}-schema.sql does not create the ${wms.schemaName} schema`)
  if (!new RegExp(`^CREATE TABLE ${wms.schemaName}\\.`, "m").test(domain)) throw new Error(`${wms.schemaName}-schema.sql defines no table`)
}

export type ManifestInput = {
  url: string
  run: RunRef
  commit: string
  clientVersion: string
  now?: () => Date
}

/** Writes manifest.json and fingerprint.txt beside the dumps in `dir`, after holding the dumps to their checks and to the database's schemas. */
export async function writeManifest(dir: string, { url, run, commit, clientVersion, now = () => new Date() }: ManifestInput): Promise<BackupManifest> {
  const { sql, close } = createDb(url, { max: 1 })
  let schemas: string[]
  let server: BackupManifest["server"]
  let identity: string
  let rows: Awaited<ReturnType<typeof readAppliedMigrations>>
  let publication: BackupManifest["publication"]
  try {
    const present = await sql<{ name: string }[]>`select nspname as name from pg_namespace where nspname = any(${textList(sql, OWNED_SCHEMAS)})`
    schemas = OWNED_SCHEMAS.filter((schema) => present.some((row) => row.name === schema))
    checkDumps(dir, schemas)
    const [{ version, number }] = await sql<{ version: string; number: string }[]>`select current_setting('server_version') as version, current_setting('server_version_num') as number`
    server = { version, major: Math.floor(Number(number) / 10_000) }
    identity = await databaseIdentity(sql, url)
    rows = await readAppliedMigrations(sql)
    const [published] = await sql<{ tables: string }[]>`
      select coalesce((select json_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname)
                       from pg_publication_rel pr join pg_class c on c.oid = pr.prrelid join pg_namespace n on n.oid = c.relnamespace
                       where pr.prpubid = p.oid and n.nspname = any(${textList(sql, OWNED_SCHEMAS)})), '[]')::text as tables
      from pg_publication p where p.pubname = ${PUBLICATION}`
    publication = published === undefined ? null : { name: PUBLICATION, tables: JSON.parse(published.tables) as string[] }
  } finally {
    await close()
  }
  const fingerprint = await fingerprintDatabase(url)
  writeFileSync(path.join(dir, FINGERPRINT_COPY), fingerprint)
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
  if (!manifest.schemas.every((schema) => OWNED_SCHEMAS.includes(schema))) throw new Error(`${MANIFEST_FILE} names a schema this workflow does not back up`)
  const expected = dumpFiles(manifest.schemas)
  if (JSON.stringify(manifest.files.map((file) => file.name)) !== JSON.stringify(expected)) {
    throw new Error(`${MANIFEST_FILE} does not list exactly the dumps of ${manifest.schemas.join(", ")}`)
  }
  const allowed = [...expected, MANIFEST_FILE, FINGERPRINT_COPY]
  const extra = readdirSync(dir).filter((name) => !allowed.includes(name))
  if (extra.length > 0) throw new Error(`the backup holds files its manifest does not name: ${extra.sort().join(", ")}`)
  checkDumps(dir, manifest.schemas)
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
export function checkRestoreTarget(manifest: BackupManifest, { identity, commit, run }: { identity: string; commit?: string; run?: RunRef }): void {
  if (manifest.identity !== identity) throw new Error(`the backup is of ${manifest.identity}; this database is ${identity}`)
  if (commit !== undefined && manifest.commit !== commit) throw new Error(`the backup names commit ${manifest.commit}; its run was of ${commit}`)
  if (run !== undefined && (manifest.run.id !== run.id || manifest.run.attempt !== run.attempt)) {
    throw new Error(`the backup names run ${manifest.run.id} attempt ${manifest.run.attempt}; its artifact is run ${run.id} attempt ${run.attempt}`)
  }
}

/**
 * What `pilot-restore.sh apply` hands psql, in order, for one transaction:
 * the owned schemas dropped, every schema dump, the publication's tables
 * added back, every data dump. Built from a verified manifest only.
 */
export function restorePlan(manifest: BackupManifest, dir: string): string[] {
  const plan = ["-c", DROP_OWNED_SCHEMAS]
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
