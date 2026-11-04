-- A product sold by the item (#449): a bulky-waste booking's things, priced
-- by their count. drizzle-kit's statements alone: the product's unit check
-- grows by `item`. No product present is of the new unit, so nothing is
-- guarded and nothing is hand-written.
ALTER TABLE "wms"."product" DROP CONSTRAINT "product_unit_one_of";--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_unit_one_of" CHECK ("wms"."product"."unit" in ('pickup', 'month', 'job', 'day', 'visit', 'item'));