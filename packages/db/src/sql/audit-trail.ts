// The audit trail (#291, slice 9): the two statements that keep the audit
// log — the trigger function, once (migration 0019), and one trigger per
// audited table, in the migration that creates the table — beside
// `audit_event` (schema/audit.ts says what a row of the log is). Which tables
// are audited, under which module, as a set of which parent, is each table's
// own declaration (schema/policies.ts), gathered as `AUDITED` and `EXEMPT` in
// table-policies.ts; __tests__/audit-trail.test.ts holds the schema and the
// migrated database to them.
//
// The function. `changed` is `{ column: [before, after] }` over the columns
// whose values differ — for an insert every column the row has a value in,
// for a delete every column it had one in — less `id`, `company_id`,
// `created_at` and `updated_at`, and less the columns the table's trigger
// passes as ignored, so an update that moved only those writes nothing: a
// table's document counters, which a nightly sweep steps once per route and
// must not flood the trail with. The actor is the transaction-local
// `wms.user_account_id`, which only the API's principal guard sets, and the
// reason `wms.change_reason`, which the guard sets from the bounded
// `Waste-Change-Reason` header; both read as null where unset. The company
// row's own delete is not recorded: only the owner deletes a company, and the
// log's rows of that company go with it (the one cascade, schema/audit.ts).
// SECURITY INVOKER, so the insert is the writer's own: the API role's under
// its fence, the hook's and the owner's as theirs.
import { getTableName } from "drizzle-orm"

import { columnName, qualifiedTable, quoted, tableObjectName } from "../names"
import { literal } from "../schema/checks"
import { AUDITED, type Audited } from "../table-policies"
import { ACTOR_SETTING, REASON_SETTING } from "../tenant"

const HELPER = "auditTrail"
/** The suffix of an audited table's trigger. */
export const AUDIT_TRAIL = "audit_trail"

/** The audited tables by name, for a test that reads a migrated database's triggers. */
export const AUDITED_TABLE_NAMES: ReadonlySet<string> = new Set(AUDITED.map((entry) => getTableName(entry.table)))

/** The triggers a table of a migrated database carries, as `pg_trigger` names them in order: the audit trail where the table is audited, then the touch where it has `updated_at`. */
export const triggersOf = (name: string, touched = true): string[] => [...(AUDITED_TABLE_NAMES.has(name) ? [`${name}_${AUDIT_TRAIL}`] : []), ...(touched ? [`${name}_touch_updated_at`] : [])]

/** The trigger function, once (migration 0019). */
export const AUDIT_ROW_FUNCTION = `CREATE OR REPLACE FUNCTION wms.audit_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
declare
  before jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  touched jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  parent_column text := nullif(tg_argv[1], '');
  ignored text[] := coalesce(tg_argv[2:], '{}');
  changed jsonb := '{}'::jsonb;
  key text;
begin
  if tg_table_name = 'company' and tg_op = 'DELETE' then
    return null;
  end if;
  for key in select jsonb_object_keys(before || after) loop
    continue when key in ('id', 'company_id', 'created_at', 'updated_at') or key = any(ignored);
    if coalesce(before -> key, 'null'::jsonb) is distinct from coalesce(after -> key, 'null'::jsonb) then
      changed := changed || jsonb_build_object(key, jsonb_build_array(before -> key, after -> key));
    end if;
  end loop;
  if changed = '{}'::jsonb then
    return null;
  end if;
  insert into wms.audit_event (company_id, project_id, table_name, row_id, parent_table, parent_id, action, changed, actor_user_account_id, reason, transaction_id)
  values (
    (touched ->> 'company_id')::uuid,
    (touched ->> 'project_id')::uuid,
    tg_table_name,
    (touched ->> 'id')::uuid,
    nullif(tg_argv[0], ''),
    case when parent_column is null then null else (touched ->> parent_column)::uuid end,
    lower(tg_op),
    changed,
    nullif(current_setting('${ACTOR_SETTING}', true), '')::uuid,
    nullif(current_setting('${REASON_SETTING}', true), ''),
    pg_current_xact_id()::text::bigint
  );
  return null;
end
$$;`

/** What an audited table's trigger is given: the parent it is a set of, and the columns whose moves are no history. */
type TriggerArguments = Pick<Audited, "table" | "parent" | "ignored">

/** The statement that adds the audit trigger to this table, for the migration that creates the table. */
export function auditTrail(entry: TriggerArguments): string[] {
  const target = qualifiedTable(entry.table, HELPER)
  const args = [entry.parent === undefined ? "" : getTableName(entry.parent.table), entry.parent === undefined ? "" : columnName(entry.parent.column), ...entry.ignored.map(columnName)]
  return [
    `CREATE TRIGGER ${quoted(tableObjectName(entry.table, AUDIT_TRAIL, HELPER))} AFTER INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION wms.audit_row(${args.map(literal).join(", ")});`,
  ]
}

/** The statements that give an audited table's trigger new arguments, for a later migration: the trigger dropped and added again, in the migration's one transaction. */
export function replaceAuditTrail(entry: TriggerArguments): string[] {
  return [`DROP TRIGGER ${quoted(tableObjectName(entry.table, AUDIT_TRAIL, HELPER))} ON ${qualifiedTable(entry.table, HELPER)};`, ...auditTrail(entry)]
}
