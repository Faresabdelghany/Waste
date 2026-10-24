-- Hand-written whole (migrations/README.md), like 0011_worker: nothing here
-- is a table of the schema, so drizzle-kit generated nothing and the gate in
-- src/__tests__/hand-written.test.ts reads nothing of it; src/sql/proof-storage.ts
-- is the one spelling this file is copied from, and
-- proof-storage-rendering.test.ts holds the file to it. One thing, for O1 of
-- #290: the private `proofs` bucket a driver's photos and signatures live in,
-- its size and formats Storage's own refusal of anything else. A database
-- without Storage (a database-only stack, a test's fresh database) skips it.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, public) VALUES ('proofs', 'proofs', false)
    ON CONFLICT (id) DO UPDATE SET public = false;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name IN ('file_size_limit', 'allowed_mime_types')) = 2 THEN
    UPDATE storage.buckets SET file_size_limit = 2097152, allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'] WHERE id = 'proofs';
  END IF;
END
$$;
