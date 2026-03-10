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

  return result.rows[0] || null;
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
      }
    }

    const updatedJob = await updateJobProgress(job.id);
    await releaseJobLock(job.id);

    if (updatedJob.status === 'completed') {
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
