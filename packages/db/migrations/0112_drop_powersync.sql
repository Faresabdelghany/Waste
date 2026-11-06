-- PowerSync's side removed (2026-11-06, the owner's decision on #574):
-- nothing runs PowerSync — the Driver App queues its commands in IndexedDB
-- and sends them over HTTPS — so the publication 0008 made for it goes, the
-- rights 0008 gave its role, `wms_sync`, are revoked, and the role is
-- dropped. ADR-0004 stays the record of the decision 0008 was made under.
--
-- All hand-written: no table changes, so drizzle-kit wrote an empty file
-- (`generate --custom`). The publication and the rights are this database's;
-- the role is the cluster's, and another database of the cluster — a local
-- stack's test databases, or one still behind this file — may still hold a
-- right of it, or be inside its own migration with a lock on it. So the drop
-- waits on nobody (`lock_timeout` held to a moment around it, then put back)
-- and gives up without error where another database holds a right of the
-- role (2BP01) or a lock on it (55P03), saying so in a NOTICE the
-- migrator's log prints: the last database to let go drops it. The Pilot is
-- one database, so there it goes here.
DROP PUBLICATION IF EXISTS powersync;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA wms FROM wms_sync;
--> statement-breakpoint
REVOKE ALL ON SCHEMA wms FROM wms_sync;
--> statement-breakpoint
DO $$
DECLARE
  waits text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '100ms', true);
  BEGIN
    DROP ROLE IF EXISTS wms_sync;
  EXCEPTION
    WHEN dependent_objects_still_exist OR lock_not_available THEN
      RAISE NOTICE 'wms_sync kept: % (another database of the cluster still holds it, and the last to let go drops it)', SQLERRM;
  END;
  PERFORM set_config('lock_timeout', waits, true);
END
$$;
