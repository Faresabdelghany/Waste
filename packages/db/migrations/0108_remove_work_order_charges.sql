-- Work order charges are removed (M14 of #293): a project no longer names the
-- product each of the office's work orders is charged at, and a completed
-- work order is charged nothing. drizzle-kit's statement alone: the table
-- goes, its rows, fence, triggers and keys with it. Nothing points at it, no
-- door or publication names it, and no vocabulary shrinks, so nothing is
-- hand-written. The billable events its rows priced stay as they were
-- recorded, and the audit log keeps the table's history.
DROP TABLE "wms"."work_order_product" CASCADE;
