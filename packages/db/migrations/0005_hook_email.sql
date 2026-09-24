CREATE INDEX "user_account_email_idx" ON "wms"."user_account" USING btree ("email");
--> statement-breakpoint
-- Hand-written from here on (migrations/README.md). The access token hook of
-- 0002, replaced whole: an applied file is never edited, and a function is
-- replaced with CREATE OR REPLACE, which keeps its owner and its privileges,
-- so 0002's GRANT to supabase_auth_admin and the REVOKEs of 0002 and 0003
-- stand. What changed is the first-sign-in branch (issue #76). `unique
-- (auth_user_id)` is one company per login; when two companies had invited
-- one address, the update matched two rows, bound both to the login, violated
-- that key, and Auth refused the token on SQLSTATE 23505 with nothing to tell
-- the person. Now the branch binds only when exactly one open invitation
-- carries the address; otherwise it binds none and returns the event
-- unchanged, the token carries no company, and the API's 403 says so. Which
-- company such a login belongs to is decided with multi-company accounts. The
-- lookup by address runs on user_account_email_idx above (issue #75).
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  login uuid := (event->>'user_id')::uuid;
  address text := lower(event->'claims'->>'email');
  account record;
  invitations integer;
begin
  if login is null then
    return event;
  end if;
  select company_id, deactivated_at
    into account
    from wms.user_account
   where auth_user_id = login;
  if not found then
    -- First sign-in: the invited account whose address this is, if it is still
    -- open and if it is the only one. Two open invitations are bound to neither.
    select count(*)
      into invitations
      from wms.user_account
     where email = address
       and auth_user_id is null
       and deactivated_at is null;
    if invitations <> 1 then
      return event;
    end if;
    update wms.user_account
       set auth_user_id = login
     where email = address
       and auth_user_id is null
       and deactivated_at is null
    returning company_id, deactivated_at into account;
    if not found then
      return event;
    end if;
  end if;
  if account.deactivated_at is not null then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'This account is deactivated'));
  end if;
  return jsonb_set(
    event,
    '{claims,app_metadata}',
    jsonb_set(coalesce(event->'claims'->'app_metadata', '{}'::jsonb), '{company_id}', to_jsonb(account.company_id))
  );
end
$$;
