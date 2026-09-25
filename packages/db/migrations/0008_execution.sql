CREATE TABLE "wms"."driver_command" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"session_id" uuid,
	"pickup_id" uuid,
	"driver_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"body" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"problem" jsonb,
	CONSTRAINT "driver_command_kind_one_of" CHECK ("wms"."driver_command"."kind" in ('start-route', 'arrive', 'complete-pickup', 'skip-pickup', 'fail-pickup', 'report-problem', 'add-photo', 'add-weight', 'add-signature', 'add-note', 'record-unload', 'pause', 'resume', 'end-route')),
	CONSTRAINT "driver_command_outcome_one_of" CHECK ("wms"."driver_command"."outcome" in ('applied', 'rejected')),
	CONSTRAINT "driver_command_problem_shape" CHECK (("wms"."driver_command"."outcome" = 'rejected') = ("wms"."driver_command"."problem" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"aggregate_kind" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected')),
	CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command'))
);
--> statement-breakpoint
CREATE TABLE "wms"."pickup" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"note" text,
	"property_id" uuid,
	"shared_collection_point_id" uuid,
	"waste_fraction_id" uuid NOT NULL,
	"arrived_at" timestamp with time zone,
	"outcome_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "pickup_route_id_container_id_key" UNIQUE("company_id","route_id","container_id"),
	CONSTRAINT "pickup_route_id_project_key" UNIQUE("company_id","project_id","route_id","id"),
	CONSTRAINT "pickup_status_one_of" CHECK ("wms"."pickup"."status" in ('planned', 'completed', 'skipped', 'failed')),
	CONSTRAINT "pickup_reason_one_of" CHECK ("wms"."pickup"."reason" in ('inaccessible', 'contamination', 'not-presented', 'capacity', 'safety', 'other', 'route-ended', 'route-cancelled', 'removed-by-dispatcher', 'regeneration')),
	CONSTRAINT "pickup_position_positive" CHECK ("wms"."pickup"."position" > 0),
	CONSTRAINT "pickup_place_exactly_one" CHECK (("wms"."pickup"."property_id" is not null)::int + ("wms"."pickup"."shared_collection_point_id" is not null)::int = 1),
	CONSTRAINT "pickup_outcome_shape" CHECK (("wms"."pickup"."status" <> 'planned') = ("wms"."pickup"."outcome_at" is not null)),
	CONSTRAINT "pickup_reason_shape" CHECK (("wms"."pickup"."status" in ('skipped', 'failed')) = ("wms"."pickup"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."proof_of_service" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"pickup_id" uuid,
	"session_id" uuid,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"device_id" text,
	"location" geometry(Point, 4326),
	"location_accuracy_m" integer,
	"reason" text,
	"note" text,
	"weight_kg" integer,
	"object_key" text,
	"outcome" text,
	CONSTRAINT "proof_of_service_kind_one_of" CHECK ("wms"."proof_of_service"."kind" in ('arrival', 'completion', 'skip', 'failure', 'problem', 'photo', 'weight', 'signature', 'note', 'correction')),
	CONSTRAINT "proof_of_service_source_one_of" CHECK ("wms"."proof_of_service"."source" in ('driver-app', 'dispatch', 'integration')),
	CONSTRAINT "proof_of_service_reason_one_of" CHECK ("wms"."proof_of_service"."reason" in ('inaccessible', 'contamination', 'not-presented', 'capacity', 'safety', 'other', 'route-ended', 'route-cancelled', 'removed-by-dispatcher', 'regeneration')),
	CONSTRAINT "proof_of_service_outcome_one_of" CHECK ("wms"."proof_of_service"."outcome" in ('planned', 'completed', 'skipped', 'failed')),
	CONSTRAINT "proof_of_service_location_valid" CHECK (extensions.st_isvalid("wms"."proof_of_service"."location") and not extensions.st_isempty("wms"."proof_of_service"."location") and extensions.st_xmin("wms"."proof_of_service"."location") >= -180 and extensions.st_xmax("wms"."proof_of_service"."location") <= 180 and extensions.st_ymin("wms"."proof_of_service"."location") >= -90 and extensions.st_ymax("wms"."proof_of_service"."location") <= 90),
	CONSTRAINT "proof_of_service_location_accuracy_m_positive" CHECK ("wms"."proof_of_service"."location_accuracy_m" > 0),
	CONSTRAINT "proof_of_service_weight_kg_positive" CHECK ("wms"."proof_of_service"."weight_kg" > 0),
	CONSTRAINT "proof_of_service_pickup_shape" CHECK ("wms"."proof_of_service"."kind" in ('problem', 'photo', 'note') or "wms"."proof_of_service"."pickup_id" is not null),
	CONSTRAINT "proof_of_service_session_shape" CHECK (("wms"."proof_of_service"."source" = 'driver-app') = ("wms"."proof_of_service"."session_id" is not null)),
	CONSTRAINT "proof_of_service_kind_shape" CHECK (case "wms"."proof_of_service"."kind" when 'arrival' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null when 'completion' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null when 'skip' then "wms"."proof_of_service"."reason" is not null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null when 'failure' then "wms"."proof_of_service"."reason" is not null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null when 'problem' then "wms"."proof_of_service"."reason" is not null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null and "wms"."proof_of_service"."note" is not null when 'photo' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is not null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null when 'weight' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is not null and "wms"."proof_of_service"."outcome" is null when 'signature' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is not null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null when 'note' then "wms"."proof_of_service"."reason" is null and "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is null and "wms"."proof_of_service"."note" is not null when 'correction' then "wms"."proof_of_service"."object_key" is null and "wms"."proof_of_service"."weight_kg" is null and "wms"."proof_of_service"."outcome" is not null and "wms"."proof_of_service"."note" is not null and "wms"."proof_of_service"."source" = 'dispatch' else false end)
);
--> statement-breakpoint
CREATE TABLE "wms"."route" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_scheme_id" uuid NOT NULL,
	"collection_group_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"operating_date" date NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"cancelled_by_generation" boolean DEFAULT false NOT NULL,
	"note" text,
	"number" integer NOT NULL,
	"planned_start_time" time,
	"planned_vehicle_id" uuid,
	"planned_driver_id" uuid,
	"planned_trailer_id" uuid,
	"depot_id" uuid,
	"planned_service_provider_id" uuid,
	"unloading_station_id" uuid,
	"actual_vehicle_id" uuid,
	"actual_driver_id" uuid,
	"actual_trailer_id" uuid,
	"dispatched_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "route_generation_key" UNIQUE("company_id","route_scheme_id","collection_group_id","service_date"),
	CONSTRAINT "route_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "route_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "route_status_one_of" CHECK ("wms"."route"."status" in ('planned', 'ready', 'active', 'completed', 'cancelled')),
	CONSTRAINT "route_actual_shape" CHECK (("wms"."route"."actual_driver_id" is not null) = ("wms"."route"."started_at" is not null) and ("wms"."route"."actual_vehicle_id" is not null) = ("wms"."route"."started_at" is not null) and ("wms"."route"."actual_trailer_id" is null or "wms"."route"."started_at" is not null)),
	CONSTRAINT "route_stamps_shape" CHECK (case "wms"."route"."status" when 'planned' then "wms"."route"."dispatched_at" is null and "wms"."route"."started_at" is null and "wms"."route"."completed_at" is null and "wms"."route"."cancelled_at" is null when 'ready' then "wms"."route"."dispatched_at" is not null and "wms"."route"."started_at" is null and "wms"."route"."completed_at" is null and "wms"."route"."cancelled_at" is null when 'active' then "wms"."route"."dispatched_at" is not null and "wms"."route"."started_at" is not null and "wms"."route"."completed_at" is null and "wms"."route"."cancelled_at" is null when 'completed' then "wms"."route"."dispatched_at" is not null and "wms"."route"."started_at" is not null and "wms"."route"."completed_at" is not null and "wms"."route"."cancelled_at" is null when 'cancelled' then "wms"."route"."cancelled_at" is not null and "wms"."route"."completed_at" is null and ("wms"."route"."started_at" is null or "wms"."route"."dispatched_at" is not null) else false end)
);
--> statement-breakpoint
CREATE TABLE "wms"."session" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"trailer_id" uuid,
	"device_id" text NOT NULL,
	"app_version" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_route_id_project_key" UNIQUE("company_id","project_id","route_id","id")
);
--> statement-breakpoint
CREATE TABLE "wms"."unload" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"session_id" uuid,
	"unloading_station_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"device_id" text,
	"location" geometry(Point, 4326),
	"gross_kg" integer,
	"tare_kg" integer,
	"net_kg" integer NOT NULL,
	"weighbridge_ticket" text,
	"object_key" text,
	"note" text,
	CONSTRAINT "unload_source_one_of" CHECK ("wms"."unload"."source" in ('driver-app', 'dispatch', 'integration')),
	CONSTRAINT "unload_location_valid" CHECK (extensions.st_isvalid("wms"."unload"."location") and not extensions.st_isempty("wms"."unload"."location") and extensions.st_xmin("wms"."unload"."location") >= -180 and extensions.st_xmax("wms"."unload"."location") <= 180 and extensions.st_ymin("wms"."unload"."location") >= -90 and extensions.st_ymax("wms"."unload"."location") <= 90),
	CONSTRAINT "unload_gross_kg_positive" CHECK ("wms"."unload"."gross_kg" > 0),
	CONSTRAINT "unload_tare_kg_positive" CHECK ("wms"."unload"."tare_kg" > 0),
	CONSTRAINT "unload_net_kg_positive" CHECK ("wms"."unload"."net_kg" > 0),
	CONSTRAINT "unload_session_shape" CHECK (("wms"."unload"."source" = 'driver-app') = ("wms"."unload"."session_id" is not null)),
	CONSTRAINT "unload_weights_shape" CHECK (("wms"."unload"."gross_kg" is null) = ("wms"."unload"."tare_kg" is null) and ("wms"."unload"."gross_kg" is null or "wms"."unload"."net_kg" = "wms"."unload"."gross_kg" - "wms"."unload"."tare_kg"))
);
--> statement-breakpoint
ALTER TABLE "wms"."company" ADD COLUMN "next_route_number" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_route_id_session_id_fk" FOREIGN KEY ("company_id","project_id","route_id","session_id") REFERENCES "wms"."session"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_route_id_pickup_id_fk" FOREIGN KEY ("company_id","project_id","route_id","pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_route_id_pickup_id_fk" FOREIGN KEY ("company_id","project_id","route_id","pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_route_id_session_id_fk" FOREIGN KEY ("company_id","project_id","route_id","session_id") REFERENCES "wms"."session"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ADD CONSTRAINT "proof_of_service_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_route_scheme_id_fk" FOREIGN KEY ("company_id","project_id","route_scheme_id") REFERENCES "wms"."route_scheme"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_collection_group_id_fk" FOREIGN KEY ("company_id","project_id","collection_group_id") REFERENCES "wms"."collection_group"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_planned_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","planned_vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_planned_trailer_id_fk" FOREIGN KEY ("company_id","project_id","planned_trailer_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_planned_driver_id_fk" FOREIGN KEY ("company_id","project_id","planned_driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_depot_id_fk" FOREIGN KEY ("company_id","project_id","depot_id") REFERENCES "wms"."depot"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_planned_service_provider_id_fk" FOREIGN KEY ("company_id","planned_service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_actual_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","actual_vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_actual_trailer_id_fk" FOREIGN KEY ("company_id","project_id","actual_trailer_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_actual_driver_id_fk" FOREIGN KEY ("company_id","project_id","actual_driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session" ADD CONSTRAINT "session_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session" ADD CONSTRAINT "session_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session" ADD CONSTRAINT "session_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session" ADD CONSTRAINT "session_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session" ADD CONSTRAINT "session_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session" ADD CONSTRAINT "session_trailer_id_fk" FOREIGN KEY ("company_id","project_id","trailer_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_route_id_session_id_fk" FOREIGN KEY ("company_id","project_id","route_id","session_id") REFERENCES "wms"."session"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_command_project_id_idx" ON "wms"."driver_command" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "driver_command_route_id_idx" ON "wms"."driver_command" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "driver_command_pickup_id_idx" ON "wms"."driver_command" USING btree ("company_id","pickup_id");--> statement-breakpoint
CREATE INDEX "driver_command_driver_id_idx" ON "wms"."driver_command" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "driver_command_session_id_idx" ON "wms"."driver_command" USING btree ("company_id","session_id","id");--> statement-breakpoint
CREATE INDEX "outbox_event_published_at_id_idx" ON "wms"."outbox_event" USING btree ("published_at","id") WHERE "wms"."outbox_event"."published_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_event_project_id_idx" ON "wms"."outbox_event" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "outbox_event_aggregate_id_idx" ON "wms"."outbox_event" USING btree ("company_id","aggregate_id");--> statement-breakpoint
CREATE INDEX "pickup_project_id_idx" ON "wms"."pickup" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "pickup_container_id_idx" ON "wms"."pickup" USING btree ("company_id","container_id");--> statement-breakpoint
CREATE INDEX "pickup_property_id_idx" ON "wms"."pickup" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "pickup_shared_collection_point_id_idx" ON "wms"."pickup" USING btree ("company_id","shared_collection_point_id");--> statement-breakpoint
CREATE INDEX "pickup_waste_fraction_id_idx" ON "wms"."pickup" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "pickup_route_id_position_idx" ON "wms"."pickup" USING btree ("company_id","route_id","position");--> statement-breakpoint
CREATE INDEX "proof_of_service_route_id_idx" ON "wms"."proof_of_service" USING btree ("company_id","route_id","id");--> statement-breakpoint
CREATE INDEX "proof_of_service_project_id_idx" ON "wms"."proof_of_service" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "proof_of_service_pickup_id_idx" ON "wms"."proof_of_service" USING btree ("company_id","pickup_id");--> statement-breakpoint
CREATE INDEX "proof_of_service_session_id_idx" ON "wms"."proof_of_service" USING btree ("company_id","session_id");--> statement-breakpoint
CREATE INDEX "proof_of_service_recorded_by_idx" ON "wms"."proof_of_service" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "route_collection_group_id_idx" ON "wms"."route" USING btree ("company_id","collection_group_id");--> statement-breakpoint
CREATE INDEX "route_project_id_operating_date_idx" ON "wms"."route" USING btree ("company_id","project_id","operating_date");--> statement-breakpoint
CREATE INDEX "route_planned_driver_id_status_idx" ON "wms"."route" USING btree ("company_id","planned_driver_id","status");--> statement-breakpoint
CREATE INDEX "route_actual_driver_id_idx" ON "wms"."route" USING btree ("company_id","actual_driver_id");--> statement-breakpoint
CREATE INDEX "route_planned_vehicle_id_idx" ON "wms"."route" USING btree ("company_id","planned_vehicle_id");--> statement-breakpoint
CREATE INDEX "route_planned_trailer_id_idx" ON "wms"."route" USING btree ("company_id","planned_trailer_id");--> statement-breakpoint
CREATE INDEX "route_depot_id_idx" ON "wms"."route" USING btree ("company_id","depot_id");--> statement-breakpoint
CREATE INDEX "route_planned_service_provider_id_idx" ON "wms"."route" USING btree ("company_id","planned_service_provider_id");--> statement-breakpoint
CREATE INDEX "route_unloading_station_id_idx" ON "wms"."route" USING btree ("company_id","unloading_station_id");--> statement-breakpoint
CREATE INDEX "route_actual_vehicle_id_idx" ON "wms"."route" USING btree ("company_id","actual_vehicle_id");--> statement-breakpoint
CREATE INDEX "route_actual_trailer_id_idx" ON "wms"."route" USING btree ("company_id","actual_trailer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_route_open_idx" ON "wms"."session" USING btree ("company_id","route_id") WHERE "wms"."session"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "session_driver_open_idx" ON "wms"."session" USING btree ("company_id","driver_id") WHERE "wms"."session"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "session_project_id_idx" ON "wms"."session" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "session_route_id_idx" ON "wms"."session" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "session_driver_id_idx" ON "wms"."session" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "session_vehicle_id_idx" ON "wms"."session" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "session_trailer_id_idx" ON "wms"."session" USING btree ("company_id","trailer_id");--> statement-breakpoint
CREATE INDEX "unload_route_id_idx" ON "wms"."unload" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "unload_session_id_idx" ON "wms"."unload" USING btree ("company_id","session_id");--> statement-breakpoint
CREATE INDEX "unload_unloading_station_id_idx" ON "wms"."unload" USING btree ("company_id","unloading_station_id");--> statement-breakpoint
CREATE INDEX "unload_waste_fraction_id_idx" ON "wms"."unload" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "unload_recorded_by_idx" ON "wms"."unload" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "unload_project_id_occurred_at_idx" ON "wms"."unload" USING btree ("company_id","project_id","occurred_at");--> statement-breakpoint
-- Hand-written from here on (migrations/README.md): the fence of each of the
-- seven tables, then its updated_at trigger — or, for the three ledgers,
-- proof_of_service, unload and driver_command, the REVOKE of UPDATE and DELETE
-- from the API role, since a ledger is appended and never rewritten — table by
-- table, copied verbatim from the helpers in src/sql/, which the gate in
-- src/__tests__/hand-written.test.ts holds the file to; then what is nobody's
-- table, like the access token hook below 0002's: the sync role wms_sync
-- (REPLICATION, BYPASSRLS, SELECT on exactly the synced tables, granted to
-- the owner so a test can look through its eyes, tolerating the
-- concurrent-creation race as wms_api's statements do) and the publication
-- powersync over exactly those tables, copied from src/sql/publication.ts,
-- which the rendering test holds the file to (Issue #104, ADR-0004).
ALTER TABLE "wms"."route" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "route_tenant_fence" ON "wms"."route" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "route_touch_updated_at" BEFORE UPDATE ON "wms"."route" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."pickup" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pickup_tenant_fence" ON "wms"."pickup" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "pickup_touch_updated_at" BEFORE UPDATE ON "wms"."pickup" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."session" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "session_tenant_fence" ON "wms"."session" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "session_touch_updated_at" BEFORE UPDATE ON "wms"."session" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."proof_of_service" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "proof_of_service_tenant_fence" ON "wms"."proof_of_service" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."proof_of_service" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."unload" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "unload_tenant_fence" ON "wms"."unload" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."unload" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "driver_command_tenant_fence" ON "wms"."driver_command" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."driver_command" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outbox_event_tenant_fence" ON "wms"."outbox_event" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "outbox_event_touch_updated_at" BEFORE UPDATE ON "wms"."outbox_event" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_sync') THEN
    BEGIN
      CREATE ROLE wms_sync NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION BYPASSRLS;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT wms_sync TO %I', current_user);
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA wms TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."user_account" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."waste_fraction" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."container_type" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."container" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."property" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."shared_collection_point" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."depot" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."unloading_station" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."unloading_station_fraction" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."vehicle" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."driver" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."route" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."pickup" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."session" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."proof_of_service" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."unload" TO wms_sync;
--> statement-breakpoint
GRANT SELECT ON "wms"."driver_command" TO wms_sync;
--> statement-breakpoint
CREATE PUBLICATION powersync FOR TABLE "wms"."user_account", "wms"."waste_fraction", "wms"."container_type", "wms"."container", "wms"."property", "wms"."shared_collection_point", "wms"."depot", "wms"."unloading_station", "wms"."unloading_station_fraction", "wms"."vehicle", "wms"."driver", "wms"."route", "wms"."pickup", "wms"."session", "wms"."proof_of_service", "wms"."unload", "wms"."driver_command";
