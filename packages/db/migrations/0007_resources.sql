CREATE TABLE "wms"."container_type_vehicle_type" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"container_type_id" uuid NOT NULL,
	"vehicle_type_id" uuid NOT NULL,
	CONSTRAINT "container_type_vehicle_type_membership_key" UNIQUE("company_id","vehicle_type_id","container_type_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."depot" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"ownership" text NOT NULL,
	"service_provider_id" uuid,
	"opens_at" time,
	"closes_at" time,
	"vehicle_capacity" integer,
	"status" text NOT NULL,
	"notes" text,
	CONSTRAINT "depot_project_id_code_key" UNIQUE("company_id","project_id","code"),
	CONSTRAINT "depot_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "depot_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "depot_ownership_one_of" CHECK ("wms"."depot"."ownership" in ('company', 'service-provider')),
	CONSTRAINT "depot_status_one_of" CHECK ("wms"."depot"."status" in ('draft', 'active', 'seasonal', 'closed')),
	CONSTRAINT "depot_location_valid" CHECK (extensions.st_isvalid("wms"."depot"."location") and not extensions.st_isempty("wms"."depot"."location") and extensions.st_xmin("wms"."depot"."location") >= -180 and extensions.st_xmax("wms"."depot"."location") <= 180 and extensions.st_ymin("wms"."depot"."location") >= -90 and extensions.st_ymax("wms"."depot"."location") <= 90),
	CONSTRAINT "depot_vehicle_capacity_positive" CHECK ("wms"."depot"."vehicle_capacity" > 0),
	CONSTRAINT "depot_provider_shape" CHECK (("wms"."depot"."ownership" = 'service-provider') = ("wms"."depot"."service_provider_id" is not null)),
	CONSTRAINT "depot_hours_shape" CHECK (("wms"."depot"."opens_at" is null) = ("wms"."depot"."closes_at" is null))
);
--> statement-breakpoint
CREATE TABLE "wms"."driver" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"workforce_reference" text,
	"employment" text NOT NULL,
	"service_provider_id" uuid,
	"home_depot_id" uuid,
	"licence_class" text,
	"licence_number" text,
	"licence_expiry" date,
	"user_account_id" uuid,
	"status" text NOT NULL,
	"notes" text,
	CONSTRAINT "driver_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "driver_employment_one_of" CHECK ("wms"."driver"."employment" in ('employee', 'service-provider', 'temporary')),
	CONSTRAINT "driver_licence_class_one_of" CHECK ("wms"."driver"."licence_class" in ('b', 'c', 'ce')),
	CONSTRAINT "driver_status_one_of" CHECK ("wms"."driver"."status" in ('active', 'inactive', 'suspended')),
	CONSTRAINT "driver_provider_shape" CHECK (("wms"."driver"."employment" = 'service-provider') = ("wms"."driver"."service_provider_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"container_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_kind" text NOT NULL,
	"from_warehouse_id" uuid,
	"to_kind" text NOT NULL,
	"to_warehouse_id" uuid,
	"placement_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"reason" text,
	"reference" text,
	"corrects_movement_id" uuid,
	CONSTRAINT "stock_movement_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "stock_movement_kind_one_of" CHECK ("wms"."stock_movement"."kind" in ('receipt', 'issue', 'return', 'transfer', 'adjustment', 'decommission')),
	CONSTRAINT "stock_movement_from_kind_one_of" CHECK ("wms"."stock_movement"."from_kind" in ('supplier', 'warehouse', 'maintenance', 'service', 'scrap')),
	CONSTRAINT "stock_movement_to_kind_one_of" CHECK ("wms"."stock_movement"."to_kind" in ('supplier', 'warehouse', 'maintenance', 'service', 'scrap')),
	CONSTRAINT "stock_movement_from_shape" CHECK (("wms"."stock_movement"."from_kind" in ('warehouse', 'maintenance')) = ("wms"."stock_movement"."from_warehouse_id" is not null)),
	CONSTRAINT "stock_movement_to_shape" CHECK (("wms"."stock_movement"."to_kind" in ('warehouse', 'maintenance')) = ("wms"."stock_movement"."to_warehouse_id" is not null)),
	CONSTRAINT "stock_movement_placement_shape" CHECK (("wms"."stock_movement"."from_kind" = 'service' or "wms"."stock_movement"."to_kind" = 'service') = ("wms"."stock_movement"."placement_id" is not null)),
	CONSTRAINT "stock_movement_kind_shape" CHECK (case "wms"."stock_movement"."kind" when 'receipt' then "wms"."stock_movement"."from_kind" = 'supplier' and "wms"."stock_movement"."to_kind" = 'warehouse' when 'issue' then "wms"."stock_movement"."from_kind" in ('warehouse', 'maintenance') and "wms"."stock_movement"."to_kind" = 'service' when 'return' then "wms"."stock_movement"."from_kind" = 'service' and "wms"."stock_movement"."to_kind" in ('warehouse', 'maintenance') when 'transfer' then "wms"."stock_movement"."from_kind" in ('warehouse', 'maintenance') and "wms"."stock_movement"."to_kind" in ('warehouse', 'maintenance') when 'decommission' then "wms"."stock_movement"."from_kind" in ('warehouse', 'maintenance', 'service') and "wms"."stock_movement"."to_kind" = 'scrap' when 'adjustment' then "wms"."stock_movement"."from_kind" <> 'service' and "wms"."stock_movement"."to_kind" in ('warehouse', 'maintenance', 'scrap') else false end)
);
--> statement-breakpoint
CREATE TABLE "wms"."unloading_station" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"ownership" text NOT NULL,
	"service_provider_id" uuid,
	"opens_at" time,
	"closes_at" time,
	"weighbridge" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	CONSTRAINT "unloading_station_code_key" UNIQUE("company_id","code"),
	CONSTRAINT "unloading_station_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "unloading_station_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "unloading_station_ownership_one_of" CHECK ("wms"."unloading_station"."ownership" in ('company', 'service-provider', 'external')),
	CONSTRAINT "unloading_station_status_one_of" CHECK ("wms"."unloading_station"."status" in ('draft', 'active', 'seasonal', 'closed')),
	CONSTRAINT "unloading_station_location_valid" CHECK (extensions.st_isvalid("wms"."unloading_station"."location") and not extensions.st_isempty("wms"."unloading_station"."location") and extensions.st_xmin("wms"."unloading_station"."location") >= -180 and extensions.st_xmax("wms"."unloading_station"."location") <= 180 and extensions.st_ymin("wms"."unloading_station"."location") >= -90 and extensions.st_ymax("wms"."unloading_station"."location") <= 90),
	CONSTRAINT "unloading_station_provider_shape" CHECK (("wms"."unloading_station"."ownership" = 'service-provider') = ("wms"."unloading_station"."service_provider_id" is not null)),
	CONSTRAINT "unloading_station_hours_shape" CHECK (("wms"."unloading_station"."opens_at" is null) = ("wms"."unloading_station"."closes_at" is null))
);
--> statement-breakpoint
CREATE TABLE "wms"."unloading_station_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unloading_station_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "unloading_station_fraction_membership_key" UNIQUE("company_id","unloading_station_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registration" text NOT NULL,
	"callsign" text,
	"kind" text NOT NULL,
	"vehicle_type_id" uuid NOT NULL,
	"ownership" text NOT NULL,
	"service_provider_id" uuid,
	"status" text NOT NULL,
	"capacity_kg" integer,
	"required_licence_class" text NOT NULL,
	"home_depot_id" uuid,
	"fuel" text,
	"telematics_device_id" text,
	"notes" text,
	CONSTRAINT "vehicle_registration_key" UNIQUE("company_id","registration"),
	CONSTRAINT "vehicle_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "vehicle_kind_one_of" CHECK ("wms"."vehicle"."kind" in ('powered-vehicle', 'trailer')),
	CONSTRAINT "vehicle_ownership_one_of" CHECK ("wms"."vehicle"."ownership" in ('company', 'service-provider', 'leased')),
	CONSTRAINT "vehicle_status_one_of" CHECK ("wms"."vehicle"."status" in ('active', 'unavailable', 'maintenance', 'retired')),
	CONSTRAINT "vehicle_required_licence_class_one_of" CHECK ("wms"."vehicle"."required_licence_class" in ('b', 'c', 'ce')),
	CONSTRAINT "vehicle_fuel_one_of" CHECK ("wms"."vehicle"."fuel" in ('diesel', 'hvo', 'biogas', 'electric', 'hybrid', 'other')),
	CONSTRAINT "vehicle_capacity_kg_positive" CHECK ("wms"."vehicle"."capacity_kg" > 0),
	CONSTRAINT "vehicle_provider_shape" CHECK (("wms"."vehicle"."ownership" = 'service-provider') = ("wms"."vehicle"."service_provider_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_allocation" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"planned_from" timestamp with time zone NOT NULL,
	"planned_to" timestamp with time zone NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"driver_id" uuid,
	"trailer_id" uuid,
	"depot_id" uuid,
	"waste_fraction_id" uuid,
	"required_capacity_kg" integer,
	"status" text DEFAULT 'planned' NOT NULL,
	"note" text,
	CONSTRAINT "vehicle_allocation_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "vehicle_allocation_window" CHECK ("wms"."vehicle_allocation"."planned_to" > "wms"."vehicle_allocation"."planned_from"),
	CONSTRAINT "vehicle_allocation_status_one_of" CHECK ("wms"."vehicle_allocation"."status" in ('planned', 'confirmed', 'released')),
	CONSTRAINT "vehicle_allocation_required_capacity_kg_positive" CHECK ("wms"."vehicle_allocation"."required_capacity_kg" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_allocation_event" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_allocation_id" uuid NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"driver_id" uuid,
	"trailer_id" uuid,
	"depot_id" uuid,
	"planned_from" timestamp with time zone NOT NULL,
	"planned_to" timestamp with time zone NOT NULL,
	"reason" text,
	"recorded_by" uuid NOT NULL,
	CONSTRAINT "vehicle_allocation_event_action_one_of" CHECK ("wms"."vehicle_allocation_event"."action" in ('allocate', 'change', 'confirm', 'release')),
	CONSTRAINT "vehicle_allocation_event_status_one_of" CHECK ("wms"."vehicle_allocation_event"."status" in ('planned', 'confirmed', 'released'))
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_compartment" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text,
	"capacity_kg" integer,
	"volume_litres" integer,
	CONSTRAINT "vehicle_compartment_vehicle_id_position_key" UNIQUE("company_id","vehicle_id","position"),
	CONSTRAINT "vehicle_compartment_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "vehicle_compartment_position_positive" CHECK ("wms"."vehicle_compartment"."position" > 0),
	CONSTRAINT "vehicle_compartment_capacity_kg_positive" CHECK ("wms"."vehicle_compartment"."capacity_kg" > 0),
	CONSTRAINT "vehicle_compartment_volume_litres_positive" CHECK ("wms"."vehicle_compartment"."volume_litres" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_compartment_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_compartment_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "vehicle_compartment_fraction_membership_key" UNIQUE("company_id","vehicle_compartment_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_type" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "vehicle_type_key_key" UNIQUE("company_id","key"),
	CONSTRAINT "vehicle_type_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "vehicle_type_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "vehicle_type_key_lowercase" CHECK ("wms"."vehicle_type"."key" = lower("wms"."vehicle_type"."key"))
);
--> statement-breakpoint
CREATE TABLE "wms"."warehouse" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"location" geometry(Point, 4326),
	"depot_id" uuid,
	"status" text NOT NULL,
	"notes" text,
	CONSTRAINT "warehouse_project_id_code_key" UNIQUE("company_id","project_id","code"),
	CONSTRAINT "warehouse_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "warehouse_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "warehouse_status_one_of" CHECK ("wms"."warehouse"."status" in ('draft', 'active', 'restricted', 'closed')),
	CONSTRAINT "warehouse_location_valid" CHECK (extensions.st_isvalid("wms"."warehouse"."location") and not extensions.st_isempty("wms"."warehouse"."location") and extensions.st_xmin("wms"."warehouse"."location") >= -180 and extensions.st_xmax("wms"."warehouse"."location") <= 180 and extensions.st_ymin("wms"."warehouse"."location") >= -90 and extensions.st_ymax("wms"."warehouse"."location") <= 90)
);
--> statement-breakpoint
DROP INDEX "wms"."container_service_placement_project_id_idx";--> statement-breakpoint
-- Moved up from where drizzle-kit wrote it, below the foreign keys: the ledger's
-- stock_movement_placement_id_fk points at this key, and Postgres needs the key
-- before the reference. The statements are drizzle-kit's, in the one order that
-- applies; the rendering test compares the head as a set.
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_project_key" UNIQUE("company_id","project_id","id");--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD COLUMN "rule_vehicle_type_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD COLUMN "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD COLUMN "depot_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD COLUMN "unloading_station_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."container_type_vehicle_type" ADD CONSTRAINT "container_type_vehicle_type_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_type_vehicle_type" ADD CONSTRAINT "container_type_vehicle_type_container_type_id_fk" FOREIGN KEY ("company_id","container_type_id") REFERENCES "wms"."container_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_type_vehicle_type" ADD CONSTRAINT "container_type_vehicle_type_vehicle_type_id_fk" FOREIGN KEY ("company_id","vehicle_type_id") REFERENCES "wms"."vehicle_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."depot" ADD CONSTRAINT "depot_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."depot" ADD CONSTRAINT "depot_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."depot" ADD CONSTRAINT "depot_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_user_account_id_fk" FOREIGN KEY ("company_id","user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_home_depot_id_fk" FOREIGN KEY ("company_id","project_id","home_depot_id") REFERENCES "wms"."depot"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_from_warehouse_id_fk" FOREIGN KEY ("company_id","project_id","from_warehouse_id") REFERENCES "wms"."warehouse"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_to_warehouse_id_fk" FOREIGN KEY ("company_id","project_id","to_warehouse_id") REFERENCES "wms"."warehouse"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_placement_id_fk" FOREIGN KEY ("company_id","project_id","placement_id") REFERENCES "wms"."container_service_placement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ADD CONSTRAINT "stock_movement_corrects_movement_id_fk" FOREIGN KEY ("company_id","corrects_movement_id") REFERENCES "wms"."stock_movement"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unloading_station" ADD CONSTRAINT "unloading_station_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unloading_station" ADD CONSTRAINT "unloading_station_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unloading_station_fraction" ADD CONSTRAINT "unloading_station_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unloading_station_fraction" ADD CONSTRAINT "unloading_station_fraction_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."unloading_station_fraction" ADD CONSTRAINT "unloading_station_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle" ADD CONSTRAINT "vehicle_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle" ADD CONSTRAINT "vehicle_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle" ADD CONSTRAINT "vehicle_vehicle_type_id_fk" FOREIGN KEY ("company_id","vehicle_type_id") REFERENCES "wms"."vehicle_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle" ADD CONSTRAINT "vehicle_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle" ADD CONSTRAINT "vehicle_home_depot_id_fk" FOREIGN KEY ("company_id","project_id","home_depot_id") REFERENCES "wms"."depot"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_trailer_id_fk" FOREIGN KEY ("company_id","project_id","trailer_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_depot_id_fk" FOREIGN KEY ("company_id","project_id","depot_id") REFERENCES "wms"."depot"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_vehicle_allocation_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_allocation_id") REFERENCES "wms"."vehicle_allocation"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_trailer_id_fk" FOREIGN KEY ("company_id","project_id","trailer_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_depot_id_fk" FOREIGN KEY ("company_id","project_id","depot_id") REFERENCES "wms"."depot"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ADD CONSTRAINT "vehicle_allocation_event_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment" ADD CONSTRAINT "vehicle_compartment_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment" ADD CONSTRAINT "vehicle_compartment_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment" ADD CONSTRAINT "vehicle_compartment_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment_fraction" ADD CONSTRAINT "vehicle_compartment_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment_fraction" ADD CONSTRAINT "vehicle_compartment_fraction_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment_fraction" ADD CONSTRAINT "vehicle_compartment_fraction_vehicle_compartment_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_compartment_id") REFERENCES "wms"."vehicle_compartment"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment_fraction" ADD CONSTRAINT "vehicle_compartment_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_type" ADD CONSTRAINT "vehicle_type_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."warehouse" ADD CONSTRAINT "warehouse_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."warehouse" ADD CONSTRAINT "warehouse_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."warehouse" ADD CONSTRAINT "warehouse_depot_id_fk" FOREIGN KEY ("company_id","project_id","depot_id") REFERENCES "wms"."depot"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "container_type_vehicle_type_container_type_id_idx" ON "wms"."container_type_vehicle_type" USING btree ("company_id","container_type_id");--> statement-breakpoint
CREATE INDEX "depot_service_provider_id_idx" ON "wms"."depot" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_workforce_reference_idx" ON "wms"."driver" USING btree ("company_id","workforce_reference") WHERE "wms"."driver"."workforce_reference" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_user_account_id_idx" ON "wms"."driver" USING btree ("company_id","user_account_id") WHERE "wms"."driver"."user_account_id" is not null;--> statement-breakpoint
CREATE INDEX "driver_service_provider_id_idx" ON "wms"."driver" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "driver_home_depot_id_idx" ON "wms"."driver" USING btree ("company_id","home_depot_id");--> statement-breakpoint
CREATE INDEX "stock_movement_container_id_idx" ON "wms"."stock_movement" USING btree ("company_id","container_id","id");--> statement-breakpoint
CREATE INDEX "stock_movement_project_id_idx" ON "wms"."stock_movement" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "stock_movement_from_warehouse_id_idx" ON "wms"."stock_movement" USING btree ("company_id","from_warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movement_to_warehouse_id_idx" ON "wms"."stock_movement" USING btree ("company_id","to_warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movement_placement_id_idx" ON "wms"."stock_movement" USING btree ("company_id","placement_id");--> statement-breakpoint
CREATE INDEX "stock_movement_recorded_by_idx" ON "wms"."stock_movement" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "stock_movement_corrects_movement_id_idx" ON "wms"."stock_movement" USING btree ("company_id","corrects_movement_id");--> statement-breakpoint
CREATE INDEX "unloading_station_service_provider_id_idx" ON "wms"."unloading_station" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "unloading_station_fraction_waste_fraction_id_idx" ON "wms"."unloading_station_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_callsign_idx" ON "wms"."vehicle" USING btree ("company_id","callsign") WHERE "wms"."vehicle"."callsign" is not null;--> statement-breakpoint
CREATE INDEX "vehicle_vehicle_type_id_idx" ON "wms"."vehicle" USING btree ("company_id","vehicle_type_id");--> statement-breakpoint
CREATE INDEX "vehicle_service_provider_id_idx" ON "wms"."vehicle" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "vehicle_home_depot_id_idx" ON "wms"."vehicle" USING btree ("company_id","home_depot_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_vehicle_id_idx" ON "wms"."vehicle_allocation" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_trailer_id_idx" ON "wms"."vehicle_allocation" USING btree ("company_id","trailer_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_driver_id_idx" ON "wms"."vehicle_allocation" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_depot_id_idx" ON "wms"."vehicle_allocation" USING btree ("company_id","depot_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_waste_fraction_id_idx" ON "wms"."vehicle_allocation" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_project_id_planned_from_idx" ON "wms"."vehicle_allocation" USING btree ("company_id","project_id","planned_from");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_event_project_id_idx" ON "wms"."vehicle_allocation_event" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_event_vehicle_allocation_id_idx" ON "wms"."vehicle_allocation_event" USING btree ("company_id","vehicle_allocation_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_event_vehicle_id_idx" ON "wms"."vehicle_allocation_event" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_event_trailer_id_idx" ON "wms"."vehicle_allocation_event" USING btree ("company_id","trailer_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_event_driver_id_idx" ON "wms"."vehicle_allocation_event" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_event_depot_id_idx" ON "wms"."vehicle_allocation_event" USING btree ("company_id","depot_id");--> statement-breakpoint
CREATE INDEX "vehicle_allocation_event_recorded_by_idx" ON "wms"."vehicle_allocation_event" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "vehicle_compartment_project_id_idx" ON "wms"."vehicle_compartment" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "vehicle_compartment_fraction_project_id_idx" ON "wms"."vehicle_compartment_fraction" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "vehicle_compartment_fraction_waste_fraction_id_idx" ON "wms"."vehicle_compartment_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "warehouse_depot_id_idx" ON "wms"."warehouse" USING btree ("company_id","depot_id");--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_rule_vehicle_type_id_fk" FOREIGN KEY ("company_id","rule_vehicle_type_id") REFERENCES "wms"."vehicle_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_depot_id_fk" FOREIGN KEY ("company_id","project_id","depot_id") REFERENCES "wms"."depot"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_group_rule_vehicle_type_id_idx" ON "wms"."collection_group" USING btree ("company_id","rule_vehicle_type_id");--> statement-breakpoint
CREATE INDEX "collection_group_vehicle_id_idx" ON "wms"."collection_group" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "collection_group_driver_id_idx" ON "wms"."collection_group" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "route_scheme_depot_id_idx" ON "wms"."route_scheme" USING btree ("company_id","depot_id");--> statement-breakpoint
CREATE INDEX "route_scheme_unloading_station_id_idx" ON "wms"."route_scheme" USING btree ("company_id","unloading_station_id");--> statement-breakpoint
ALTER TABLE "wms"."collection_group" DROP CONSTRAINT "collection_group_rule_vehicle_type_one_of";--> statement-breakpoint
ALTER TABLE "wms"."collection_group" DROP CONSTRAINT "collection_group_rule_shape";--> statement-breakpoint
ALTER TABLE "wms"."collection_group" DROP COLUMN "rule_vehicle_type";--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_rule_shape" CHECK ("wms"."collection_group"."stop_source" = 'rule' or "wms"."collection_group"."rule_vehicle_type_id" is null);
--> statement-breakpoint
-- Hand-written from here on (migrations/README.md): the fence of each of the
-- thirteen tables, then its updated_at trigger — or, for the two ledgers,
-- stock_movement and vehicle_allocation_event, the REVOKE of UPDATE and DELETE
-- from the API role, since a ledger is appended and never rewritten — table by
-- table; then the three window exclusion constraints of vehicle_allocation, one
-- live reservation of a vehicle, of a driver and of a trailer at a time. Copied
-- verbatim from the helpers in src/sql/; the gate in
-- src/__tests__/hand-written.test.ts holds the file to them.
ALTER TABLE "wms"."vehicle_type" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_type_tenant_fence" ON "wms"."vehicle_type" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_type_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_type" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."container_type_vehicle_type" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "container_type_vehicle_type_tenant_fence" ON "wms"."container_type_vehicle_type" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "container_type_vehicle_type_touch_updated_at" BEFORE UPDATE ON "wms"."container_type_vehicle_type" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."depot" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "depot_tenant_fence" ON "wms"."depot" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "depot_touch_updated_at" BEFORE UPDATE ON "wms"."depot" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."warehouse" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "warehouse_tenant_fence" ON "wms"."warehouse" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "warehouse_touch_updated_at" BEFORE UPDATE ON "wms"."warehouse" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."unloading_station" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "unloading_station_tenant_fence" ON "wms"."unloading_station" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "unloading_station_touch_updated_at" BEFORE UPDATE ON "wms"."unloading_station" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."unloading_station_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "unloading_station_fraction_tenant_fence" ON "wms"."unloading_station_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "unloading_station_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."unloading_station_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."vehicle" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_tenant_fence" ON "wms"."vehicle" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_compartment_tenant_fence" ON "wms"."vehicle_compartment" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_compartment_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_compartment" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_compartment_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_compartment_fraction_tenant_fence" ON "wms"."vehicle_compartment_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_compartment_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_compartment_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."driver" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "driver_tenant_fence" ON "wms"."driver" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "driver_touch_updated_at" BEFORE UPDATE ON "wms"."driver" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."stock_movement" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "stock_movement_tenant_fence" ON "wms"."stock_movement" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."stock_movement" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_allocation_tenant_fence" ON "wms"."vehicle_allocation" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_allocation_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_allocation" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation_event" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_allocation_event_tenant_fence" ON "wms"."vehicle_allocation_event" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."vehicle_allocation_event" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_vehicle_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "vehicle_id" WITH =, tstzrange("planned_from", "planned_to", '[)') WITH &&) WHERE ("status" <> 'released');
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_driver_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "driver_id" WITH =, tstzrange("planned_from", "planned_to", '[)') WITH &&) WHERE ("driver_id" is not null and "status" <> 'released');
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_trailer_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "trailer_id" WITH =, tstzrange("planned_from", "planned_to", '[)') WITH &&) WHERE ("trailer_id" is not null and "status" <> 'released');
