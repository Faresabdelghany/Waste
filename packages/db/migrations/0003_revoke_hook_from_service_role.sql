-- The access token hook is revoked from service_role too. Hand-written
-- (drizzle-kit generate --custom); the privilege belongs to no table.
--
-- 0002 revoked EXECUTE from PUBLIC, anon and authenticated, but the owner's
-- default privileges in `public` grant it to service_role as well, and `public`
-- is the schema the Data API exposes. A service-key caller could therefore
-- POST /rest/v1/rpc/custom_access_token_hook with an event of its own making
-- and bind a login of its choosing to an invited, still unbound account. Auth
-- connects as supabase_auth_admin and is the only caller the hook needs.
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM service_role;
