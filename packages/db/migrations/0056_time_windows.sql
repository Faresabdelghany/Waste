-- Time windows, shifts and breaks (O14 of #290): a property's access hours and
-- an agreement's promised window, a driver's shift with its one break, the
-- seconds an optimiser's Plan waits for the windows, and why a Plan's stop was
-- ordered outside its window. Every column is nullable and every check passes
-- a row that has none, so the rows present pass; no table is new, so nothing
-- is hand-written.
ALTER TABLE "wms"."property" ADD COLUMN "service_window_start" time;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD COLUMN "service_window_end" time;--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD COLUMN "service_window_start" time;--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD COLUMN "service_window_end" time;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD COLUMN "shift_start" time;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD COLUMN "shift_end" time;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD COLUMN "break_minutes" integer;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD COLUMN "break_window_start" time;--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD COLUMN "break_window_end" time;--> statement-breakpoint
ALTER TABLE "wms"."plan" ADD COLUMN "waiting_seconds" integer;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD COLUMN "window_warning" text;--> statement-breakpoint
ALTER TABLE "wms"."property" ADD CONSTRAINT "property_service_window" CHECK (("wms"."property"."service_window_start" is null) = ("wms"."property"."service_window_end" is null) and ("wms"."property"."service_window_start" is null or "wms"."property"."service_window_end" > "wms"."property"."service_window_start"));--> statement-breakpoint
ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_service_window" CHECK (("wms"."agreement"."service_window_start" is null) = ("wms"."agreement"."service_window_end" is null) and ("wms"."agreement"."service_window_start" is null or "wms"."agreement"."service_window_end" > "wms"."agreement"."service_window_start"));--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_shift_window" CHECK (("wms"."driver"."shift_start" is null) = ("wms"."driver"."shift_end" is null) and ("wms"."driver"."shift_start" is null or "wms"."driver"."shift_end" > "wms"."driver"."shift_start"));--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_break_window" CHECK (("wms"."driver"."break_window_start" is null) = ("wms"."driver"."break_window_end" is null) and ("wms"."driver"."break_window_start" is null or "wms"."driver"."break_window_end" > "wms"."driver"."break_window_start"));--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_break_minutes_range" CHECK ("wms"."driver"."break_minutes" between 1 and 240);--> statement-breakpoint
ALTER TABLE "wms"."driver" ADD CONSTRAINT "driver_break_shape" CHECK (("wms"."driver"."break_minutes" is null or "wms"."driver"."shift_start" is not null) and ("wms"."driver"."break_window_start" is null or ("wms"."driver"."break_minutes" is not null and "wms"."driver"."break_window_start" >= "wms"."driver"."shift_start" and "wms"."driver"."break_window_end" <= "wms"."driver"."shift_end")));--> statement-breakpoint
ALTER TABLE "wms"."plan" ADD CONSTRAINT "plan_waiting_shape" CHECK ("wms"."plan"."waiting_seconds" is null or ("wms"."plan"."waiting_seconds" >= 0 and "wms"."plan"."status" = 'ready' and "wms"."plan"."solver" = 'optimiser'));--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_window_warning_one_of" CHECK ("wms"."plan_stop"."window_warning" in ('windows-disjoint', 'window-unreachable'));