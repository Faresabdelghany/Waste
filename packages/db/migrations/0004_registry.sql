CREATE TABLE "wms"."container_type" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"volume_litres" integer,
	CONSTRAINT "container_type_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "container_type_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "container_type_volume_litres_positive" CHECK ("wms"."container_type"."volume_litres" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."product" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"unit" text NOT NULL,
	"container_type_id" uuid,
	"waste_fraction_id" uuid,
	"service_frequency_id" uuid,
	CONSTRAINT "product_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "product_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "product_kind_one_of" CHECK ("wms"."product"."kind" in ('container-collection', 'recurring-service', 'additional-service')),
	CONSTRAINT "product_status_one_of" CHECK ("wms"."product"."status" in ('draft', 'active', 'inactive')),
	CONSTRAINT "product_unit_one_of" CHECK ("wms"."product"."unit" in ('pickup', 'month', 'job'))
);
--> statement-breakpoint
CREATE TABLE "wms"."service_frequency" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"collections_per_week" integer,
	"weeks_between" integer,
	"days_between" integer,
	CONSTRAINT "service_frequency_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "service_frequency_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "service_frequency_collections_per_week_positive" CHECK ("wms"."service_frequency"."collections_per_week" > 0),
	CONSTRAINT "service_frequency_weeks_between_positive" CHECK ("wms"."service_frequency"."weeks_between" > 0),
	CONSTRAINT "service_frequency_days_between_positive" CHECK ("wms"."service_frequency"."days_between" > 0),
	CONSTRAINT "service_frequency_shape" CHECK (("wms"."service_frequency"."collections_per_week" is not null or ("wms"."service_frequency"."weeks_between" is null and "wms"."service_frequency"."days_between" is null)) and ("wms"."service_frequency"."weeks_between" is null or "wms"."service_frequency"."days_between" is null))
);
--> statement-breakpoint
CREATE TABLE "wms"."waste_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "waste_fraction_key_key" UNIQUE("company_id","key"),
	CONSTRAINT "waste_fraction_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "waste_fraction_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "waste_fraction_key_lowercase" CHECK ("wms"."waste_fraction"."key" = lower("wms"."waste_fraction"."key"))
);
--> statement-breakpoint
CREATE TABLE "wms"."customer" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"registration_number" text,
	"email" text,
	"phone" text,
	"billing_address" text,
	"service_messages_allowed" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "customer_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "customer_kind_one_of" CHECK ("wms"."customer"."kind" in ('person', 'organisation')),
	CONSTRAINT "customer_status_one_of" CHECK ("wms"."customer"."status" in ('active', 'inactive')),
	CONSTRAINT "customer_email_lowercase" CHECK ("wms"."customer"."email" = lower("wms"."customer"."email"))
);
--> statement-breakpoint
CREATE TABLE "wms"."property" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"registry_id" text,
	"kind" text NOT NULL,
	"location" geometry(Point, 4326),
	"notes" text,
	"status" text NOT NULL,
	CONSTRAINT "property_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "property_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "property_kind_one_of" CHECK ("wms"."property"."kind" in ('residential', 'commercial', 'public', 'mixed', 'other')),
	CONSTRAINT "property_status_one_of" CHECK ("wms"."property"."status" in ('active', 'inactive')),
	CONSTRAINT "property_location_valid" CHECK (extensions.st_isvalid("wms"."property"."location") and not extensions.st_isempty("wms"."property"."location") and extensions.st_xmin("wms"."property"."location") >= -180 and extensions.st_xmax("wms"."property"."location") <= 180 and extensions.st_ymin("wms"."property"."location") >= -90 and extensions.st_ymax("wms"."property"."location") <= 90)
);
--> statement-breakpoint
CREATE TABLE "wms"."property_group" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"responsible_customer_id" uuid,
	"status" text NOT NULL,
	CONSTRAINT "property_group_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "property_group_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "property_group_purpose_one_of" CHECK ("wms"."property_group"."purpose" in ('administration', 'reporting', 'service', 'agreement')),
	CONSTRAINT "property_group_status_one_of" CHECK ("wms"."property_group"."status" in ('draft', 'active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "wms"."property_group_member" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"property_group_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "property_group_member_property_group_id_property_id_key" UNIQUE("company_id","property_group_id","property_id"),
	CONSTRAINT "property_group_member_role_one_of" CHECK ("wms"."property_group_member"."role" in ('member', 'administrator', 'payer', 'reporting'))
);
--> statement-breakpoint
CREATE TABLE "wms"."property_party" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"property_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "property_party_property_id_customer_id_role_key" UNIQUE("company_id","property_id","customer_id","role"),
	CONSTRAINT "property_party_role_one_of" CHECK ("wms"."property_party"."role" in ('owner', 'payer', 'tenant', 'administrator', 'service-contact'))
);
--> statement-breakpoint
CREATE TABLE "wms"."shared_collection_point" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"address" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"eligibility_distance_m" integer,
	"operating_model" text NOT NULL,
	"access_mode" text NOT NULL,
	"access_conditions" text,
	"availability" text,
	"billing_mode" text NOT NULL,
	"responsible_customer_id" uuid,
	"status" text NOT NULL,
	CONSTRAINT "shared_collection_point_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "shared_collection_point_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "shared_collection_point_location_valid" CHECK (extensions.st_isvalid("wms"."shared_collection_point"."location") and not extensions.st_isempty("wms"."shared_collection_point"."location") and extensions.st_xmin("wms"."shared_collection_point"."location") >= -180 and extensions.st_xmax("wms"."shared_collection_point"."location") <= 180 and extensions.st_ymin("wms"."shared_collection_point"."location") >= -90 and extensions.st_ymax("wms"."shared_collection_point"."location") <= 90),
	CONSTRAINT "shared_collection_point_eligibility_distance_m_positive" CHECK ("wms"."shared_collection_point"."eligibility_distance_m" > 0),
	CONSTRAINT "shared_collection_point_kind_one_of" CHECK ("wms"."shared_collection_point"."kind" in ('surface', 'underground', 'recycling-station', 'commercial', 'other')),
	CONSTRAINT "shared_collection_point_operating_model_one_of" CHECK ("wms"."shared_collection_point"."operating_model" in ('municipal', 'member-funded', 'company-operated', 'service-provider-operated')),
	CONSTRAINT "shared_collection_point_access_mode_one_of" CHECK ("wms"."shared_collection_point"."access_mode" in ('open', 'member', 'credential', 'restricted')),
	CONSTRAINT "shared_collection_point_billing_mode_one_of" CHECK ("wms"."shared_collection_point"."billing_mode" in ('municipal', 'single-payer', 'member-share', 'usage')),
	CONSTRAINT "shared_collection_point_status_one_of" CHECK ("wms"."shared_collection_point"."status" in ('draft', 'open', 'restricted', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "wms"."shared_collection_point_member" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shared_collection_point_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "shared_collection_point_member_membership_key" UNIQUE("company_id","shared_collection_point_id","property_id"),
	CONSTRAINT "shared_collection_point_member_role_one_of" CHECK ("wms"."shared_collection_point_member"."role" in ('service-member', 'administrator', 'payer', 'notification-contact'))
);
--> statement-breakpoint
CREATE TABLE "wms"."agreement" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"payer_customer_id" uuid NOT NULL,
	"status" text NOT NULL,
	"billing_cadence" text NOT NULL,
	"currency" text NOT NULL,
	"notes" text,
	CONSTRAINT "agreement_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "agreement_validity" CHECK ("wms"."agreement"."valid_to" is null or "wms"."agreement"."valid_to" > "wms"."agreement"."valid_from"),
	CONSTRAINT "agreement_status_one_of" CHECK ("wms"."agreement"."status" in ('draft', 'active', 'cancelled')),
	CONSTRAINT "agreement_billing_cadence_one_of" CHECK ("wms"."agreement"."billing_cadence" in ('monthly', 'quarterly', 'annual', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "wms"."subscription" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"agreement_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"property_id" uuid,
	"shared_collection_point_id" uuid,
	"location_id" uuid GENERATED ALWAYS AS (coalesce("property_id", "shared_collection_point_id")) STORED NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "subscription_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "subscription_validity" CHECK ("wms"."subscription"."valid_to" is null or "wms"."subscription"."valid_to" > "wms"."subscription"."valid_from"),
	CONSTRAINT "subscription_location_exactly_one" CHECK (("wms"."subscription"."property_id" is not null)::int + ("wms"."subscription"."shared_collection_point_id" is not null)::int = 1),
	CONSTRAINT "subscription_quantity_positive" CHECK ("wms"."subscription"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."container" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"label" text NOT NULL,
	"container_type_id" uuid NOT NULL,
	"barcode" text,
	"rfid" text,
	"serial_number" text,
	"ownership" text NOT NULL,
	"notes" text,
	CONSTRAINT "container_label_key" UNIQUE("company_id","label"),
	CONSTRAINT "container_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "container_ownership_one_of" CHECK ("wms"."container"."ownership" in ('company', 'customer', 'unrecorded'))
);
--> statement-breakpoint
CREATE TABLE "wms"."container_service_placement" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"container_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	"service_frequency_id" uuid,
	CONSTRAINT "container_service_placement_validity" CHECK ("wms"."container_service_placement"."valid_to" is null or "wms"."container_service_placement"."valid_to" > "wms"."container_service_placement"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "wms"."container_type" ADD CONSTRAINT "container_type_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_container_type_id_fk" FOREIGN KEY ("company_id","container_type_id") REFERENCES "wms"."container_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_service_frequency_id_fk" FOREIGN KEY ("company_id","project_id","service_frequency_id") REFERENCES "wms"."service_frequency"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_frequency" ADD CONSTRAINT "service_frequency_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."service_frequency" ADD CONSTRAINT "service_frequency_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."customer" ADD CONSTRAINT "customer_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD CONSTRAINT "property_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD CONSTRAINT "property_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_group" ADD CONSTRAINT "property_group_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_group" ADD CONSTRAINT "property_group_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_group" ADD CONSTRAINT "property_group_responsible_customer_id_fk" FOREIGN KEY ("company_id","responsible_customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_group_member" ADD CONSTRAINT "property_group_member_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_group_member" ADD CONSTRAINT "property_group_member_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_group_member" ADD CONSTRAINT "property_group_member_property_group_id_fk" FOREIGN KEY ("company_id","project_id","property_group_id") REFERENCES "wms"."property_group"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_group_member" ADD CONSTRAINT "property_group_member_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD CONSTRAINT "property_party_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD CONSTRAINT "property_party_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD CONSTRAINT "property_party_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."property_party" ADD CONSTRAINT "property_party_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point" ADD CONSTRAINT "shared_collection_point_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point" ADD CONSTRAINT "shared_collection_point_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point" ADD CONSTRAINT "shared_collection_point_responsible_customer_id_fk" FOREIGN KEY ("company_id","responsible_customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point_member" ADD CONSTRAINT "shared_collection_point_member_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point_member" ADD CONSTRAINT "shared_collection_point_member_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point_member" ADD CONSTRAINT "shared_collection_point_member_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point_member" ADD CONSTRAINT "shared_collection_point_member_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_payer_customer_id_fk" FOREIGN KEY ("company_id","payer_customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription" ADD CONSTRAINT "subscription_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription" ADD CONSTRAINT "subscription_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription" ADD CONSTRAINT "subscription_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription" ADD CONSTRAINT "subscription_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription" ADD CONSTRAINT "subscription_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription" ADD CONSTRAINT "subscription_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container" ADD CONSTRAINT "container_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container" ADD CONSTRAINT "container_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container" ADD CONSTRAINT "container_container_type_id_fk" FOREIGN KEY ("company_id","container_type_id") REFERENCES "wms"."container_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_subscription_id_fk" FOREIGN KEY ("company_id","project_id","subscription_id") REFERENCES "wms"."subscription"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_service_frequency_id_fk" FOREIGN KEY ("company_id","project_id","service_frequency_id") REFERENCES "wms"."service_frequency"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_container_type_id_idx" ON "wms"."product" USING btree ("company_id","container_type_id");--> statement-breakpoint
CREATE INDEX "product_waste_fraction_id_idx" ON "wms"."product" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "product_service_frequency_id_idx" ON "wms"."product" USING btree ("company_id","service_frequency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_registration_number_idx" ON "wms"."customer" USING btree ("company_id","registration_number") WHERE "wms"."customer"."registration_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "property_registry_id_idx" ON "wms"."property" USING btree ("company_id","registry_id") WHERE "wms"."property"."registry_id" is not null;--> statement-breakpoint
CREATE INDEX "property_group_responsible_customer_id_idx" ON "wms"."property_group" USING btree ("company_id","responsible_customer_id");--> statement-breakpoint
CREATE INDEX "property_group_member_project_id_idx" ON "wms"."property_group_member" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "property_group_member_property_id_idx" ON "wms"."property_group_member" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "property_party_project_id_idx" ON "wms"."property_party" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "property_party_customer_id_idx" ON "wms"."property_party" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "shared_collection_point_responsible_customer_id_idx" ON "wms"."shared_collection_point" USING btree ("company_id","responsible_customer_id");--> statement-breakpoint
CREATE INDEX "shared_collection_point_member_project_id_idx" ON "wms"."shared_collection_point_member" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "shared_collection_point_member_property_id_idx" ON "wms"."shared_collection_point_member" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "agreement_number_idx" ON "wms"."agreement" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "agreement_customer_id_idx" ON "wms"."agreement" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "agreement_payer_customer_id_idx" ON "wms"."agreement" USING btree ("company_id","payer_customer_id");--> statement-breakpoint
CREATE INDEX "subscription_product_id_idx" ON "wms"."subscription" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "subscription_property_id_idx" ON "wms"."subscription" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "subscription_shared_collection_point_id_idx" ON "wms"."subscription" USING btree ("company_id","shared_collection_point_id");--> statement-breakpoint
CREATE INDEX "container_container_type_id_idx" ON "wms"."container" USING btree ("company_id","container_type_id");--> statement-breakpoint
CREATE INDEX "container_service_placement_project_id_idx" ON "wms"."container_service_placement" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "container_service_placement_subscription_id_idx" ON "wms"."container_service_placement" USING btree ("company_id","subscription_id");--> statement-breakpoint
CREATE INDEX "container_service_placement_waste_fraction_id_idx" ON "wms"."container_service_placement" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "container_service_placement_service_frequency_id_idx" ON "wms"."container_service_placement" USING btree ("company_id","service_frequency_id");
--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "waste_fraction_tenant_fence" ON "wms"."waste_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "waste_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."waste_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."container_type" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "container_type_tenant_fence" ON "wms"."container_type" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "container_type_touch_updated_at" BEFORE UPDATE ON "wms"."container_type" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."service_frequency" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "service_frequency_tenant_fence" ON "wms"."service_frequency" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "service_frequency_touch_updated_at" BEFORE UPDATE ON "wms"."service_frequency" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."product" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "product_tenant_fence" ON "wms"."product" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "product_touch_updated_at" BEFORE UPDATE ON "wms"."product" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."customer" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "customer_tenant_fence" ON "wms"."customer" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "customer_touch_updated_at" BEFORE UPDATE ON "wms"."customer" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."property" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "property_tenant_fence" ON "wms"."property" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "property_touch_updated_at" BEFORE UPDATE ON "wms"."property" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."property_party" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "property_party_tenant_fence" ON "wms"."property_party" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "property_party_touch_updated_at" BEFORE UPDATE ON "wms"."property_party" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."property_group" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "property_group_tenant_fence" ON "wms"."property_group" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "property_group_touch_updated_at" BEFORE UPDATE ON "wms"."property_group" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."property_group_member" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "property_group_member_tenant_fence" ON "wms"."property_group_member" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "property_group_member_touch_updated_at" BEFORE UPDATE ON "wms"."property_group_member" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "shared_collection_point_tenant_fence" ON "wms"."shared_collection_point" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "shared_collection_point_touch_updated_at" BEFORE UPDATE ON "wms"."shared_collection_point" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."shared_collection_point_member" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "shared_collection_point_member_tenant_fence" ON "wms"."shared_collection_point_member" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "shared_collection_point_member_touch_updated_at" BEFORE UPDATE ON "wms"."shared_collection_point_member" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."agreement" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "agreement_tenant_fence" ON "wms"."agreement" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "agreement_touch_updated_at" BEFORE UPDATE ON "wms"."agreement" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."subscription" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_tenant_fence" ON "wms"."subscription" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "subscription_touch_updated_at" BEFORE UPDATE ON "wms"."subscription" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."container" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "container_tenant_fence" ON "wms"."container" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "container_touch_updated_at" BEFORE UPDATE ON "wms"."container" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "container_service_placement_tenant_fence" ON "wms"."container_service_placement" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "container_service_placement_touch_updated_at" BEFORE UPDATE ON "wms"."container_service_placement" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "number" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."subscription" ADD CONSTRAINT "subscription_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "agreement_id" WITH =, "product_id" WITH =, "location_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
