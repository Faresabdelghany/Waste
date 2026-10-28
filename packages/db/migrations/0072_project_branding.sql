ALTER TABLE "wms"."project" ADD COLUMN "brand_color" text;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "accessibility_statement_url" text;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_brand_color_shape" CHECK ("wms"."project"."brand_color" ~ '^#[0-9a-fA-F]{6}$');--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_logo_url_shape" CHECK ("wms"."project"."logo_url" ~ '^https://[^\s/?#]+[^\s]*$' and char_length("wms"."project"."logo_url") <= 2048);--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_accessibility_statement_url_shape" CHECK ("wms"."project"."accessibility_statement_url" ~ '^https://[^\s/?#]+[^\s]*$' and char_length("wms"."project"."accessibility_statement_url") <= 2048);