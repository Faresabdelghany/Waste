-- The fill-driven emptying (O26 of #290, row 9.10): a Sensor Pairing
-- says whether a filling books the office's emptying of its container.
-- drizzle-kit's statement alone: the column, off on every pairing there is,
-- so no pairing books a stop until the office asks. Nothing is hand-written.
ALTER TABLE "wms"."sensor_pairing" ADD COLUMN "books_emptying" boolean DEFAULT false NOT NULL;