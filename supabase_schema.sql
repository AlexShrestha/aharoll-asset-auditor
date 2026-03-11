create extension if not exists pgcrypto;

create table if not exists audit_jobs (
  id uuid primary key default gen_random_uuid(),
  store_url text not null,
  normalized_store_url text not null,
  category text null,
  status text not null check (status in ('queued', 'discovering', 'processing', 'completed', 'failed', 'canceled')),
  total_products integer not null default 0,
  queued_products integer not null default 0,
  processed_products integer not null default 0,
  failed_products integer not null default 0,
  progress_pct integer not null default 0 check (progress_pct between 0 and 100),
  callback_url text null,
  callback_token text null,
  metadata jsonb null,
  last_error text null,
  locked_at timestamptz null,
  lock_token uuid null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists audit_jobs_status_created_idx on audit_jobs (status, created_at);
create index if not exists audit_jobs_lock_idx on audit_jobs (locked_at);

create table if not exists audit_products (
  id bigserial primary key,
  job_id uuid not null references audit_jobs(id) on delete cascade,
  sequence_no integer not null,
  product_handle text null,
  product_title text not null,
  product_type text null,
  product_url text null,
  image_count integer not null default 0,
  status text not null check (status in ('queued', 'processing', 'processed', 'failed')),
  result_severity text null check (result_severity in ('critical', 'high', 'medium', 'low', 'info', 'none')),
  result_summary text null,
  product_json jsonb not null,
  analysis jsonb null,
  error_message text null,
  attempts integer not null default 0,
  started_at timestamptz null,
  processed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, sequence_no)
);

create index if not exists audit_products_job_status_seq_idx on audit_products (job_id, status, sequence_no);
create index if not exists audit_products_job_processed_idx on audit_products (job_id, processed_at desc);
create index if not exists audit_products_job_severity_idx on audit_products (job_id, result_severity, sequence_no);

create table if not exists audit_notifications (
  id bigserial primary key,
  job_id uuid not null references audit_jobs(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  response_status integer null,
  error_message text null,
  delivered_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists audit_notifications_job_event_idx on audit_notifications (job_id, event_type, created_at desc);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists audit_jobs_set_updated_at on audit_jobs;
create trigger audit_jobs_set_updated_at
before update on audit_jobs
for each row
execute function set_updated_at();

drop trigger if exists audit_products_set_updated_at on audit_products;
create trigger audit_products_set_updated_at
before update on audit_products
for each row
execute function set_updated_at();
