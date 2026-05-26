-- =====================================================================
-- BUS TZ PAWA — Multi-tenant identity schema
-- Run AFTER schema.sql, schema_v2..v9.sql. Adds the SaaS tenancy layer.
-- Idempotent.
--
-- Design summary
-- ---------------
-- A "tenant" is a bus / cargo company that signs up to use Pawa. Each
-- tenant gets isolated data (RLS-enforced), its own AI agent config
-- (Claude key, VAPI assistant, branding), and one or more users.
--
-- Auth: leverages Supabase auth.users. Users are linked to tenants via
-- tenant_users (many-to-many, with a role per membership). The first
-- user of a tenant is its owner.
--
-- Encryption of secret keys (Claude / VAPI) uses pgcrypto with a
-- pre-shared passphrase the Edge Function holds in env. The encrypted
-- bytes are visible to anyone with table access; decryption requires
-- the passphrase. RLS prevents tenants reading each other's settings.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Status enum
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'tenant_status') then
    create type tenant_status as enum (
      'pending_approval',
      'active',
      'suspended',
      'rejected'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'tenant_role') then
    create type tenant_role as enum (
      'owner',     -- billing, deletion, owner-only settings
      'admin',     -- can edit tenant settings, invite users
      'agent',     -- staff member who handles bookings/cargo
      'staff'      -- read-only or limited write
    );
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. tenants
-- ---------------------------------------------------------------------
create table if not exists public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique
                  check (slug ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$'),
  display_name    text not null,
  legal_name      text,
  contact_email   text not null,
  contact_phone   text,
  country         text not null default 'TZ',
  status          tenant_status not null default 'pending_approval',
  owner_user_id   uuid references auth.users(id) on delete set null,
  approved_by     uuid references auth.users(id),
  approved_at     timestamptz,
  rejection_note  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_tenants_status on public.tenants (status);
create index if not exists idx_tenants_owner  on public.tenants (owner_user_id);

-- Touch updated_at
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_tenants_updated on public.tenants;
create trigger trg_tenants_updated before update on public.tenants
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. tenant_users (membership)
-- ---------------------------------------------------------------------
create table if not exists public.tenant_users (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        tenant_role not null default 'staff',
  invited_by  uuid references auth.users(id),
  joined_at   timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists idx_tenant_users_user on public.tenant_users (user_id);

-- ---------------------------------------------------------------------
-- 4. tenant_settings (per-tenant runtime config — agent + branding)
-- ---------------------------------------------------------------------
-- Encrypted columns: store ciphertext; Edge Functions decrypt with the
-- TENANT_SECRET_PASSPHRASE env var via pgp_sym_decrypt.
create table if not exists public.tenant_settings (
  tenant_id                  uuid primary key references public.tenants(id) on delete cascade,

  -- AI / voice agent config
  anthropic_api_key_enc      bytea,
  anthropic_model            text default 'claude-opus-4-7',
  vapi_private_key_enc       bytea,
  vapi_public_key            text,
  vapi_assistant_id          text,
  vapi_phone_number_id       text,

  -- Africa's Talking + payment gateway (per-tenant)
  at_api_key_enc             bytea,
  at_username                text,
  at_sender_id               text,
  at_whatsapp_number         text,
  payment_gateway            text,             -- 'selcom' | 'clickpesa' | ...
  payment_gateway_token_enc  bytea,
  payment_gateway_secret_enc bytea,

  -- Branding & UX
  branding                   jsonb not null default jsonb_build_object(
    'logo_url', null,
    'primary_color', '#0B6E4F',
    'company_name_display', null,
    'agent_name', 'PAWA',
    'tagline', null
  ),
  languages                  text[] not null default array['sw','en'],
  default_language           text not null default 'sw',
  system_prompt_overrides    text,             -- appended to base agent prompt

  -- Limits / billing posture (free signup for now; populate when Stripe lands)
  monthly_call_quota         integer,
  monthly_sms_quota          integer,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

drop trigger if exists trg_tenant_settings_updated on public.tenant_settings;
create trigger trg_tenant_settings_updated before update on public.tenant_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 5. tenant_invites (invite teammates by email)
-- ---------------------------------------------------------------------
create table if not exists public.tenant_invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  email       text not null,
  role        tenant_role not null default 'staff',
  token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by  uuid references auth.users(id),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_tenant_invites_email on public.tenant_invites (email);
create index if not exists idx_tenant_invites_tenant on public.tenant_invites (tenant_id);

-- ---------------------------------------------------------------------
-- 6. Helper: tenants the current authed user belongs to
--    Used by RLS policies on every tenant-scoped table.
-- ---------------------------------------------------------------------
create or replace function public.current_user_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.tenant_users where user_id = auth.uid();
$$;

-- super-admin? (matches admins table created in schema_v2.sql)
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(
      (auth.jwt() ->> 'email'),
      ''
    ))
  );
$$;

-- ---------------------------------------------------------------------
-- 7. Encryption helpers (Edge Function only)
--    These functions are SECURITY DEFINER so the passphrase env var
--    can be passed in safely without leaking via SQL logs.
-- ---------------------------------------------------------------------
create or replace function public.tenant_encrypt(plaintext text, passphrase text)
returns bytea
language sql
immutable
as $$
  select case when plaintext is null or plaintext = '' then null
              else pgp_sym_encrypt(plaintext, passphrase) end;
$$;

create or replace function public.tenant_decrypt(ciphertext bytea, passphrase text)
returns text
language sql
immutable
as $$
  select case when ciphertext is null then null
              else pgp_sym_decrypt(ciphertext, passphrase) end;
$$;

-- ---------------------------------------------------------------------
-- 8. RLS for the tenancy tables themselves
-- ---------------------------------------------------------------------
alter table public.tenants          enable row level security;
alter table public.tenant_users     enable row level security;
alter table public.tenant_settings  enable row level security;
alter table public.tenant_invites   enable row level security;

-- tenants: a member sees their tenant; super-admins see all.
drop policy if exists "tenant members read" on public.tenants;
create policy "tenant members read" on public.tenants for select to authenticated
  using (
    is_super_admin() or
    id in (select public.current_user_tenant_ids())
  );

drop policy if exists "tenant signup insert" on public.tenants;
create policy "tenant signup insert" on public.tenants for insert to authenticated
  with check (auth.uid() = owner_user_id and status = 'pending_approval');

drop policy if exists "tenant owner update" on public.tenants;
create policy "tenant owner update" on public.tenants for update to authenticated
  using (
    owner_user_id = auth.uid() or is_super_admin()
  )
  with check (
    owner_user_id = auth.uid() or is_super_admin()
  );

-- tenant_users: members see their own tenant rows; super-admin sees all.
drop policy if exists "tenant_users self read" on public.tenant_users;
create policy "tenant_users self read" on public.tenant_users for select to authenticated
  using (
    is_super_admin() or
    user_id = auth.uid() or
    tenant_id in (select public.current_user_tenant_ids())
  );

drop policy if exists "tenant_users owner write" on public.tenant_users;
create policy "tenant_users owner write" on public.tenant_users for all to authenticated
  using (
    is_super_admin() or
    exists(
      select 1 from public.tenants t
      where t.id = tenant_users.tenant_id
        and (t.owner_user_id = auth.uid())
    )
  )
  with check (
    is_super_admin() or
    exists(
      select 1 from public.tenants t
      where t.id = tenant_users.tenant_id
        and t.owner_user_id = auth.uid()
    )
  );

-- tenant_settings: only members of the tenant; only owner/admin can write.
drop policy if exists "tenant_settings read" on public.tenant_settings;
create policy "tenant_settings read" on public.tenant_settings for select to authenticated
  using (
    is_super_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  );

drop policy if exists "tenant_settings owner write" on public.tenant_settings;
create policy "tenant_settings owner write" on public.tenant_settings for all to authenticated
  using (
    is_super_admin() or
    exists(
      select 1 from public.tenant_users tu
      where tu.tenant_id = tenant_settings.tenant_id
        and tu.user_id = auth.uid()
        and tu.role in ('owner','admin')
    )
  )
  with check (
    is_super_admin() or
    exists(
      select 1 from public.tenant_users tu
      where tu.tenant_id = tenant_settings.tenant_id
        and tu.user_id = auth.uid()
        and tu.role in ('owner','admin')
    )
  );

-- tenant_invites: tenant admins manage; invitee can read their own by token via Edge Fn.
drop policy if exists "tenant_invites read" on public.tenant_invites;
create policy "tenant_invites read" on public.tenant_invites for select to authenticated
  using (
    is_super_admin() or
    tenant_id in (select public.current_user_tenant_ids())
  );

drop policy if exists "tenant_invites admin write" on public.tenant_invites;
create policy "tenant_invites admin write" on public.tenant_invites for all to authenticated
  using (
    is_super_admin() or
    exists(
      select 1 from public.tenant_users tu
      where tu.tenant_id = tenant_invites.tenant_id
        and tu.user_id = auth.uid()
        and tu.role in ('owner','admin')
    )
  )
  with check (
    is_super_admin() or
    exists(
      select 1 from public.tenant_users tu
      where tu.tenant_id = tenant_invites.tenant_id
        and tu.user_id = auth.uid()
        and tu.role in ('owner','admin')
    )
  );

-- Anonymous users: can post a signup (insert only) via Edge Function.
grant select, insert on public.tenants         to anon, authenticated;
grant select         on public.tenant_users    to anon, authenticated;
grant select         on public.tenant_settings to authenticated;
grant select, insert on public.tenant_invites  to authenticated;

-- ---------------------------------------------------------------------
-- 9. Demo tenant — represents the existing Tanzania data set
-- ---------------------------------------------------------------------
insert into public.tenants (id, slug, display_name, legal_name, contact_email, contact_phone, status, owner_user_id, approved_at)
values (
  '00000000-0000-0000-0000-000000000001',
  'bus-tz-pawa',
  'Bus TZ PAWA',
  'Bus TZ PAWA Limited',
  'pawa4761@gmail.com',
  null,
  'active',
  null,
  now()
)
on conflict (slug) do nothing;

insert into public.tenant_settings (
  tenant_id,
  anthropic_model,
  branding,
  languages,
  default_language
)
values (
  '00000000-0000-0000-0000-000000000001',
  'claude-opus-4-7',
  jsonb_build_object(
    'logo_url', null,
    'primary_color', '#0B6E4F',
    'company_name_display', 'Bus TZ PAWA',
    'agent_name', 'PAWA',
    'tagline', 'Tunakufanya usafiri kwa urahisi, usalama, na starehe.'
  ),
  array['sw','en'],
  'sw'
)
on conflict (tenant_id) do nothing;

-- Add a comment marker so future migrations can detect the demo tenant id.
comment on column public.tenants.id is 'Demo tenant id is 00000000-0000-0000-0000-000000000001';
