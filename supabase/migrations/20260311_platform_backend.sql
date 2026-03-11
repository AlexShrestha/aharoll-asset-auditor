create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists vector;
create extension if not exists btree_gin;
create extension if not exists "uuid-ossp";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'common_status') then
    create type common_status as enum ('active', 'inactive', 'archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'store_connection_status') then
    create type store_connection_status as enum ('connected', 'disconnected', 'syncing', 'error');
  end if;
  if not exists (select 1 from pg_type where typname = 'sync_run_status') then
    create type sync_run_status as enum ('queued', 'running', 'completed', 'failed', 'canceled');
  end if;
  if not exists (select 1 from pg_type where typname = 'audit_run_status') then
    create type audit_run_status as enum ('queued', 'discovering', 'processing', 'completed', 'failed', 'canceled');
  end if;
  if not exists (select 1 from pg_type where typname = 'asset_status') then
    create type asset_status as enum ('active', 'draft', 'archived', 'deleted');
  end if;
  if not exists (select 1 from pg_type where typname = 'asset_origin') then
    create type asset_origin as enum ('shopify', 'generated', 'uploaded', 'imported', 'external');
  end if;
  if not exists (select 1 from pg_type where typname = 'finding_severity') then
    create type finding_severity as enum ('critical', 'high', 'medium', 'low', 'info', 'none');
  end if;
  if not exists (select 1 from pg_type where typname = 'finding_status') then
    create type finding_status as enum ('open', 'accepted', 'ignored', 'resolved', 'regressed');
  end if;
  if not exists (select 1 from pg_type where typname = 'remediation_status') then
    create type remediation_status as enum ('queued', 'running', 'needs_review', 'approved', 'applied', 'failed', 'canceled');
  end if;
  if not exists (select 1 from pg_type where typname = 'feedback_label') then
    create type feedback_label as enum ('helpful', 'not_helpful', 'correct', 'incorrect', 'preferred', 'rejected');
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text null,
  settings jsonb not null default '{}'::jsonb,
  status common_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
  invited_by uuid null,
  joined_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table if not exists public.workspace_api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text null,
  key_hash text not null,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.external_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  external_user_id text not null,
  email text null,
  display_name text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_user_id)
);

create table if not exists public.workspace_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade unique,
  defaults jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(target_workspace_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = any(allowed_roles)
  );
$$;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  shop_domain text not null,
  store_url text not null,
  normalized_store_url text not null,
  shopify_store_id text null,
  store_name text null,
  currency text null,
  locale text null,
  timezone text null,
  connection_status store_connection_status not null default 'connected',
  app_install_state text null,
  last_synced_at timestamptz null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, shop_domain)
);

create index if not exists stores_workspace_domain_idx on public.stores (workspace_id, shop_domain);
create index if not exists stores_workspace_status_idx on public.stores (workspace_id, connection_status);

create table if not exists public.store_tokens (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null default 'shopify',
  access_token_encrypted text not null,
  scopes text[] not null default '{}'::text[],
  expires_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shopify_installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  shop_domain text not null unique,
  install_status text not null check (install_status in ('initiated', 'authenticated', 'registered', 'completed', 'failed', 'uninstalled')),
  oauth_state text null,
  installed_by_email text null,
  installed_by_name text null,
  installed_by_shopify_user_id text null,
  install_payload jsonb not null default '{}'::jsonb,
  error_message text null,
  installed_at timestamptz null,
  uninstalled_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  status sync_run_status not null,
  sync_type text not null check (sync_type in ('full_catalog', 'incremental_products', 'collections', 'assets_only')),
  started_at timestamptz null,
  completed_at timestamptz null,
  stats jsonb not null default '{}'::jsonb,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists store_sync_runs_workspace_store_idx on public.store_sync_runs (workspace_id, store_id, created_at desc);
create index if not exists store_sync_runs_status_idx on public.store_sync_runs (status, created_at desc);

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  external_id text not null,
  handle text null,
  title text not null,
  kind text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, external_id)
);

create index if not exists collections_workspace_store_idx on public.collections (workspace_id, store_id, title);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  external_id text not null,
  handle text not null,
  title text not null,
  body_html text null,
  vendor text null,
  product_type text null,
  status text null,
  published_at timestamptz null,
  featured_image_asset_id uuid null,
  seo_title text null,
  seo_description text null,
  tags text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  raw_shopify_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, external_id)
);

create index if not exists products_workspace_store_type_idx on public.products (workspace_id, store_id, product_type);
create index if not exists products_workspace_handle_idx on public.products (workspace_id, handle);
create index if not exists products_store_published_idx on public.products (store_id, published_at desc);
create index if not exists products_tags_gin_idx on public.products using gin (tags);
create index if not exists products_title_trgm_idx on public.products using gin (title gin_trgm_ops);

create table if not exists public.product_collections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  collection_id uuid not null references public.collections(id) on delete cascade,
  position integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, collection_id)
);

create table if not exists public.variants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  external_id text not null,
  sku text null,
  barcode text null,
  title text null,
  position integer null,
  price numeric(12, 2) null,
  compare_at_price numeric(12, 2) null,
  inventory_quantity integer null,
  option_values jsonb not null default '{}'::jsonb,
  image_asset_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  raw_shopify_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, external_id)
);

create index if not exists variants_workspace_product_idx on public.variants (workspace_id, product_id, position);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid null references public.products(id) on delete set null,
  variant_id uuid null references public.variants(id) on delete set null,
  asset_type text not null check (asset_type in ('image', 'video', 'model3d', 'document')),
  role text null,
  origin asset_origin not null,
  status asset_status not null default 'active',
  external_asset_id text null,
  current_version_id uuid null,
  position integer null,
  alt_text text null,
  source_url text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assets_product_role_status_idx on public.assets (product_id, role, status);
create index if not exists assets_variant_role_status_idx on public.assets (variant_id, role, status);

create table if not exists public.asset_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  version_no integer not null,
  storage_bucket text not null,
  storage_path text not null,
  public_url text null,
  mime_type text null,
  file_size_bytes bigint null,
  width integer null,
  height integer null,
  duration_ms integer null,
  sha256 text null,
  phash text null,
  vision_labels jsonb not null default '[]'::jsonb,
  dominant_colors jsonb not null default '[]'::jsonb,
  embedding vector(1536) null,
  caption text null,
  ocr_text text null,
  extracted_metadata jsonb not null default '{}'::jsonb,
  source_generation_job_id uuid null,
  created_by_user_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, version_no)
);

create index if not exists asset_versions_asset_created_idx on public.asset_versions (asset_id, created_at desc);
create index if not exists asset_versions_caption_trgm_idx on public.asset_versions using gin (caption gin_trgm_ops);

create table if not exists public.asset_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  entity_type text not null check (entity_type in ('product', 'variant', 'finding', 'remediation_job')),
  entity_id uuid not null,
  relation_role text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists asset_links_entity_idx on public.asset_links (entity_type, entity_id);

create table if not exists public.asset_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  asset_version_id uuid null references public.asset_versions(id) on delete set null,
  event_type text not null,
  actor_type text not null check (actor_type in ('user', 'system', 'worker', 'model', 'shopify_webhook')),
  actor_id text null,
  source_table text null,
  source_row_id uuid null,
  before_state jsonb null,
  after_state jsonb null,
  diff jsonb null,
  reason text null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists asset_events_asset_occurred_idx on public.asset_events (asset_id, occurred_at desc);
create index if not exists asset_events_workspace_type_idx on public.asset_events (workspace_id, event_type, occurred_at desc);

create table if not exists public.audit_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  requested_by_user_id uuid null,
  status audit_run_status not null,
  scope_type text not null check (scope_type in ('all_products', 'collection', 'product_ids', 'manual_selection')),
  scope_filters jsonb not null default '{}'::jsonb,
  requested_checks text[] not null default '{}'::text[],
  catalog_snapshot_version text null,
  total_products integer not null default 0,
  queued_products integer not null default 0,
  processed_products integer not null default 0,
  failed_products integer not null default 0,
  progress_pct integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  callback_url text null,
  callback_token text null,
  last_error text null,
  lock_token uuid null,
  locked_at timestamptz null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists audit_runs_workspace_store_created_idx on public.audit_runs (workspace_id, store_id, created_at desc);
create index if not exists audit_runs_status_created_idx on public.audit_runs (status, created_at desc);
create index if not exists audit_runs_locked_idx on public.audit_runs (locked_at);

create table if not exists public.audit_run_products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  audit_run_id uuid not null references public.audit_runs(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_count integer not null default 0,
  asset_count integer not null default 0,
  product_snapshot jsonb not null,
  status text not null check (status in ('queued', 'processing', 'processed', 'failed')),
  result_severity finding_severity null,
  result_summary text null,
  error_message text null,
  attempts integer not null default 0,
  started_at timestamptz null,
  processed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (audit_run_id, product_id)
);

create index if not exists audit_run_products_run_status_idx on public.audit_run_products (audit_run_id, status, created_at desc);
create index if not exists audit_run_products_product_idx on public.audit_run_products (product_id, processed_at desc);

create table if not exists public.finding_catalog (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null,
  default_severity finding_severity not null,
  description text not null,
  is_user_visible boolean not null default true,
  is_trainable boolean not null default true,
  fix_strategy text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finding_occurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  audit_run_id uuid not null references public.audit_runs(id) on delete cascade,
  audit_run_product_id uuid not null references public.audit_run_products(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid null references public.variants(id) on delete set null,
  finding_catalog_id uuid not null references public.finding_catalog(id),
  severity finding_severity not null,
  status finding_status not null default 'open',
  title text not null,
  summary text not null,
  recommendation text null,
  evidence jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  rule_version text not null,
  model_version text null,
  fingerprint text not null,
  is_regression boolean not null default false,
  supersedes_occurrence_id uuid null references public.finding_occurrences(id) on delete set null,
  resolved_in_audit_run_id uuid null references public.audit_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finding_occurrences_workspace_product_created_idx on public.finding_occurrences (workspace_id, product_id, created_at desc);
create index if not exists finding_occurrences_workspace_catalog_created_idx on public.finding_occurrences (workspace_id, finding_catalog_id, created_at desc);
create index if not exists finding_occurrences_audit_product_idx on public.finding_occurrences (audit_run_id, product_id);
create index if not exists finding_occurrences_status_severity_idx on public.finding_occurrences (status, severity);
create index if not exists finding_occurrences_fingerprint_idx on public.finding_occurrences (workspace_id, fingerprint, created_at desc);

create table if not exists public.finding_current_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid null references public.variants(id) on delete set null,
  finding_catalog_id uuid not null references public.finding_catalog(id),
  fingerprint text not null,
  latest_occurrence_id uuid not null references public.finding_occurrences(id) on delete cascade,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_resolved_at timestamptz null,
  status finding_status not null,
  times_seen integer not null default 1,
  times_regressed integer not null default 0,
  current_severity finding_severity not null,
  trend jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, fingerprint)
);

create index if not exists finding_current_state_workspace_status_idx on public.finding_current_state (workspace_id, status, current_severity);
create index if not exists finding_current_state_product_idx on public.finding_current_state (product_id, updated_at desc);

create table if not exists public.finding_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  finding_occurrence_id uuid null references public.finding_occurrences(id) on delete cascade,
  finding_current_state_id uuid null references public.finding_current_state(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  parent_comment_id uuid null references public.finding_comments(id) on delete cascade,
  author_user_id uuid not null,
  body text not null,
  is_internal boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  audit_run_id uuid null references public.audit_runs(id) on delete set null,
  author_user_id uuid not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.remediation_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid null references public.variants(id) on delete set null,
  finding_occurrence_id uuid null references public.finding_occurrences(id) on delete set null,
  finding_current_state_id uuid null references public.finding_current_state(id) on delete set null,
  action_type text not null,
  status remediation_status not null,
  requested_by_user_id uuid null,
  approved_by_user_id uuid null,
  input_payload jsonb not null,
  output_payload jsonb null,
  error_message text null,
  model_name text null,
  model_version text null,
  cost_usd numeric(12, 4) null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.remediation_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  remediation_job_id uuid not null references public.remediation_jobs(id) on delete cascade,
  step_no integer not null,
  step_type text not null,
  status text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb null,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recommendation_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  finding_occurrence_id uuid null references public.finding_occurrences(id) on delete set null,
  remediation_job_id uuid null references public.remediation_jobs(id) on delete set null,
  product_id uuid not null references public.products(id) on delete cascade,
  user_id uuid not null,
  feedback_label feedback_label not null,
  score integer null,
  freeform_comment text null,
  expected_output jsonb null,
  actual_output jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.search_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type text not null check (entity_type in ('product', 'asset', 'finding_occurrence', 'finding_current_state', 'product_comment', 'finding_comment')),
  entity_id uuid not null,
  store_id uuid null references public.stores(id) on delete cascade,
  product_id uuid null references public.products(id) on delete cascade,
  title text null,
  body text not null,
  keywords text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  tsv tsvector null,
  embedding vector(1536) null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists search_documents_tsv_idx on public.search_documents using gin (tsv);
create index if not exists search_documents_workspace_entity_idx on public.search_documents (workspace_id, entity_type, created_at desc);
create index if not exists search_documents_title_trgm_idx on public.search_documents using gin (title gin_trgm_ops);

create table if not exists public.product_quality_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  audit_run_id uuid not null references public.audit_runs(id) on delete cascade,
  quality_score numeric(8, 2) not null,
  open_count integer not null default 0,
  critical_count integer not null default 0,
  high_count integer not null default 0,
  medium_count integer not null default 0,
  low_count integer not null default 0,
  info_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists product_quality_snapshots_product_idx on public.product_quality_snapshots (workspace_id, product_id, created_at desc);

create table if not exists public.audit_queue_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  audit_run_id uuid not null references public.audit_runs(id) on delete cascade unique,
  audit_job_id uuid not null references public.audit_jobs(id) on delete cascade unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create materialized view if not exists public.mv_daily_finding_stats as
select
  fo.workspace_id,
  fo.store_id,
  date_trunc('day', fo.created_at)::date as date,
  fc.code as finding_code,
  fo.severity,
  fo.status,
  count(*)::integer as occurrence_count
from public.finding_occurrences fo
join public.finding_catalog fc on fc.id = fo.finding_catalog_id
group by
  fo.workspace_id,
  fo.store_id,
  date_trunc('day', fo.created_at)::date,
  fc.code,
  fo.severity,
  fo.status;

create unique index if not exists mv_daily_finding_stats_unique_idx
  on public.mv_daily_finding_stats (workspace_id, store_id, date, finding_code, severity, status);

insert into public.finding_catalog (code, name, category, default_severity, description, fix_strategy)
values
  ('missing_color_image', 'Missing color image', 'asset_coverage', 'critical', 'A color variant exists without dedicated imagery.', 'generate_missing_image'),
  ('missing_hero_image', 'Missing hero image', 'asset_coverage', 'critical', 'No clear hero image exists for the product or variant.', 'generate_missing_image'),
  ('missing_variant_image', 'Missing variant image', 'variant_consistency', 'critical', 'A buyable visual variant has no assigned image.', 'create_variant_asset'),
  ('missing_detail_closeup', 'Missing detail closeup', 'asset_coverage', 'high', 'A premium or detailed product lacks close-up detail coverage.', 'generate_missing_image'),
  ('missing_alt_text', 'Missing alt text', 'seo', 'low', 'Asset alt text is missing or empty.', 'write_alt_text'),
  ('missing_video', 'Missing video', 'asset_coverage', 'medium', 'No supporting video is present where beneficial.', 'generate_missing_video'),
  ('oversized_image_payload', 'Oversized image payload', 'performance', 'high', 'Combined image payload is larger than acceptable thresholds.', 'replace_asset'),
  ('background_inconsistent', 'Background inconsistent', 'consistency', 'medium', 'Background styling changes across the same product gallery.', 'replace_asset'),
  ('aspect_ratio_inconsistent', 'Aspect ratio inconsistent', 'consistency', 'medium', 'Assets in the same gallery have inconsistent aspect ratios.', 'replace_asset'),
  ('duplicate_asset', 'Duplicate asset', 'asset_quality', 'medium', 'Duplicate or near-duplicate assets exist within the gallery.', 'resolve_duplicate_asset'),
  ('missing_seo_title', 'Missing SEO title', 'seo', 'low', 'Product SEO title is missing.', 'update_seo'),
  ('missing_seo_description', 'Missing SEO description', 'seo', 'low', 'Product SEO description is missing.', 'update_seo'),
  ('weak_product_copy', 'Weak product copy', 'seo', 'low', 'Product body copy is too weak or generic.', 'update_seo'),
  ('empty_alt_text', 'Empty alt text', 'seo', 'low', 'Alt text field is present but empty.', 'write_alt_text'),
  ('low_resolution_asset', 'Low resolution asset', 'asset_quality', 'medium', 'Asset resolution is below acceptable quality.', 'replace_asset')
on conflict (code) do update set
  name = excluded.name,
  category = excluded.category,
  default_severity = excluded.default_severity,
  description = excluded.description,
  fix_strategy = excluded.fix_strategy,
  updated_at = now();

do $$
declare
  tbl text;
  tenant_tables text[] := array[
    'workspaces','workspace_members','workspace_api_keys','external_identities','workspace_preferences',
    'stores','store_tokens','shopify_installations','store_sync_runs',
    'collections','products','product_collections','variants',
    'assets','asset_versions','asset_links','asset_events',
    'audit_runs','audit_run_products','finding_catalog','finding_occurrences','finding_current_state',
    'finding_comments','product_comments','remediation_jobs','remediation_steps','recommendation_feedback',
    'search_documents','product_quality_snapshots','audit_queue_links'
  ];
  mutable_tables text[] := array[
    'workspace_members','external_identities','workspace_preferences',
    'stores','shopify_installations','store_sync_runs',
    'collections','products','product_collections','variants',
    'assets','asset_versions','asset_links','asset_events',
    'audit_runs','audit_run_products','finding_occurrences','finding_current_state',
    'finding_comments','product_comments','remediation_jobs','remediation_steps','recommendation_feedback',
    'search_documents','audit_queue_links'
  ];
begin
  foreach tbl in array tenant_tables loop
    execute format('alter table public.%I enable row level security', tbl);
  end loop;

  foreach tbl in array tenant_tables loop
    if tbl = 'workspaces' then
      execute format('drop policy if exists %I_member_read on public.%I', tbl, tbl);
      execute format(
        'create policy %I_member_read on public.%I for select to authenticated using (public.is_workspace_member(id))',
        tbl, tbl
      );
    elsif tbl = 'finding_catalog' then
      execute format('drop policy if exists %I_read_all on public.%I', tbl, tbl);
      execute format(
        'create policy %I_read_all on public.%I for select to authenticated using (true)',
        tbl, tbl
      );
    elsif tbl = 'store_tokens' then
      execute format('drop policy if exists %I_admin_read on public.%I', tbl, tbl);
      execute format(
        'create policy %I_admin_read on public.%I for select to authenticated using (public.has_workspace_role((select workspace_id from public.stores s where s.id = store_id), array[''owner'',''admin'']))',
        tbl, tbl
      );
    elsif tbl = 'workspace_api_keys' then
      execute format('drop policy if exists %I_admin_read on public.%I', tbl, tbl);
      execute format(
        'create policy %I_admin_read on public.%I for select to authenticated using (public.has_workspace_role(workspace_id, array[''owner'',''admin'']))',
        tbl, tbl
      );
    else
      execute format('drop policy if exists %I_member_read on public.%I', tbl, tbl);
      execute format(
        'create policy %I_member_read on public.%I for select to authenticated using (public.is_workspace_member(workspace_id))',
        tbl, tbl
      );
    end if;
  end loop;

  foreach tbl in array mutable_tables loop
    execute format('drop policy if exists %I_editor_write on public.%I', tbl, tbl);
    execute format(
      'create policy %I_editor_write on public.%I for all to authenticated using (public.has_workspace_role(workspace_id, array[''owner'',''admin'',''editor''])) with check (public.has_workspace_role(workspace_id, array[''owner'',''admin'',''editor'']))',
      tbl, tbl
    );
  end loop;

  execute 'drop policy if exists workspaces_admin_write on public.workspaces';
  execute 'create policy workspaces_admin_write on public.workspaces for update to authenticated using (public.has_workspace_role(id, array[''owner'',''admin''])) with check (public.has_workspace_role(id, array[''owner'',''admin'']))';
end $$;

do $$
declare
  tbl text;
  trigger_tables text[] := array[
    'workspaces','workspace_members','workspace_api_keys','external_identities','workspace_preferences',
    'stores','store_tokens','shopify_installations','store_sync_runs','collections','products','product_collections',
    'variants','assets','asset_versions','asset_links','finding_catalog','audit_runs','audit_run_products',
    'finding_occurrences','finding_current_state','finding_comments','product_comments','remediation_jobs',
    'remediation_steps','recommendation_feedback','search_documents','audit_queue_links'
  ];
begin
  foreach tbl in array trigger_tables loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', tbl, tbl);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      tbl, tbl
    );
  end loop;
end $$;
