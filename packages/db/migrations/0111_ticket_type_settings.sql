-- A ticket type's own deadline, default team and charge (#548 of #544): the
-- project's SLA targets, its default team per kind and its ticket charges may
-- each name one Ticket Type instead of a kind, the type's own winning over its
-- kind's. A target names a kind, a type or neither for every kind; a default
-- team and a charge name exactly one of a kind and a type; each is named once
-- per project. Every row already written names a kind, so each check holds of
-- them. drizzle-kit's statements alone: no table is new.
ALTER TABLE "wms"."ticket_sla" DROP CONSTRAINT "ticket_sla_project_id_kind_priority_key";--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" DROP CONSTRAINT "ticket_team_default_project_id_kind_key";--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" DROP CONSTRAINT "ticket_kind_product_project_id_ticket_kind_key";--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ALTER COLUMN "ticket_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD COLUMN "ticket_type_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD COLUMN "ticket_type_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD COLUMN "ticket_type_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_sla_ticket_type_id_idx" ON "wms"."ticket_sla" USING btree ("company_id","ticket_type_id");--> statement-breakpoint
CREATE INDEX "ticket_team_default_ticket_type_id_idx" ON "wms"."ticket_team_default" USING btree ("company_id","ticket_type_id");--> statement-breakpoint
CREATE INDEX "ticket_kind_product_ticket_type_id_idx" ON "wms"."ticket_kind_product" USING btree ("company_id","ticket_type_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_project_id_kind_ticket_type_id_priority_key" UNIQUE NULLS NOT DISTINCT("company_id","project_id","kind","ticket_type_id","priority");--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_project_id_kind_ticket_type_id_key" UNIQUE NULLS NOT DISTINCT("company_id","project_id","kind","ticket_type_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_project_id_ticket_kind_ticket_type_id_key" UNIQUE NULLS NOT DISTINCT("company_id","project_id","ticket_kind","ticket_type_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_scope_shape" CHECK ("wms"."ticket_sla"."kind" is null or "wms"."ticket_sla"."ticket_type_id" is null);--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_kind_or_type_exactly_one" CHECK (("wms"."ticket_team_default"."kind" is not null)::int + ("wms"."ticket_team_default"."ticket_type_id" is not null)::int = 1);--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_kind_or_type_exactly_one" CHECK (("wms"."ticket_kind_product"."ticket_kind" is not null)::int + ("wms"."ticket_kind_product"."ticket_type_id" is not null)::int = 1);