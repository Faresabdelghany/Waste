CREATE TABLE "wms"."audit_event" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"parent_table" text,
	"parent_id" uuid,
	"action" text NOT NULL,
	"changed" jsonb NOT NULL,
	"actor_user_account_id" uuid,
	"reason" text,
	"transaction_id" bigint NOT NULL,
	CONSTRAINT "audit_event_action_one_of" CHECK ("wms"."audit_event"."action" in ('insert', 'update', 'delete'))
);
--> statement-breakpoint
ALTER TABLE "wms"."audit_event" ADD CONSTRAINT "audit_event_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_row_idx" ON "wms"."audit_event" USING btree ("company_id","table_name","row_id","id");--> statement-breakpoint
CREATE INDEX "audit_event_parent_idx" ON "wms"."audit_event" USING btree ("company_id","parent_table","parent_id","id") WHERE "wms"."audit_event"."parent_id" is not null;
--> statement-breakpoint
-- Hand-written from here on (migrations/README.md, #291 slice 9). The audit
-- log's fence and its revoke: a ledger the API role appends to through the
-- trigger and never rewrites; the owner keeps UPDATE and DELETE, for tests
-- and for an erasure. GDPR: `changed` carries a person's values — a
-- customer's name and address, an account's e-mail — so the erasure of a
-- person (#291 slice 19) scrubs their values from `audit_event.changed` too.
-- Then `wms.audit_row()` (src/sql/audit-trail.ts, AUDIT_ROW_FUNCTION) and one
-- trigger per audited table (AUDITED there, as `auditTrail` spells it): the
-- set tables name their parent, and the company passes its three document
-- counters as columns whose moves are no history. Nothing is backfilled: the
-- log begins with this migration.
ALTER TABLE "wms"."audit_event" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_event_tenant_fence" ON "wms"."audit_event" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."audit_event" FROM wms_api;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wms.audit_row() RETURNS trigger
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
    nullif(current_setting('wms.user_account_id', true), '')::uuid,
    nullif(current_setting('wms.change_reason', true), ''),
    pg_current_xact_id()::text::bigint
  );
  return null;
end
$$;
--> statement-breakpoint
CREATE TRIGGER "company_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."company" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '', 'next_route_number', 'next_ticket_number', 'next_invoice_number');
--> statement-breakpoint
CREATE TRIGGER "project_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."project" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "service_provider_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_provider" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "role_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."role" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "role_grant_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."role_grant" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('role', 'role_id');
--> statement-breakpoint
CREATE TRIGGER "user_account_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."user_account" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "project_access_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."project_access" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('user_account', 'user_account_id');
--> statement-breakpoint
CREATE TRIGGER "service_provider_access_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_provider_access" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('user_account', 'user_account_id');
--> statement-breakpoint
CREATE TRIGGER "waste_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."waste_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "container_type_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."container_type" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "service_frequency_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_frequency" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "vehicle_type_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_type" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "container_type_vehicle_type_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."container_type_vehicle_type" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle_type', 'vehicle_type_id');
--> statement-breakpoint
CREATE TRIGGER "product_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."product" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "customer_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."customer" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "property_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."property" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "property_party_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."property_party" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('property', 'property_id');
--> statement-breakpoint
CREATE TRIGGER "property_group_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."property_group" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "property_group_member_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."property_group_member" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('property_group', 'property_group_id');
--> statement-breakpoint
CREATE TRIGGER "shared_collection_point_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."shared_collection_point" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "shared_collection_point_member_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."shared_collection_point_member" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('shared_collection_point', 'shared_collection_point_id');
--> statement-breakpoint
CREATE TRIGGER "agreement_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."agreement" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "subscription_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."subscription" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('agreement', 'agreement_id');
--> statement-breakpoint
CREATE TRIGGER "container_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."container" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "container_service_placement_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."container_service_placement" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('container', 'container_id');
--> statement-breakpoint
CREATE TRIGGER "depot_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."depot" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "unloading_station_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."unloading_station" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "unloading_station_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."unloading_station_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('unloading_station', 'unloading_station_id');
--> statement-breakpoint
CREATE TRIGGER "warehouse_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."warehouse" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "vehicle_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "vehicle_compartment_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_compartment" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle', 'vehicle_id');
--> statement-breakpoint
CREATE TRIGGER "vehicle_compartment_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_compartment_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle_compartment', 'vehicle_compartment_id');
--> statement-breakpoint
CREATE TRIGGER "driver_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."driver" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "planning_area_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."planning_area" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "planning_area_boundary_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."planning_area_boundary" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('planning_area', 'planning_area_id');
--> statement-breakpoint
CREATE TRIGGER "collection_calendar_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."collection_calendar" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "collection_calendar_holiday_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."collection_calendar_holiday" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('collection_calendar', 'collection_calendar_id');
--> statement-breakpoint
CREATE TRIGGER "route_scheme_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."route_scheme" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "collection_group_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."collection_group" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('route_scheme', 'route_scheme_id');
--> statement-breakpoint
CREATE TRIGGER "collection_group_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."collection_group_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('collection_group', 'collection_group_id');
--> statement-breakpoint
CREATE TRIGGER "collection_group_container_type_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."collection_group_container_type" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('collection_group', 'collection_group_id');
--> statement-breakpoint
CREATE TRIGGER "collection_group_container_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."collection_group_container" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('collection_group', 'collection_group_id');
--> statement-breakpoint
CREATE TRIGGER "price_list_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."price_list" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "price_list_row_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."price_list_row" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('price_list', 'price_list_id');
--> statement-breakpoint
CREATE TRIGGER "service_area_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_area" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "service_area_planning_area_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_area_planning_area" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('service_area', 'service_area_id');
--> statement-breakpoint
CREATE TRIGGER "service_area_waste_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_area_waste_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('service_area', 'service_area_id');
--> statement-breakpoint
CREATE TRIGGER "service_area_assignment_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_area_assignment" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('service_area', 'service_area_id');
--> statement-breakpoint
CREATE TRIGGER "service_provider_price_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."service_provider_price" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('service_area_assignment', 'service_area_assignment_id');
--> statement-breakpoint
CREATE TRIGGER "settlement_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."settlement" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "sorting_guide_item_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."sorting_guide_item" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
