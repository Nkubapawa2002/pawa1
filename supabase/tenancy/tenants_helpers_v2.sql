-- =====================================================================
-- BUS TZ PAWA — Tenant resolution helpers (Slice 3)
-- Run AFTER tenants_schema.sql + tenants_migration.sql.
-- Idempotent.
--
-- Provides server-side functions n8n / Edge Functions can call to:
--   • Resolve a slug → tenant uuid
--   • Decrypt and load all of a tenant's runtime secrets in one shot
--
-- The passphrase is passed as an argument and gets bound via the
-- driver's parameter binding, so it never appears in query text/logs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. tenant_id_for_slug — fast lookup
-- ---------------------------------------------------------------------
create or replace function public.tenant_id_for_slug(_slug text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.tenants where slug = _slug and status = 'active' limit 1;
$$;

grant execute on function public.tenant_id_for_slug(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. tenant_get_secrets — decrypt all secrets in one round-trip
-- Returns NULL columns when the secret hasn't been configured yet.
-- ---------------------------------------------------------------------
create or replace function public.tenant_get_secrets(_tenant_id uuid, _passphrase text)
returns table (
  tenant_id                 uuid,
  slug                      text,
  display_name              text,
  status                    text,
  anthropic_api_key         text,
  anthropic_model           text,
  vapi_private_key          text,
  vapi_public_key           text,
  vapi_assistant_id         text,
  vapi_phone_number_id      text,
  at_api_key                text,
  at_username               text,
  at_sender_id              text,
  at_whatsapp_number        text,
  payment_gateway           text,
  payment_gateway_token     text,
  payment_gateway_secret    text,
  branding                  jsonb,
  languages                 text[],
  default_language          text,
  system_prompt_overrides   text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id,
    t.slug,
    t.display_name,
    t.status::text,
    public.tenant_decrypt(s.anthropic_api_key_enc, _passphrase),
    coalesce(s.anthropic_model, 'claude-opus-4-7'),
    public.tenant_decrypt(s.vapi_private_key_enc, _passphrase),
    s.vapi_public_key,
    s.vapi_assistant_id,
    s.vapi_phone_number_id,
    public.tenant_decrypt(s.at_api_key_enc, _passphrase),
    s.at_username,
    s.at_sender_id,
    s.at_whatsapp_number,
    s.payment_gateway,
    public.tenant_decrypt(s.payment_gateway_token_enc, _passphrase),
    public.tenant_decrypt(s.payment_gateway_secret_enc, _passphrase),
    coalesce(s.branding, '{}'::jsonb),
    coalesce(s.languages, array['sw','en']),
    coalesce(s.default_language, 'sw'),
    s.system_prompt_overrides
  from public.tenants t
  left join public.tenant_settings s on s.tenant_id = t.id
  where t.id = _tenant_id;
$$;

-- This function exposes plaintext secrets — only the service role and
-- the n8n role should be able to call it. Don't grant to anon.
revoke execute on function public.tenant_get_secrets(uuid, text) from public;
revoke execute on function public.tenant_get_secrets(uuid, text) from anon, authenticated;
-- service_role implicitly has access.

-- ---------------------------------------------------------------------
-- 3. tenant_resolve_by_slug — combined helper used by every n8n tool
--    flow as the FIRST DB step. Returns one row with tenant_id + all
--    plaintext keys decrypted with the passphrase.
-- ---------------------------------------------------------------------
create or replace function public.tenant_resolve_by_slug(_slug text, _passphrase text)
returns table (
  tenant_id                 uuid,
  slug                      text,
  display_name              text,
  status                    text,
  anthropic_api_key         text,
  anthropic_model           text,
  vapi_private_key          text,
  vapi_public_key           text,
  vapi_assistant_id         text,
  vapi_phone_number_id      text,
  at_api_key                text,
  at_username               text,
  at_sender_id              text,
  at_whatsapp_number        text,
  payment_gateway           text,
  payment_gateway_token     text,
  payment_gateway_secret    text,
  branding                  jsonb,
  languages                 text[],
  default_language          text,
  system_prompt_overrides   text
)
language sql
stable
security definer
set search_path = public
as $$
  select g.* from public.tenant_get_secrets(
    public.tenant_id_for_slug(_slug),
    _passphrase
  ) g;
$$;

revoke execute on function public.tenant_resolve_by_slug(text, text) from public;
revoke execute on function public.tenant_resolve_by_slug(text, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. update_tenant_secret — single-key writer used by the
--    update-tenant-keys Edge Function.
-- Accepts the passphrase + plaintext, encrypts, stores ciphertext.
-- ---------------------------------------------------------------------
create or replace function public.update_tenant_secret(
  _tenant_id uuid,
  _passphrase text,
  _key_name text,
  _value text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  enc_col text;
  plain_col text;
begin
  -- Whitelist of writable columns, mapping to encrypted/plain destinations.
  case _key_name
    when 'anthropic_api_key'        then enc_col := 'anthropic_api_key_enc'; plain_col := null;
    when 'anthropic_model'          then enc_col := null; plain_col := 'anthropic_model';
    when 'vapi_private_key'         then enc_col := 'vapi_private_key_enc'; plain_col := null;
    when 'vapi_public_key'          then enc_col := null; plain_col := 'vapi_public_key';
    when 'vapi_assistant_id'        then enc_col := null; plain_col := 'vapi_assistant_id';
    when 'vapi_phone_number_id'     then enc_col := null; plain_col := 'vapi_phone_number_id';
    when 'at_api_key'               then enc_col := 'at_api_key_enc'; plain_col := null;
    when 'at_username'              then enc_col := null; plain_col := 'at_username';
    when 'at_sender_id'             then enc_col := null; plain_col := 'at_sender_id';
    when 'at_whatsapp_number'       then enc_col := null; plain_col := 'at_whatsapp_number';
    when 'payment_gateway'          then enc_col := null; plain_col := 'payment_gateway';
    when 'payment_gateway_token'    then enc_col := 'payment_gateway_token_enc'; plain_col := null;
    when 'payment_gateway_secret'   then enc_col := 'payment_gateway_secret_enc'; plain_col := null;
    else
      raise exception 'unknown_key %', _key_name;
  end case;

  -- Make sure the row exists.
  insert into public.tenant_settings (tenant_id) values (_tenant_id)
  on conflict (tenant_id) do nothing;

  if enc_col is not null then
    execute format(
      'update public.tenant_settings set %I = public.tenant_encrypt($1, $2) where tenant_id = $3',
      enc_col
    ) using _value, _passphrase, _tenant_id;
  else
    execute format(
      'update public.tenant_settings set %I = $1 where tenant_id = $2',
      plain_col
    ) using _value, _tenant_id;
  end if;
end $$;

revoke execute on function public.update_tenant_secret(uuid, text, text, text) from public;
revoke execute on function public.update_tenant_secret(uuid, text, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. update_tenant_branding — non-secret branding writer (no passphrase).
-- ---------------------------------------------------------------------
create or replace function public.update_tenant_branding(
  _tenant_id uuid,
  _branding jsonb,
  _languages text[],
  _default_language text,
  _system_prompt_overrides text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.tenant_settings (tenant_id, branding, languages, default_language, system_prompt_overrides)
  values (_tenant_id, coalesce(_branding,'{}'::jsonb),
                      coalesce(_languages, array['sw','en']),
                      coalesce(_default_language, 'sw'),
                      _system_prompt_overrides)
  on conflict (tenant_id) do update
    set branding = excluded.branding,
        languages = excluded.languages,
        default_language = excluded.default_language,
        system_prompt_overrides = excluded.system_prompt_overrides,
        updated_at = now();
$$;

grant execute on function public.update_tenant_branding(uuid, jsonb, text[], text, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- 6. tenant_secret_status — booleans showing which keys are configured,
--    safe to expose to the browser/dashboard.
-- ---------------------------------------------------------------------
create or replace view public.tenant_secret_status
with (security_invoker = true) as
  select
    tenant_id,
    (anthropic_api_key_enc      is not null) as anthropic_configured,
    (vapi_private_key_enc       is not null) as vapi_private_configured,
    (vapi_assistant_id          is not null) as vapi_assistant_configured,
    (at_api_key_enc             is not null) as at_configured,
    (payment_gateway_token_enc  is not null) as payment_configured
  from public.tenant_settings;

grant select on public.tenant_secret_status to authenticated;

-- ---------------------------------------------------------------------
-- 7. log_agent_action — convenience for any tool to log itself
--    without 5 lines of boilerplate.
-- ---------------------------------------------------------------------
create or replace function public.log_agent_action(
  _conversation_id text,
  _channel text,
  _tool_name text,
  _arguments jsonb,
  _result_summary text,
  _latency_ms integer,
  _ok boolean,
  _error text
) returns bigint
language sql
as $$
  insert into public.agent_actions_log
    (conversation_id, channel, tool_name, arguments, result_summary, latency_ms, ok, error)
  values
    (_conversation_id, _channel, _tool_name, _arguments, _result_summary, _latency_ms, _ok, _error)
  returning id;
$$;

grant execute on function public.log_agent_action(text, text, text, jsonb, text, integer, boolean, text)
  to authenticated, service_role;
