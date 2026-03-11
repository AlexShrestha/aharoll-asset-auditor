# Audit Queue API Specification

## Scope

This document specifies the queued audit API for the Shopify app integration.

The queue API is separate from the existing synchronous analysis endpoint:

- Existing direct endpoint: [`/api/analyze`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/analyze.js)
- New queued endpoints:
  - [`/api/queue-audit`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/queue-audit.js)
  - [`/api/queue-status`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/queue-status.js)
  - [`/api/queue-worker`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/queue-worker.js)

## Architecture Decision

Use an HTTP-polled queue backed by Supabase Postgres.

Reason:

- Audit runs can last 10-120 minutes.
- Vercel serverless functions are not suitable for one long-running request.
- Durable queue state is required for progress tracking, retries, and completion notifications.
- The Shopify app needs explicit job status and processed product visibility.

Rejected approach:

- SNS or a separate broker adds operational complexity that is not necessary for the current flow.

Chosen flow:

1. Shopify app calls `POST /api/queue-audit`.
2. API inserts a queued job into Supabase.
3. Worker calls `POST /api/queue-worker` repeatedly with a secure worker token.
4. Worker claims one job, snapshots products into `audit_products`, then processes a small batch per invocation.
5. Shopify app polls `GET /api/queue-status?jobId=...` to show progress and processed products.
6. When the job completes, the API optionally posts a completion webhook to the configured callback URL.

## Security Model

### Client authentication

Shopify app requests must include:

- Header: `x-api-key: <AUDIT_API_KEY>`

This key is validated in [`lib/auth.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/lib/auth.js).

### Worker authentication

Worker invocations must include one of:

- Header: `x-worker-token: <AUDIT_WORKER_TOKEN>`
- Header: `Authorization: Bearer <AUDIT_WORKER_TOKEN>`

### Callback authentication

If a callback is configured on job creation, the completion webhook will include:

- Header: `x-callback-token: <callbackToken>`

### `audit_jobs`

Purpose:

- one row per requested audit
- queue state
- progress counters
- callback configuration
- worker lock tracking

Core columns:

- `id uuid primary key`
- `store_url text`
- `normalized_store_url text`
- `category text null`
- `status text`
- `total_products int`
- `queued_products int`
- `processed_products int`
- `failed_products int`
- `progress_pct int`
- `callback_url text null`
- `callback_token text null`
- `metadata jsonb null`
- `last_error text null`
- `locked_at timestamptz null`
- `lock_token uuid null`
- `started_at timestamptz null`
- `completed_at timestamptz null`
- `created_at timestamptz`
- `updated_at timestamptz`

Allowed statuses:

- `queued`
- `discovering`
- `processing`
- `completed`
- `failed`
- `canceled`

### `audit_products`

Purpose:

- one row per product in a queued audit
- product snapshot
- per-product processing state
- analysis result storage

Core columns:

- `id bigserial primary key`
- `job_id uuid`
- `sequence_no int`
- `product_handle text`
- `product_title text`
- `product_type text`
- `product_url text`
- `image_count int`
- `status text`
- `result_severity text null`
- `result_summary text null`
- `product_json jsonb`
- `analysis jsonb null`
- `error_message text null`
- `attempts int`
- `started_at timestamptz null`
- `processed_at timestamptz null`
- `created_at timestamptz`
- `updated_at timestamptz`

Allowed statuses:

- `queued`
- `processing`
- `processed`
- `failed`

### `audit_notifications`

Purpose:

- record completion webhook deliveries
- avoid duplicate sends
- keep delivery status for debugging

Core columns:

- `id bigserial primary key`
- `job_id uuid`
- `event_type text`
- `payload jsonb`
- `response_status int null`
- `error_message text null`
- `delivered_at timestamptz null`
- `created_at timestamptz`

## Queue Behavior

### Job creation

`POST /api/queue-audit` only enqueues the job.

It does not run the full audit inline.

### Product discovery

The first worker that claims a queued job:

- fetches the store catalog from Shopify `products.json`
- filters products to `available = true`
- optionally filters by category
- inserts one `audit_products` row per product
- moves the job into `processing`

### Batch processing

Each worker invocation:

- claims at most one job
- claims a limited number of queued products from that job
- runs analysis on that batch
- updates `audit_products`
- recalculates job progress
- releases the job lock

Current worker batch size:

- default `3`
- minimum `1`
- maximum `10`

### Locking

Worker locking uses:

- `locked_at`
- `lock_token`
- `FOR UPDATE SKIP LOCKED`

Stale lock timeout:

- `10 minutes`

### Completion

When `processed_products + failed_products >= total_products`:

- job status becomes `completed`
- `completed_at` is set
- completion callback is sent once if configured

## Endpoint Specification

### 1. Create audit job

Endpoint:

- `POST /api/queue-audit`

Auth:

- `x-api-key`

Body:

```json
{
  "storeUrl": "https://example-store.com",
  "category": "Dresses",
  "callbackUrl": "https://shopify-app.example.com/api/audit-complete",
  "callbackToken": "internal-callback-secret",
  "metadata": {
    "shopDomain": "example-store.myshopify.com",
    "initiatedBy": "shopify-app",
    "userId": "123"
  }
}
```

Minimum required body:

```json
{
  "storeUrl": "https://example-store.com"
}
```

Response:

```json
{
  "jobId": "0f7c5ee7-5aef-4c73-b07d-c2957c0d0c26",
  "status": "queued",
  "normalizedStoreUrl": "https://example-store.com",
  "category": "Dresses",
  "createdAt": "2026-03-10T13:20:00.000Z"
}
```

Status codes:

- `202` accepted
- `400` validation failure
- `401` invalid API key
- `500` server error

### 2. Read audit status

Endpoint:

- `GET /api/queue-status?jobId=<uuid>&limit=50&offset=0`

Auth:

- `x-api-key`

Purpose:

- return job state
- return high-level progress
- return paginated processed product rows for UI progress views

Response:

```json
{
  "id": "0f7c5ee7-5aef-4c73-b07d-c2957c0d0c26",
  "status": "processing",
  "store_url": "https://example-store.com",
  "normalized_store_url": "https://example-store.com",
  "category": "Dresses",
  "total_products": 3574,
  "queued_products": 3400,
  "processed_products": 160,
  "failed_products": 14,
  "progress_pct": 5,
  "last_error": null,
  "created_at": "2026-03-10T13:20:00.000Z",
  "started_at": "2026-03-10T13:21:10.000Z",
  "completed_at": null,
  "updated_at": "2026-03-10T13:50:55.000Z",
  "products": [
    {
      "sequence_no": 1,
      "product_title": "Booked And Busy Ruffle Hem Bodycon Mini Dress",
      "product_type": "Dresses",
      "product_url": "https://example-store.com/products/booked-and-busy",
      "status": "processed",
      "result_severity": "critical",
      "result_summary": "Gallery mixes ivory and red imagery against ivory-only variants.",
      "error_message": null,
      "processed_at": "2026-03-10T13:22:41.000Z"
    }
  ],
  "page": {
    "limit": 50,
    "offset": 0,
    "returned": 50
  }
}
```

Status codes:

- `200` success
- `400` missing `jobId`
- `401` invalid API key
- `404` job not found
- `500` server error

### 3. Run worker batch

Endpoint:

- `POST /api/queue-worker`

Auth:

- `x-worker-token` or `Authorization: Bearer ...`

Body:

```json
{
  "batchSize": 3
}
```

Response when work was processed:

```json
{
  "status": "processing",
  "jobId": "0f7c5ee7-5aef-4c73-b07d-c2957c0d0c26",
  "processedInBatch": 3,
  "progressPct": 6
}
```

Response when queue is empty:

```json
{
  "status": "idle"
}
```

Response when a job is complete but no more products were available to claim:

```json
{
  "status": "completed",
  "jobId": "0f7c5ee7-5aef-4c73-b07d-c2957c0d0c26",
  "processedInBatch": 0
}
```

Status codes:

- `200` success
- `401` invalid worker token
- `500` server error

## Completion Webhook

When a job completes and `callbackUrl` is present, the API posts:

- method: `POST`
- header: `Content-Type: application/json`
- header: `x-callback-token: <callbackToken>` when provided

Payload:

```json
{
  "jobId": "0f7c5ee7-5aef-4c73-b07d-c2957c0d0c26",
  "status": "completed",
  "progressPct": 100,
  "totalProducts": 3574,
  "processedProducts": 3558,
  "failedProducts": 16,
  "completedAt": "2026-03-10T15:19:02.000Z"
}
```

Delivery attempts are recorded in `audit_notifications`.

## Shopify App Integration Contract

### Start audit

Shopify app flow:

1. Merchant clicks `Run audit`.
2. Shopify app calls `POST /api/queue-audit`.
3. API returns `jobId`.
4. Shopify app stores `jobId` against the merchant session or shop record.

### Progress screen

Shopify app polls `GET /api/queue-status` every 10-30 seconds.

Progress UI should use:

- `status`
- `progress_pct`
- `total_products`
- `processed_products`
- `failed_products`
- `products[]`

### Completion

Two supported patterns:

- callback-based completion via `callbackUrl`
- polling-only completion via `queue-status`

Recommended:

- use both
- callback for immediate completion handling
- polling for live progress

## Analysis Scope Per Product

Each queued product uses the same analysis engine as the synchronous endpoint.

Current checks include:

- variant coverage and gallery consistency
- missing angles and detail imagery
- model coverage
- performance checks:
  - page load time
  - image payload size
- SEO reporting:
  - SEO findings are always reported
  - SEO findings do not drive overall severity

## Operational Notes

### Required scheduler

The queue requires an external trigger for `/api/queue-worker`.

Recommended options:

- Vercel Cron
- Shopify app background scheduler
- external cron or job runner

### Recommended worker cadence

Initial recommendation:

- every 30-60 seconds
- `batchSize=3` for stability

### Failure handling

- product-level failures move that product row to `failed`
- batch-level failures move the job to `failed`
- stale locks older than 10 minutes can be reclaimed by another worker

### Current limitation

The Supabase migration is prepared in the repository, but it has not been executed from this workspace because the provided database URL still contains a password placeholder.

## Files

- [`api/queue-audit.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/queue-audit.js)
- [`api/queue-status.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/queue-status.js)
- [`api/queue-worker.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/queue-worker.js)
- [`lib/queue.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/lib/queue.js)
- [`lib/db.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/lib/db.js)
- [`lib/auth.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/lib/auth.js)
- [`supabase/migrations/20260310_create_audit_queue.sql`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/supabase/migrations/20260310_create_audit_queue.sql)
