import crypto from 'node:crypto';
import { getDb, withTransaction } from './db.js';
import { analyzeProduct } from './analyze-product.js';
import { fetchAllAvailableProducts, getProductUrl, normalizeStoreUrl } from './shopify-products.js';

function classifyVariantDimension(optionName) {
  if (!optionName) return 'non_visual_variant';
  const lower = optionName.toLowerCase();
  const sizePatterns = /^(xx?[sl]|[sl]|m|xx?l|2xl|3xl|4xl|5xl|\d+|\d+\/\d+|one size|os|regular|petite|tall|short|long)$/;
  if (sizePatterns.test(lower)) return 'non_visual_variant';
  const sizeWords = ['size', 'length', 'width', 'inseam', 'waist'];
  if (sizeWords.some((word) => lower.includes(word))) return 'non_visual_variant';
  return 'visual_variant';
}

function buildVariantData(product) {
  const availableVariants = (product.variants || []).filter((variant) => variant.available === true);
  return availableVariants.map((variant) => ({
    title: variant.title,
    option1: variant.option1,
    option2: variant.option2,
    option3: variant.option3,
    dimension: classifyVariantDimension(variant.option1),
    imageIndexes: product.images
      ?.map((image, idx) => image.variant_ids?.includes(variant.id) ? idx : null)
      .filter((idx) => idx !== null),
  }));
}

function productCategory(product) {
  return (product?.product_type || '').trim() || 'Uncategorized';
}

function safeJsonParse(value) {
  if (!value) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function getEventWebhookConfig() {
  return {
    url: process.env.AUDIT_EVENTS_WEBHOOK_URL || null,
    token: process.env.AUDIT_EVENTS_WEBHOOK_TOKEN || null,
  };
}

async function fetchJobReportNumbers(jobId, client = getDb()) {
  const counts = await client.query(
    `select
        count(*)::int as total_products,
        count(*) filter (where status = 'processed')::int as processed_products,
        count(*) filter (where status = 'failed')::int as failed_products,
        count(*) filter (where result_severity = 'critical')::int as critical_products,
        count(*) filter (where result_severity = 'high')::int as high_products,
        count(*) filter (where result_severity = 'medium')::int as medium_products,
        count(*) filter (where result_severity = 'low')::int as low_products,
        count(*) filter (where result_severity = 'info')::int as info_products,
        count(*) filter (where result_severity = 'none')::int as clean_products
     from audit_products
     where job_id = $1`,
    [jobId]
  );

  const findings = await client.query(
    `select analysis
     from audit_products
     where job_id = $1
       and analysis is not null`,
    [jobId]
  );

  let totalFindings = 0;
  let totalSeoIssues = 0;
  let totalMissingItems = 0;

  for (const row of findings.rows) {
    const analysis = safeJsonParse(row.analysis) || {};
    totalFindings += Array.isArray(analysis.inconsistencies) ? analysis.inconsistencies.length : 0;
    totalSeoIssues += Array.isArray(analysis.seo_issues) ? analysis.seo_issues.length : 0;
    totalMissingItems += Array.isArray(analysis.missing) ? analysis.missing.length : 0;
  }

  return {
    ...counts.rows[0],
    total_findings: totalFindings,
    total_seo_issues: totalSeoIssues,
    total_missing_items: totalMissingItems,
  };
}

async function emitEventWebhook({ job, eventType, payload, dedupe = false }) {
  const config = getEventWebhookConfig();
  if (!config.url) return null;

  const db = getDb();
  if (dedupe) {
    const existing = await db.query(
      `select id, delivered_at
       from audit_notifications
       where job_id = $1 and event_type = $2
       order by id desc
       limit 1`,
      [job.id, eventType]
    );

    if (existing.rows.length && existing.rows[0].delivered_at) {
      return existing.rows[0];
    }
  }

  let responseStatus = null;
  let errorMessage = null;

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { 'x-webhook-token': config.token } : {}),
      },
      body: JSON.stringify(payload),
    });
    responseStatus = response.status;
    if (!response.ok) errorMessage = `Webhook returned ${response.status}`;
  } catch (error) {
    errorMessage = error.message;
  }

  const notification = await db.query(
    `insert into audit_notifications (job_id, event_type, payload, response_status, error_message, delivered_at)
     values ($1, $2, $3::jsonb, $4, $5, case when $5 is null then now() else null end)
     returning *`,
    [job.id, eventType, JSON.stringify(payload), responseStatus, errorMessage]
  );

  return notification.rows[0];
}

export async function createAuditJob({ storeUrl, category = null, callbackUrl = null, callbackToken = null, metadata = null }) {
  const normalizedStoreUrl = normalizeStoreUrl(storeUrl);
  const result = await getDb().query(
    `insert into audit_jobs (
      store_url,
      normalized_store_url,
      category,
      status,
      callback_url,
      callback_token,
      metadata
    ) values ($1, $2, $3, 'queued', $4, $5, $6)
    returning id, status, normalized_store_url, category, created_at`,
    [storeUrl, normalizedStoreUrl, category, callbackUrl, callbackToken, metadata]
  );

  return result.rows[0];
}

export async function getAuditJob(jobId, { limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const [jobResult, productsResult] = await Promise.all([
    db.query(
      `select id, status, store_url, normalized_store_url, category, total_products, queued_products, processed_products,
              failed_products, progress_pct, last_error, created_at, started_at, completed_at, updated_at
       from audit_jobs
       where id = $1`,
      [jobId]
    ),
    db.query(
      `select sequence_no, product_title, product_type, product_url, status, result_severity, result_summary, error_message, processed_at
       from audit_products
       where job_id = $1
       order by sequence_no
       limit $2 offset $3`,
      [jobId, limit, offset]
    ),
  ]);

  if (!jobResult.rows.length) return null;

  return {
    ...jobResult.rows[0],
    products: productsResult.rows,
    page: { limit, offset, returned: productsResult.rows.length },
  };
}

export async function listAuditJobs({ status = 'all', limit = 25, offset = 0, search = '' } = {}) {
  const where = [];
  const params = [];

  if (status !== 'all') {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    where.push(`(store_url ilike $${params.length} or normalized_store_url ilike $${params.length} or id::text ilike $${params.length})`);
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  const db = getDb();
  const [jobsResult, countsResult] = await Promise.all([
    db.query(
      `select id, status, store_url, normalized_store_url, category, total_products, queued_products,
              processed_products, failed_products, progress_pct, last_error, created_at, started_at, completed_at, updated_at
       from audit_jobs
       ${whereSql}
       order by updated_at desc, created_at desc
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(
      `select
          count(*)::int as total,
          count(*) filter (where status = 'queued')::int as queued,
          count(*) filter (where status = 'discovering')::int as discovering,
          count(*) filter (where status = 'processing')::int as processing,
          count(*) filter (where status = 'completed')::int as completed,
          count(*) filter (where status = 'failed')::int as failed,
          count(*) filter (where status = 'canceled')::int as canceled
       from audit_jobs`
    ),
  ]);

  return {
    jobs: jobsResult.rows,
    counts: countsResult.rows[0],
    page: { limit, offset, returned: jobsResult.rows.length },
  };
}

export async function getAuditJobDetail(jobId, { limit = 100, offset = 0, productStatus = 'all', severity = 'all' } = {}) {
  const db = getDb();
  const jobResult = await db.query(
    `select id, status, store_url, normalized_store_url, category, total_products, queued_products, processed_products,
            failed_products, progress_pct, callback_url, last_error, created_at, started_at, completed_at, updated_at
     from audit_jobs
     where id = $1`,
    [jobId]
  );

  if (!jobResult.rows.length) return null;

  const filters = [`job_id = $1`];
  const params = [jobId];

  if (productStatus !== 'all') {
    params.push(productStatus);
    filters.push(`status = $${params.length}`);
  }

  if (severity !== 'all') {
    params.push(severity);
    filters.push(`result_severity = $${params.length}`);
  }

  const whereSql = `where ${filters.join(' and ')}`;

  const [productsResult, statsResult] = await Promise.all([
    db.query(
      `select id, sequence_no, product_handle, product_title, product_type, product_url, image_count, status,
              result_severity, result_summary, error_message, attempts, processed_at, analysis
       from audit_products
       ${whereSql}
       order by sequence_no
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(
      `select
          count(*)::int as total,
          count(*) filter (where status = 'queued')::int as queued,
          count(*) filter (where status = 'processing')::int as processing,
          count(*) filter (where status = 'processed')::int as processed,
          count(*) filter (where status = 'failed')::int as failed,
          count(*) filter (where result_severity = 'critical')::int as critical,
          count(*) filter (where result_severity = 'high')::int as high,
          count(*) filter (where result_severity = 'medium')::int as medium,
          count(*) filter (where result_severity = 'low')::int as low
       from audit_products
       where job_id = $1`,
      [jobId]
    ),
  ]);

  const failedUrls = productsResult.rows
    .filter((row) => row.status === 'failed' || row.error_message)
    .map((row) => ({
      productTitle: row.product_title,
      productUrl: row.product_url,
      errorMessage: row.error_message,
      status: row.status,
      sequenceNo: row.sequence_no,
    }));

  return {
    ...jobResult.rows[0],
    stats: statsResult.rows[0],
    products: productsResult.rows,
    failedUrls,
    page: { limit, offset, returned: productsResult.rows.length },
  };
}

async function claimJob(lockToken) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `with candidate as (
          select id
          from audit_jobs
          where status in ('queued', 'discovering', 'processing')
            and (locked_at is null or locked_at < now() - interval '10 minutes')
          order by
            case status
              when 'processing' then 0
              when 'discovering' then 1
              else 2
            end,
            created_at
          for update skip locked
          limit 1
        )
        update audit_jobs
        set locked_at = now(),
            lock_token = $1,
            status = case when status = 'queued' then 'discovering' else status end,
            updated_at = now()
        where id in (select id from candidate)
        returning *`,
      [lockToken]
    );

    return result.rows[0] || null;
  });
}

async function seedJobProducts(job) {
  const snapshot = await fetchAllAvailableProducts(job.normalized_store_url);
  const scopedProducts = job.category
    ? snapshot.products.filter((product) => productCategory(product) === job.category)
    : snapshot.products;

  await withTransaction(async (client) => {
    for (let i = 0; i < scopedProducts.length; i += 1) {
      const product = scopedProducts[i];
      await client.query(
        `insert into audit_products (
          job_id,
          sequence_no,
          product_handle,
          product_title,
          product_type,
          product_url,
          image_count,
          status,
          product_json
        ) values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::jsonb)`,
        [
          job.id,
          i + 1,
          product.handle || null,
          product.title || `Product ${i + 1}`,
          product.product_type || null,
          getProductUrl(job.normalized_store_url, product),
          product.images?.length || 0,
          JSON.stringify(product),
        ]
      );
    }

    await client.query(
      `update audit_jobs
       set total_products = $2,
           queued_products = $2,
           processed_products = 0,
           failed_products = 0,
           progress_pct = case when $2 = 0 then 100 else 0 end,
           status = case when $2 = 0 then 'completed' else 'processing' end,
           started_at = coalesce(started_at, now()),
           updated_at = now()
       where id = $1`,
      [job.id, scopedProducts.length]
    );
  });

  const refreshedJob = (await getDb().query(`select * from audit_jobs where id = $1`, [job.id])).rows[0];
  await emitEventWebhook({
    job: refreshedJob,
    eventType: 'job.started',
    dedupe: true,
    payload: {
      event: 'job.started',
      jobId: refreshedJob.id,
      status: refreshedJob.status,
      storeUrl: refreshedJob.store_url,
      normalizedStoreUrl: refreshedJob.normalized_store_url,
      category: refreshedJob.category,
      totalProducts: refreshedJob.total_products,
      queuedProducts: refreshedJob.queued_products,
      startedAt: refreshedJob.started_at,
    },
  });

  return scopedProducts.length;
}

async function claimProducts(jobId, batchSize) {
  return withTransaction(async (client) => {
    const rows = await client.query(
      `with selected as (
          select id
          from audit_products
          where job_id = $1
            and status = 'queued'
          order by sequence_no
          limit $2
          for update skip locked
        )
        update audit_products
        set status = 'processing',
            attempts = attempts + 1,
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id in (select id from selected)
        returning *`,
      [jobId, batchSize]
    );

    return rows.rows;
  });
}

async function updateJobProgress(jobId, client = getDb()) {
  const counts = await client.query(
    `select
        count(*)::int as total,
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'processed')::int as processed,
        count(*) filter (where status = 'failed')::int as failed
     from audit_products
     where job_id = $1`,
    [jobId]
  );

  const row = counts.rows[0];
  const total = row.total || 0;
  const queued = row.queued || 0;
  const processed = row.processed || 0;
  const failed = row.failed || 0;
  const completed = processed + failed;
  const progressPct = total === 0 ? 100 : Math.round((completed / total) * 100);
  const status = total === 0
    ? 'completed'
    : completed >= total
      ? 'completed'
      : 'processing';

  const updated = await client.query(
    `update audit_jobs
     set total_products = $2,
         queued_products = $3,
         processed_products = $4,
         failed_products = $5,
         progress_pct = $6,
         status = $7,
         completed_at = case when $7 = 'completed' then coalesce(completed_at, now()) else completed_at end,
         updated_at = now()
     where id = $1
     returning *`,
    [jobId, total, queued, processed, failed, progressPct, status]
  );

  return updated.rows[0];
}

async function releaseJobLock(jobId) {
  await getDb().query(
    `update audit_jobs set locked_at = null, lock_token = null, updated_at = now() where id = $1`,
    [jobId]
  );
}

async function failJob(jobId, message) {
  const result = await getDb().query(
    `update audit_jobs
     set status = 'failed',
         last_error = $2,
         locked_at = null,
         lock_token = null,
         updated_at = now()
     where id = $1
     returning *`,
    [jobId, message]
  );

  const job = result.rows[0] || null;
  if (job) {
    await emitEventWebhook({
      job,
      eventType: 'job.failed',
      dedupe: true,
      payload: {
        event: 'job.failed',
        jobId: job.id,
        status: job.status,
        storeUrl: job.store_url,
        normalizedStoreUrl: job.normalized_store_url,
        category: job.category,
        error: message,
        failedAt: job.updated_at,
      },
    });

    await emitEventWebhook({
      job,
      eventType: 'error',
      payload: {
        event: 'error',
        scope: 'job',
        jobId: job.id,
        storeUrl: job.store_url,
        normalizedStoreUrl: job.normalized_store_url,
        error: message,
        occurredAt: job.updated_at,
      },
    });
  }

  return job;
}

export async function stopAuditJob(jobId) {
  const result = await getDb().query(
    `update audit_jobs
     set status = 'canceled',
         last_error = coalesce(last_error, 'Canceled by admin'),
         locked_at = null,
         lock_token = null,
         updated_at = now()
     where id = $1
     returning *`,
    [jobId]
  );

  return result.rows[0] || null;
}

export async function restartAuditJob(jobId) {
  return withTransaction(async (client) => {
    const existing = await client.query(`select * from audit_jobs where id = $1 for update`, [jobId]);
    if (!existing.rows.length) return null;

    await client.query(`delete from audit_notifications where job_id = $1`, [jobId]);
    await client.query(`delete from audit_products where job_id = $1`, [jobId]);

    const result = await client.query(
      `update audit_jobs
       set status = 'queued',
           total_products = 0,
           queued_products = 0,
           processed_products = 0,
           failed_products = 0,
           progress_pct = 0,
           last_error = null,
           locked_at = null,
           lock_token = null,
           started_at = null,
           completed_at = null,
           updated_at = now()
       where id = $1
       returning *`,
      [jobId]
    );

    return result.rows[0] || null;
  });
}

async function sendCompletionNotification(job) {
  if (!job.callback_url) return null;

  const db = getDb();
  const existing = await db.query(
    `select id, delivered_at from audit_notifications
     where job_id = $1 and event_type = 'job.completed'
     limit 1`,
    [job.id]
  );

  if (existing.rows.length && existing.rows[0].delivered_at) {
    return existing.rows[0];
  }

  const payload = {
    jobId: job.id,
    status: job.status,
    progressPct: job.progress_pct,
    totalProducts: job.total_products,
    processedProducts: job.processed_products,
    failedProducts: job.failed_products,
    completedAt: job.completed_at,
  };

  let responseStatus = null;
  let errorMessage = null;

  try {
    const response = await fetch(job.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(job.callback_token ? { 'x-callback-token': job.callback_token } : {}),
      },
      body: JSON.stringify(payload),
    });
    responseStatus = response.status;
    if (!response.ok) {
      errorMessage = `Callback returned ${response.status}`;
    }
  } catch (error) {
    errorMessage = error.message;
  }

  const notification = await db.query(
    `insert into audit_notifications (job_id, event_type, payload, response_status, error_message, delivered_at)
     values ($1, 'job.completed', $2::jsonb, $3, $4, case when $4 is null then now() else null end)
     returning *`,
    [job.id, JSON.stringify(payload), responseStatus, errorMessage]
  );

  return notification.rows[0];
}

async function emitReportGenerated(job) {
  const numbers = await fetchJobReportNumbers(job.id);
  await emitEventWebhook({
    job,
    eventType: 'report.generated',
    dedupe: true,
    payload: {
      event: 'report.generated',
      jobId: job.id,
      status: job.status,
      storeUrl: job.store_url,
      normalizedStoreUrl: job.normalized_store_url,
      category: job.category,
      generatedAt: job.completed_at || job.updated_at,
      report: {
        totalProducts: numbers.total_products,
        processedProducts: numbers.processed_products,
        failedProducts: numbers.failed_products,
        criticalProducts: numbers.critical_products,
        highProducts: numbers.high_products,
        mediumProducts: numbers.medium_products,
        lowProducts: numbers.low_products,
        infoProducts: numbers.info_products,
        cleanProducts: numbers.clean_products,
        totalFindings: numbers.total_findings,
        totalSeoIssues: numbers.total_seo_issues,
        totalMissingItems: numbers.total_missing_items,
      },
    },
  });
}

export async function processQueueBatch({ batchSize = 3 } = {}) {
  const lockToken = crypto.randomUUID();
  let job = await claimJob(lockToken);
  if (!job) {
    return { status: 'idle' };
  }

  try {
    if ((job.status === 'discovering' || job.status === 'queued') && (job.total_products || 0) === 0) {
      await seedJobProducts(job);
      const refreshed = await getDb().query('select * from audit_jobs where id = $1', [job.id]);
      job = refreshed.rows[0];
    }

    const claimedProducts = await claimProducts(job.id, batchSize);
    if (!claimedProducts.length) {
      const updatedJob = await updateJobProgress(job.id);
      await releaseJobLock(job.id);
      if (updatedJob.status === 'completed') {
        await sendCompletionNotification(updatedJob);
      }
      return { status: updatedJob.status === 'completed' ? 'completed' : 'waiting', jobId: job.id, processedInBatch: 0 };
    }

    const apiKey = process.env.OPENAI_API_KEY;

    for (const row of claimedProducts) {
      const product = safeJsonParse(row.product_json);

      try {
        const variantData = buildVariantData(product);
        const imageAlts = product.images?.slice(0, 10).map((img) => img.alt || '') || [];
        const imageFilenames = product.images?.slice(0, 10).map((img) => {
          try {
            return new URL(img.src).pathname.split('/').pop();
          } catch {
            return '';
          }
        }) || [];

        const analysis = await analyzeProduct({
          apiKey,
          title: product.title,
          productUrl: row.product_url,
          imageUrls: product.images?.slice(0, 10).map((img) => img.src) || [],
          variants: variantData.length > 1 ? variantData : undefined,
          productType: product.product_type || undefined,
          imageAlts,
          imageFilenames,
        });

        await getDb().query(
          `update audit_products
           set status = 'processed',
               result_severity = $2,
               result_summary = $3,
               analysis = $4::jsonb,
               error_message = null,
               processed_at = now(),
               updated_at = now()
           where id = $1`,
          [row.id, analysis.severity, analysis.summary || null, JSON.stringify(analysis)]
        );
      } catch (error) {
        await getDb().query(
          `update audit_products
           set status = 'failed',
               error_message = $2,
               processed_at = now(),
               updated_at = now()
           where id = $1`,
          [row.id, error.message]
        );

        await emitEventWebhook({
          job,
          eventType: 'error',
          payload: {
            event: 'error',
            scope: 'product',
            jobId: job.id,
            storeUrl: job.store_url,
            normalizedStoreUrl: job.normalized_store_url,
            productId: row.id,
            productTitle: row.product_title,
            productUrl: row.product_url,
            sequenceNo: row.sequence_no,
            error: error.message,
            occurredAt: new Date().toISOString(),
          },
        });
      }
    }

    const updatedJob = await updateJobProgress(job.id);
    await releaseJobLock(job.id);

    if (updatedJob.status === 'completed') {
      await emitReportGenerated(updatedJob);
      await sendCompletionNotification(updatedJob);
    }

    return {
      status: updatedJob.status,
      jobId: job.id,
      processedInBatch: claimedProducts.length,
      progressPct: updatedJob.progress_pct,
    };
  } catch (error) {
    await failJob(job.id, error.message);
    throw error;
  }
}
