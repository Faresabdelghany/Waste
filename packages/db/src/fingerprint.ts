// The complete fingerprint of a migrated database (Issue #152, decided in
// #133): every object the migrations own, one line each, so two databases
// migrated from the same files print the same text and a database that is not
// what the files say prints a line that differs. `pnpm db:fingerprint --write`
// writes it into migrations/meta/_fingerprint.txt from a freshly migrated
// database, a test holds that file equal to one (so a migration changed
// without regenerating the file fails CI), and the Pilot's protected release
// compares the Pilot with the committed file after it migrates.
//
// What it covers: the three schemas the migrations own (`wms`, `drizzle`,
// `pgboss`) with their ACLs; every table, view and sequence in them with its
// columns, constraints, indexes, triggers, row-level security, policies and
// grants; their functions with security mode, search path and a digest of the
// whole definition; their types and default ACLs; the two extensions the
// foundation installs and the schema they live in; the three service roles'
// attributes, settings and memberships; the `powersync` publication and the
// tables in it; the one function the migrations put outside those schemas,
// the access token hook; the drizzle journal's rows (so an edited migration
// changes the fingerprint too); and pg-boss's schema version.
//
// What is normalised, because it differs between databases that are the same:
// - the owner — the role that owns `wms`, whoever ran the migrations — is
//   written `<owner>` wherever a role is named, and the current database's
//   name `<database>` in a role setting that names it;
// - an ACL is written as its effective grants, a default (null) one expanded
//   through `acldefault`, grants sorted; the `extensions` schema, which
//   Supabase shares with its own roles, reports the service roles' grants
//   alone;
// - column positions count the live columns, since a dropped column leaves a
//   gap that a dump and restore closes;
// - pg-boss's date partitions of `queue_stats` (the day's and the next day's,
//   named by the date the migration ran) are left out with everything on them;
// - the journal's `id`, a serial a hand replay left gaps in, is left out;
// - a role's LOGIN, password and validity are left out: the Pilot's app roles
//   log in with their own credentials and the local stack's with bootstrap's,
//   and the LOGIN state is a check of its own (scripts/pilot/state.ts);
// - an extension's version and a sequence's current value are left out.
//
// Every definition is deparsed by Postgres itself (`pg_get_constraintdef`,
// `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_functiondef`,
// `format_type`, `pg_get_expr`) inside one read-only snapshot whose
// search_path is empty, so every name outside pg_catalog is qualified and the
// text does not depend on the connecting role's settings.
import { readFileSync } from "node:fs"
import path from "node:path"

import type { PendingQuery, Row, Sql } from "postgres"

import { createDb } from "./client"
import { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, OWNED_SCHEMAS } from "./migrate"
import { textList } from "./query/text-list"
import { API_ROLE, SYNC_ROLE, WORKER_ROLE } from "./roles"
import { wms } from "./schema/wms"
import { sha256 } from "./sha256"
import { PGBOSS_SCHEMA } from "./sql/pgboss"
import { PUBLICATION } from "./sql/publication"

/** The committed fingerprint of a database migrated from this checkout's files. `_`-prefixed: drizzle-kit reads every other file of `meta/` as a snapshot. */
export const FINGERPRINT_FILE = path.join(MIGRATIONS_FOLDER, "meta", "_fingerprint.txt")

/** The service roles the migrations create. */
export const FINGERPRINT_ROLES = [API_ROLE, SYNC_ROLE, WORKER_ROLE] as const
/** The extensions the foundation installs into `extensions`. */
const EXTENSIONS = ["btree_gist", "postgis"] as const
/** The functions the migrations put outside their own schemas, as `schema.name`. */
const OUTSIDE_FUNCTIONS = ["public.custom_access_token_hook"] as const
/** The partitioned table whose partitions pg-boss names by date. */
const DATED_PARTITIONS_OF = `${PGBOSS_SCHEMA}.queue_stats`

const HEADER = [
  "# The database objects the migrations own (Issue #152), one per line: packages/db/src/fingerprint.ts says what is covered and what is normalised.",
  "# `pnpm db:fingerprint --write` regenerates this file from a freshly migrated database; `pnpm db:fingerprint --check` compares a database with it.",
]

type Fragment = PendingQuery<Row[]>
type AclItem = { grantor: string; grantee: string; privilege: string; grantable: boolean }

const parse = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T))

/** Reads the fingerprint of the database at `url`, as the text `_fingerprint.txt` holds. */
export async function fingerprintDatabase(url: string): Promise<string> {
  const { sql, close } = createDb(url, { max: 1 })
  try {
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      await tx`select set_config('search_path', '', true)`
      return fingerprintText(await readFingerprint(tx as unknown as Sql))
    })
  } finally {
    await close()
  }
}

/** The fingerprint's lines as a file: the header, then one object per line. */
export function fingerprintText(lines: readonly string[]): string {
  return `${[...HEADER, ...lines].join("\n")}\n`
}

/** The object lines of a fingerprint's text, comments and blank lines dropped. */
export function fingerprintLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"))
}

export type FingerprintDifference = {
  /** Lines the expected fingerprint has and the database does not. */
  missing: string[]
  /** Lines the database has and the expected fingerprint does not. */
  unexpected: string[]
}

/** What differs between two fingerprints, line by line and counting repeats, each list in its own text's order. */
export function compareFingerprints(expected: string, actual: string): FingerprintDifference {
  const beyond = (lines: readonly string[], other: readonly string[]) => {
    const available = new Map<string, number>()
    for (const line of other) available.set(line, (available.get(line) ?? 0) + 1)
    return lines.filter((line) => {
      const left = available.get(line) ?? 0
      if (left > 0) available.set(line, left - 1)
      return left === 0
    })
  }
  const want = fingerprintLines(expected)
  const have = fingerprintLines(actual)
  return { missing: beyond(want, have), unexpected: beyond(have, want) }
}

/** The committed fingerprint, as `--write` last wrote it. */
export function committedFingerprint(): string {
  return readFileSync(FINGERPRINT_FILE, "utf8")
}

/** The sha256 of a fingerprint's object lines: what a backup's manifest records and a log prints. */
export function fingerprintDigest(text: string): string {
  return sha256(`${fingerprintLines(text).join("\n")}\n`)
}

/** Writes grants as `grantee=PRIVILEGE,…/grantor`, sorted, the owner as `<owner>`; without the grantor where it says nothing. */
function spellAcl(items: readonly AclItem[], role: (name: string) => string, { grantor = true }: { grantor?: boolean } = {}): string {
  const byPair = new Map<string, { grantee: string; by: string; privileges: Set<string> }>()
  for (const item of items) {
    const grantee = role(item.grantee)
    const by = grantor ? `/${role(item.grantor)}` : ""
    const key = `${grantee}${by}`
    const entry = byPair.get(key) ?? { grantee, by, privileges: new Set<string>() }
    entry.privileges.add(`${item.privilege}${item.grantable ? "*" : ""}`)
    byPair.set(key, entry)
  }
  const spelled = [...byPair.values()].map(({ grantee, by, privileges }) => `${grantee}=${[...privileges].sort().join(",")}${by}`)
  return `[${spelled.sort().join(" ")}]`
}

/** Every line of the fingerprint, read inside the caller's snapshot. */
async function readFingerprint(sql: Sql): Promise<string[]> {
  const schemas = textList(sql, OWNED_SCHEMAS)
  const roles = textList(sql, FINGERPRINT_ROLES)
  // An ACL column exploded where it is read, a default (null) one expanded first.
  const exploded = (acl: Fragment, type: Fragment, owner: Fragment): Fragment => sql`(
    select coalesce(json_agg(json_build_object(
      'grantor', pg_get_userbyid(a.grantor),
      'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege', a.privilege_type,
      'grantable', a.is_grantable))::text, '[]')
    from aclexplode(coalesce(${acl}, acldefault(${type}, ${owner}))) a)`
  // The relations of the three schemas, pg-boss's dated partitions left out.
  const ours = sql`
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any(${schemas}) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and not (c.relispartition and exists (select from pg_inherits i where i.inhrelid = c.oid and i.inhparent = to_regclass(${DATED_PARTITIONS_OF})))`

  const [{ owner, database }] = await sql<{ owner: string; database: string }[]>`
    select coalesce((select pg_get_userbyid(nspowner) from pg_namespace where nspname = ${wms.schemaName}), current_user::text) as owner,
           current_database()::text as database`
  const role = (name: string) => (name === owner ? "<owner>" : name)
  const acl = (text: string, options?: { grantor?: boolean }) => spellAcl(parse<AclItem[]>(text) ?? [], role, options)
  const lines: string[] = []

  for (const schema of await sql<{ name: string; owner: string; acl: string }[]>`
    select n.nspname as name, pg_get_userbyid(n.nspowner) as owner, ${exploded(sql`n.nspacl`, sql`'n'::"char"`, sql`n.nspowner`)} as acl
    from pg_namespace n where n.nspname = any(${schemas}) order by n.nspname`) {
    lines.push(`schema ${schema.name} owner=${role(schema.owner)} acl=${acl(schema.acl)}`)
  }
  const [extensionsSchema] = await sql<{ acl: string }[]>`
    select ${exploded(sql`n.nspacl`, sql`'n'::"char"`, sql`n.nspowner`)} as acl from pg_namespace n where n.nspname = 'extensions'`
  const serviceRoleGrants = (text: string) => (parse<AclItem[]>(text) ?? []).filter((item) => (FINGERPRINT_ROLES as readonly string[]).includes(item.grantee))
  lines.push(
    extensionsSchema === undefined ? "schema extensions missing" : `schema extensions service-role-grants=${spellAcl(serviceRoleGrants(extensionsSchema.acl), role, { grantor: false })}`,
  )
  for (const name of EXTENSIONS) {
    const [extension] = await sql<{ schema: string }[]>`select extnamespace::regnamespace::text as schema from pg_extension where extname = ${name}`
    lines.push(extension === undefined ? `extension ${name} missing` : `extension ${name} schema=${extension.schema}`)
  }

  // The service roles: attributes (never LOGIN, a password or its validity),
  // settings, memberships in either direction.
  for (const name of FINGERPRINT_ROLES) {
    const [attributes] = await sql<{ spelled: string }[]>`
      select format('superuser=%s inherit=%s createrole=%s createdb=%s replication=%s bypassrls=%s connlimit=%s',
                    rolsuper::text, rolinherit::text, rolcreaterole::text, rolcreatedb::text, rolreplication::text, rolbypassrls::text, rolconnlimit) as spelled
      from pg_roles where rolname = ${name}`
    lines.push(attributes === undefined ? `role ${name} missing` : `role ${name} ${attributes.spelled}`)
  }
  for (const setting of await sql<{ name: string; database: string | null; config: string }[]>`
    select r.rolname as name, d.datname::text as database, array_to_json(s.setconfig)::text as config
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole left join pg_database d on d.oid = s.setdatabase
    where r.rolname = any(${roles}) and (s.setdatabase = 0 or d.datname = current_database())
    order by r.rolname, d.datname nulls first`) {
    const where = setting.database === null ? "*" : setting.database === database ? "<database>" : setting.database
    lines.push(`role-setting ${setting.name} database=${where} ${(parse<string[]>(setting.config) ?? []).sort().join("; ")}`)
  }
  const memberships = await sql<{ role: string; member: string; grantor: string; admin: boolean; inherit: boolean; set: boolean }[]>`
    select r.rolname as role, m.rolname as member, g.rolname as grantor, am.admin_option as admin, am.inherit_option as inherit, am.set_option as set
    from pg_auth_members am
    join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member join pg_roles g on g.oid = am.grantor
    where r.rolname = any(${roles}) or m.rolname = any(${roles})`
  lines.push(
    ...memberships
      .map((m) => `membership ${role(m.role)} member=${role(m.member)} grantor=${role(m.grantor)} admin=${m.admin} inherit=${m.inherit} set=${m.set}`)
      .sort(),
  )

  const relations = await sql<
    {
      oid: string
      name: string
      kind: string
      owner: string
      persistence: string
      rls: boolean
      force: boolean
      replica: string
      options: string | null
      parent: string | null
      bound: string | null
      partkey: string | null
      acl: string
      sequence: string | null
      view: string | null
    }[]
  >`
    select c.oid::text as oid, c.oid::regclass::text as name, c.relkind::text as kind, pg_get_userbyid(c.relowner) as owner,
           c.relpersistence::text as persistence, c.relrowsecurity as rls, c.relforcerowsecurity as force, c.relreplident::text as replica,
           array_to_json(c.reloptions)::text as options,
           (select string_agg(i.inhparent::regclass::text, ',' order by i.inhseqno) from pg_inherits i where i.inhrelid = c.oid) as parent,
           case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end as bound,
           case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partkey,
           ${exploded(sql`c.relacl`, sql`(case when c.relkind = 'S' then 's' else 'r' end)::"char"`, sql`c.relowner`)} as acl,
           (select format('sequence=%s start=%s increment=%s min=%s max=%s cache=%s cycle=%s owned-by=%s',
                          format_type(s.seqtypid, null), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle::text,
                          coalesce((select d.refobjid::regclass::text || '.' || a.attname
                                    from pg_depend d join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
                                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_class'::regclass and d.deptype = 'a'), 'none'))
            from pg_sequence s where s.seqrelid = c.oid) as sequence,
           case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end as view
    from pg_class c where c.oid in (${ours})
    order by c.oid::regclass::text`
  const KINDS: Record<string, string> = { r: "table", p: "partitioned-table", v: "view", m: "materialized-view", S: "sequence", f: "foreign-table" }

  const columns = await sql<
    { rel: string; position: number; name: string; type: string; notnull: boolean; default: string | null; generated: string; identity: string; collation: string | null; acl: string | null }[]
  >`
    select a.attrelid::text as rel, (row_number() over (partition by a.attrelid order by a.attnum))::int as position, a.attname as name,
           format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as default,
           a.attgenerated::text as generated, a.attidentity::text as identity,
           case when a.attcollation <> t.typcollation then (select collname from pg_collation where oid = a.attcollation) end as collation,
           case when a.attacl is not null then ${exploded(sql`a.attacl`, sql`'c'::"char"`, sql`0::oid`)} end as acl
    from pg_attribute a join pg_type t on t.oid = a.atttypid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid in (${ours}) and a.attnum > 0 and not a.attisdropped
    order by a.attrelid, a.attnum`
  const constraints = await sql<{ rel: string; name: string; definition: string; deferrable: boolean; deferred: boolean; validated: boolean }[]>`
    select conrelid::text as rel, conname as name, pg_get_constraintdef(oid) as definition, condeferrable as deferrable, condeferred as deferred, convalidated as validated
    from pg_constraint where conrelid in (${ours}) order by conrelid, conname`
  const indexes = await sql<{ rel: string; name: string; definition: string }[]>`
    select i.indrelid::text as rel, c.relname as name, pg_get_indexdef(i.indexrelid) as definition
    from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid in (${ours}) order by i.indrelid, c.relname`
  const triggers = await sql<{ rel: string; name: string; definition: string; enabled: string }[]>`
    select tgrelid::text as rel, tgname as name, pg_get_triggerdef(oid) as definition, tgenabled::text as enabled
    from pg_trigger where tgrelid in (${ours}) and not tgisinternal order by tgrelid, tgname`
  const policies = await sql<{ rel: string; name: string; permissive: boolean; command: string; roles: string; using: string | null; check: string | null }[]>`
    select p.polrelid::text as rel, p.polname as name, p.polpermissive as permissive, p.polcmd::text as command,
           (select json_agg(case when r = 0 then 'PUBLIC' else pg_get_userbyid(r) end)::text from unnest(p.polroles) r) as roles,
           pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
    from pg_policy p where p.polrelid in (${ours}) order by p.polrelid, p.polname`

  const COMMANDS: Record<string, string> = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" }
  const byRelation = <Item extends { rel: string }>(rows: readonly Item[]) => {
    const grouped = new Map<string, Item[]>()
    for (const row of rows) grouped.set(row.rel, [...(grouped.get(row.rel) ?? []), row])
    return (rel: string) => grouped.get(rel) ?? []
  }
  const columnsOf = byRelation(columns)
  const constraintsOf = byRelation(constraints)
  const indexesOf = byRelation(indexes)
  const triggersOf = byRelation(triggers)
  const policiesOf = byRelation(policies)

  for (const relation of relations) {
    const parts = [
      `relation ${relation.name} kind=${KINDS[relation.kind] ?? relation.kind} owner=${role(relation.owner)} persistence=${relation.persistence}`,
      `rls=${relation.rls} force-rls=${relation.force} replica-identity=${relation.replica}`,
    ]
    const options = parse<string[]>(relation.options)
    if (options !== null) parts.push(`options=${[...options].sort().join(",")}`)
    if (relation.parent !== null) parts.push(`inherits=${relation.parent}${relation.bound === null ? "" : ` bound=${relation.bound}`}`)
    if (relation.partkey !== null) parts.push(`partition-by=${relation.partkey}`)
    if (relation.sequence !== null) parts.push(relation.sequence)
    if (relation.view !== null) parts.push(`definition=sha256:${sha256(relation.view)}`)
    parts.push(`acl=${acl(relation.acl)}`)
    lines.push(parts.join(" "))
    // A sequence's columns are its state (last_value, log_cnt, is_called), the same on every sequence.
    for (const column of relation.kind === "S" ? [] : columnsOf(relation.oid)) {
      const spelled = [`column ${relation.name} ${column.position} ${column.name} ${column.type}`]
      if (column.notnull) spelled.push("not-null")
      if (column.generated === "s") spelled.push(`generated=(${column.default})`)
      else if (column.default !== null) spelled.push(`default=${column.default}`)
      if (column.identity !== "") spelled.push(`identity=${column.identity === "a" ? "always" : "by-default"}`)
      if (column.collation !== null) spelled.push(`collate=${column.collation}`)
      if (column.acl !== null) spelled.push(`acl=${acl(column.acl)}`)
      lines.push(spelled.join(" "))
    }
    for (const constraint of constraintsOf(relation.oid)) {
      const deferral = constraint.deferrable ? (constraint.deferred ? " deferrable initially-deferred" : " deferrable") : ""
      lines.push(`constraint ${relation.name} ${constraint.name} ${constraint.definition}${deferral}${constraint.validated ? "" : " not-valid"}`)
    }
    for (const index of indexesOf(relation.oid)) lines.push(`index ${relation.name} ${index.name} ${index.definition}`)
    for (const trigger of triggersOf(relation.oid)) lines.push(`trigger ${relation.name} ${trigger.name} enabled=${trigger.enabled} ${trigger.definition}`)
    for (const policy of policiesOf(relation.oid)) {
      const to = (parse<string[]>(policy.roles) ?? []).map(role).sort().join(",")
      lines.push(
        `policy ${relation.name} ${policy.name} ${policy.permissive ? "permissive" : "restrictive"} ${COMMANDS[policy.command] ?? policy.command} to=${to} using=${policy.using ?? "none"} check=${policy.check ?? "none"}`,
      )
    }
  }

  // Functions of the three schemas and the ones the migrations put outside
  // them; never an extension's member.
  for (const fn of await sql<{ head: string; config: string | null; owner: string; acl: string; definition: string | null }[]>`
    select format('function %s.%s(%s) returns=%s kind=%s language=%s volatility=%s security=%s leakproof=%s strict=%s parallel=%s',
                  n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), coalesce(pg_get_function_result(p.oid), 'none'),
                  p.prokind, l.lanname, p.provolatile, case when p.prosecdef then 'definer' else 'invoker' end,
                  p.proleakproof::text, p.proisstrict::text, p.proparallel) as head,
           array_to_json(p.proconfig)::text as config, pg_get_userbyid(p.proowner) as owner,
           ${exploded(sql`p.proacl`, sql`'f'::"char"`, sql`p.proowner`)} as acl,
           case when p.prokind in ('f', 'p') then pg_get_functiondef(p.oid) end as definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where (n.nspname = any(${schemas}) or n.nspname || '.' || p.proname = any(${textList(sql, OUTSIDE_FUNCTIONS)}))
      and not exists (select from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`) {
    const config = parse<string[]>(fn.config)
    lines.push(
      [
        fn.head,
        `config=${config === null ? "none" : [...config].sort().join(";")} owner=${role(fn.owner)} acl=${acl(fn.acl)}`,
        `definition=${fn.definition === null ? "none" : `sha256:${sha256(fn.definition)}`}`,
      ].join(" "),
    )
  }

  // Types a schema declares on its own: not a relation's row type, not the
  // array type Postgres makes beside every type.
  for (const type of await sql<{ name: string; kind: string; labels: string | null; base: string | null; owner: string; acl: string }[]>`
    select format('%s.%s', n.nspname, t.typname) as name, t.typtype::text as kind,
           (select json_agg(e.enumlabel order by e.enumsortorder)::text from pg_enum e where e.enumtypid = t.oid) as labels,
           case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end as base,
           pg_get_userbyid(t.typowner) as owner, ${exploded(sql`t.typacl`, sql`'T'::"char"`, sql`t.typowner`)} as acl
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = any(${schemas})
      and (t.typrelid = 0 or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
      and not exists (select from pg_type e where e.typarray = t.oid)
    order by n.nspname, t.typname`) {
    const labels = parse<string[]>(type.labels)
    lines.push(
      `type ${type.name} kind=${type.kind}${labels === null ? "" : ` labels=${labels.join(",")}`}${type.base === null ? "" : ` base=${type.base}`} owner=${role(type.owner)} acl=${acl(type.acl)}`,
    )
  }

  const OBJECT_TYPES: Record<string, string> = { r: "tables", S: "sequences", f: "functions", T: "types", n: "schemas" }
  for (const entry of await sql<{ role: string; schema: string; objects: string; acl: string }[]>`
    select pg_get_userbyid(d.defaclrole) as role, n.nspname as schema, d.defaclobjtype::text as objects,
           ${exploded(sql`d.defaclacl`, sql`d.defaclobjtype`, sql`d.defaclrole`)} as acl
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname = any(${schemas}) order by n.nspname, d.defaclobjtype, pg_get_userbyid(d.defaclrole)`) {
    lines.push(`default-acl ${entry.schema} ${OBJECT_TYPES[entry.objects] ?? entry.objects} for=${role(entry.role)} acl=${acl(entry.acl)}`)
  }

  const [publication] = await sql<{ owner: string; spelled: string }[]>`
    select pg_get_userbyid(pubowner) as owner,
           format('all-tables=%s insert=%s update=%s delete=%s truncate=%s via-root=%s', puballtables::text, pubinsert::text, pubupdate::text, pubdelete::text, pubtruncate::text, pubviaroot::text) as spelled
    from pg_publication where pubname = ${PUBLICATION}`
  if (publication === undefined) {
    lines.push(`publication ${PUBLICATION} missing`)
  } else {
    lines.push(`publication ${PUBLICATION} owner=${role(publication.owner)} ${publication.spelled}`)
    for (const table of await sql<{ name: string; columns: string | null; filter: string | null }[]>`
      select pr.prrelid::regclass::text as name,
             case when pr.prattrs is not null then (select json_agg(a.attname order by a.attnum)::text from pg_attribute a where a.attrelid = pr.prrelid and a.attnum = any(pr.prattrs::int2[])) end as columns,
             pg_get_expr(pr.prqual, pr.prrelid) as filter
      from pg_publication_rel pr join pg_publication p on p.oid = pr.prpubid where p.pubname = ${PUBLICATION} order by 1`) {
      const named = parse<string[]>(table.columns)
      lines.push(`publication-table ${PUBLICATION} ${table.name}${named === null ? "" : ` columns=${named.join(",")}`}${table.filter === null ? "" : ` where=${table.filter}`}`)
    }
    for (const schema of await sql<{ name: string }[]>`
      select pn.pnnspid::regnamespace::text as name from pg_publication_namespace pn join pg_publication p on p.oid = pn.pnpubid where p.pubname = ${PUBLICATION} order by 1`) {
      lines.push(`publication-schema ${PUBLICATION} ${schema.name}`)
    }
  }

  const [{ journal, version }] = await sql<{ journal: boolean; version: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as journal, to_regclass(${`${PGBOSS_SCHEMA}.version`}) is not null as version`
  if (journal) {
    for (const entry of await sql<{ created_at: string | null; hash: string }[]>`
      select created_at::text as created_at, hash from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)} order by created_at nulls first, hash`) {
      lines.push(`journal ${entry.created_at ?? "null"} ${entry.hash}`)
    }
  }
  if (version) {
    for (const entry of await sql<{ version: string }[]>`select version::text as version from ${sql(PGBOSS_SCHEMA)}.version order by 1`) lines.push(`pgboss-version ${entry.version}`)
  }
  return lines
}
