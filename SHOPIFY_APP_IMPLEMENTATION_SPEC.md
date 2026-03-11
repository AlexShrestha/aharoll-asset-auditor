# Shopify AI Asset Audit Platform Specification

## Status

This file captures the required target architecture for the next backend/data-model iteration.

It supersedes the current queue-only persistence design as the long-term source of truth.

## Goal

Evolve the existing queue-based audit processor into a Shopify-native, Supabase-backed platform with:

- workspace tenancy
- Shopify auth/bootstrap
- catalog sync
- immutable audit history
- current/open finding state
- remediation workflows
- asset versioning and traceability
- search
- feedback capture
- realtime-ready schema

## Core Principles

1. Every tenant-owned record must be scoped by `workspace_id`.
2. Canonical current state and immutable history must be stored separately.
3. Products and assets are durable entities. Audits create findings against them.
4. Every asset change must be traceable.
5. Search must support structured, text, vector, and hybrid search.
6. Schema must support future multi-user and multi-workspace UI without redesign.

## Required Postgres Extensions

- `pgcrypto`
- `pg_trgm`
- `vector`
- `btree_gin`

Recommended:

- `uuid-ossp`
- `pg_stat_statements`

## Enumerations

Use Postgres enums or constrained text columns for:

- `common_status`: `active | inactive | archived`
- `store_connection_status`: `connected | disconnected | syncing | error`
- `sync_run_status`: `queued | running | completed | failed | canceled`
- `audit_run_status`: `queued | discovering | processing | completed | failed | canceled`
- `asset_status`: `active | draft | archived | deleted`
- `asset_origin`: `shopify | generated | uploaded | imported | external`
- `finding_severity`: `critical | high | medium | low | info | none`
- `finding_status`: `open | accepted | ignored | resolved | regressed`
- `remediation_status`: `queued | running | needs_review | approved | applied | failed | canceled`
- `feedback_label`: `helpful | not_helpful | correct | incorrect | preferred | rejected`

## Required Domain Model

### Tenancy and access

- `workspaces`
- `workspace_members`
- `workspace_api_keys`
- `external_identities`
- `workspace_preferences`

### Shopify registration and store lifecycle

- `stores`
- `store_tokens`
- `shopify_installations`
- `store_sync_runs`

### Catalog

- `collections`
- `products`
- `product_collections`
- `variants`

### Assets and traceability

- `assets`
- `asset_versions`
- `asset_links`
- `asset_events`

### Audits and findings

- `audit_runs`
- `audit_run_products`
- `finding_catalog`
- `finding_occurrences`
- `finding_current_state`
- `finding_comments`
- `product_comments`
- `product_quality_snapshots`
- `mv_daily_finding_stats`

### Remediation and feedback

- `remediation_jobs`
- `remediation_steps`
- `recommendation_feedback`

### Search

- `search_documents`

## Shopify Authentication and Registration

Mandatory behavior:

1. Merchant installs the Shopify app.
2. Shopify OAuth completes.
3. Backend exchanges code for token.
4. Backend fetches shop and installer details.
5. Backend calls internal registration handler:
   - `POST /api/auth/register-shopify-user`
6. Registration must create or upsert:
   - workspace
   - store
   - token
   - installation
   - member or external identity
   - default workspace preferences
7. Registration must queue initial sync.
8. Reinstall/reauth must be idempotent by `shop_domain`.

Required response shape:

```json
{
  "workspaceId": "uuid",
  "storeId": "uuid",
  "memberRole": "owner",
  "installationStatus": "completed",
  "initialSyncQueued": true
}
```

## Required API Surface

### Auth and bootstrap

- `POST /api/auth/register-shopify-user`
- `POST /api/shopify/webhooks/uninstalled`
- `POST /api/stores/connect`

### Workspaces and stores

- `POST /api/workspaces`
- `GET /api/workspaces/:workspaceId`
- `GET /api/stores/:storeId`
- `POST /api/stores/:storeId/sync`
- `GET /api/stores/:storeId/sync-runs`

### Audit runs

- `POST /api/audit-runs`
- `GET /api/audit-runs/:auditRunId`
- `GET /api/audit-runs/:auditRunId/products`
- `GET /api/audit-runs/:auditRunId/findings`
- `POST /api/audit-worker`

### Findings and comments

- `GET /api/products/:productId/findings/current`
- `GET /api/products/:productId/findings/history`
- `POST /api/findings/:findingCurrentStateId/comments`
- `POST /api/findings/:findingCurrentStateId/status`
- `POST /api/products/:productId/comments`
- `GET /api/products/:productId/comments`

### Assets

- `GET /api/products/:productId/assets`
- `POST /api/products/:productId/assets`
- `POST /api/assets/:assetId/versions`
- `POST /api/assets/:assetId/publish`
- `GET /api/assets/:assetId/history`

### Remediation

- `POST /api/remediations`
- `GET /api/remediations/:remediationJobId`
- `POST /api/remediations/:remediationJobId/approve`
- `POST /api/remediations/:remediationJobId/apply`

### Search and feedback

- `POST /api/search`
- `POST /api/feedback/recommendation`

## Finding Versioning Rules

- Every audit must write immutable `finding_occurrences`.
- `finding_current_state` must be upserted by deterministic fingerprint.
- Resolved issues must remain visible in history.
- Reappearing issues must increment regression counters.

Fingerprint inputs:

- `workspace_id`
- `product_id`
- nullable `variant_id`
- finding code
- normalized evidence target

## Realtime Targets

Supabase realtime must support:

- `audit_runs`
- `audit_run_products`
- `finding_occurrences`
- `finding_current_state`
- `finding_comments`
- `product_comments`
- `remediation_jobs`
- `assets`
- `asset_versions`
- `asset_events`
- `store_sync_runs`

## Security

RLS is required on all tenant-owned tables.

Policy expectations:

- workspace members can read rows for matching `workspace_id`
- editors/admins can create audits, comments, feedback, remediation requests
- owners/admins can manage stores and publish remediations
- service role bypasses RLS for workers and webhook handlers

Never expose:

- encrypted store tokens
- webhook secrets
- callback tokens
- internal prompts unless strictly internal-admin scoped

## Migration Strategy

### Phase 1

Create the new schema without removing the legacy queue tables.

### Phase 2

Backfill existing queue data into:

- `audit_runs`
- `audit_run_products`
- optionally `finding_occurrences`

### Phase 3

Refactor workers to write the new schema.

### Phase 4

Provide compatibility views for old UI/API paths if needed.

### Phase 5

Deprecate legacy queue persistence.

## Acceptance Criteria

Implementation is complete only when these work end-to-end:

1. Shopify install/auth creates or reuses workspace/store idempotently.
2. Initial sync populates collections, products, variants, and assets.
3. Audit runs persist immutable history and current state correctly.
4. Comments work on both findings and products.
5. Remediation jobs can be queued, reviewed, and applied.
6. Asset events fully trace modifications.
7. Search works across products, assets, findings, and comments.
8. Feedback is captured for finetuning.
9. Realtime streams progress and updates.
10. Reinstall of the same shop does not duplicate workspace/store rows.

## Current Gap

The current implementation in this repository only covers:

- queue-backed audit execution
- queue admin dashboard
- queue worker endpoints
- event webhooks
- legacy queue persistence in:
  - `audit_jobs`
  - `audit_products`
  - `audit_notifications`

It does not yet implement the expanded domain model above.
