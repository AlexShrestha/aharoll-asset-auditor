import { withTransaction, getDb } from './db.js';
import { encryptSecret } from './crypto.js';
import { createAuditJob, getAuditJob } from './queue.js';

function slugify(value) {
  return (value || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace';
}

function normalizeStoreUrl(storeUrl, shopDomain) {
  let url = (storeUrl || '').trim();
  if (!url && shopDomain) url = `https://${shopDomain}`;
  if (!url) throw new Error('storeUrl or shopDomain is required');
  if (!url.startsWith('http')) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

function normalizeShopDomain(shopDomain) {
  const normalized = (shopDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!normalized) throw new Error('shopDomain is required');
  return normalized;
}

async function uniqueWorkspaceSlug(client, baseName) {
  const base = slugify(baseName);
  let candidate = base;
  let suffix = 1;

  while (true) {
    const exists = await client.query('select 1 from public.workspaces where slug = $1 limit 1', [candidate]);
    if (!exists.rows.length) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

function defaultWorkspacePreferences({ currency, locale, timezone }) {
  return {
    audit: {
      defaultRequestedChecks: ['asset_coverage', 'variant_consistency', 'seo', 'performance'],
      severityWeights: { critical: 100, high: 60, medium: 35, low: 15, info: 0 },
    },
    notifications: {
      completion: true,
      failure: true,
    },
    search: {
      mode: 'hybrid',
    },
    locale: {
      currency: currency || null,
      locale: locale || null,
      timezone: timezone || null,
    },
  };
}

export async function registerShopifyUser(payload) {
  const {
    shopDomain,
    storeUrl,
    shopifyStoreId = null,
    storeName = null,
    currency = null,
    locale = null,
    timezone = null,
    accessToken,
    scopes = [],
    installer = {},
    installPayload = {},
  } = payload || {};

  if (!accessToken) throw new Error('accessToken is required');

  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const normalizedStoreUrl = normalizeStoreUrl(storeUrl, normalizedShopDomain);

  return withTransaction(async (client) => {
    let workspaceId;
    let storeId;
    let memberRole = 'owner';

    const existingStore = await client.query(
      `select s.*, w.id as workspace_id
       from public.stores s
       join public.workspaces w on w.id = s.workspace_id
       where s.shop_domain = $1
       limit 1`,
      [normalizedShopDomain]
    );

    if (existingStore.rows.length) {
      const store = existingStore.rows[0];
      workspaceId = store.workspace_id;
      storeId = store.id;

      await client.query(
        `update public.stores
         set store_url = $2,
             normalized_store_url = $3,
             shopify_store_id = coalesce($4, shopify_store_id),
             store_name = coalesce($5, store_name),
             currency = coalesce($6, currency),
             locale = coalesce($7, locale),
             timezone = coalesce($8, timezone),
             connection_status = 'connected',
             app_install_state = 'completed'
         where id = $1`,
        [storeId, normalizedStoreUrl, normalizedStoreUrl, shopifyStoreId, storeName, currency, locale, timezone]
      );
    } else {
      const slug = await uniqueWorkspaceSlug(client, storeName || normalizedShopDomain.split('.')[0]);
      const workspace = await client.query(
        `insert into public.workspaces (name, slug, plan, settings, status)
         values ($1, $2, $3, '{}'::jsonb, 'active')
         returning *`,
        [storeName || normalizedShopDomain, slug, 'starter']
      );
      workspaceId = workspace.rows[0].id;

      const store = await client.query(
        `insert into public.stores (
          workspace_id, shop_domain, store_url, normalized_store_url, shopify_store_id, store_name,
          currency, locale, timezone, connection_status, app_install_state, settings
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'connected', 'completed', '{}'::jsonb)
         returning *`,
        [workspaceId, normalizedShopDomain, normalizedStoreUrl, normalizedStoreUrl, shopifyStoreId, storeName, currency, locale, timezone]
      );
      storeId = store.rows[0].id;

      await client.query(
        `insert into public.workspace_preferences (workspace_id, defaults)
         values ($1, $2::jsonb)
         on conflict (workspace_id) do update set defaults = excluded.defaults`,
        [workspaceId, JSON.stringify(defaultWorkspacePreferences({ currency, locale, timezone }))]
      );
    }

    await client.query(
      `insert into public.store_tokens (store_id, provider, access_token_encrypted, scopes)
       values ($1, 'shopify', $2, $3::text[])
       on conflict do nothing`,
      [storeId, encryptSecret(accessToken), scopes]
    );

    await client.query(`delete from public.store_tokens where store_id = $1 and id not in (
      select id from public.store_tokens where store_id = $1 order by created_at desc limit 1
    )`, [storeId]);

    if (installer?.shopifyUserId || installer?.email) {
      const identityRes = await client.query(
        `insert into public.external_identities (workspace_id, provider, external_user_id, email, display_name, metadata)
         values ($1, 'shopify', $2, $3, $4, $5::jsonb)
         on conflict (provider, external_user_id) do update
         set email = excluded.email,
             display_name = excluded.display_name,
             metadata = excluded.metadata
         returning *`,
        [
          workspaceId,
          installer.shopifyUserId || installer.email,
          installer.email || null,
          installer.name || null,
          JSON.stringify({ source: 'shopify_install', shopDomain: normalizedShopDomain }),
        ]
      );

      const externalIdentity = identityRes.rows[0];
      await client.query(
        `insert into public.workspace_members (workspace_id, user_id, role, joined_at)
         values ($1, $2, $3, now())
         on conflict (workspace_id, user_id) do update set role = excluded.role, joined_at = coalesce(public.workspace_members.joined_at, now())`,
        [workspaceId, externalIdentity.id, memberRole]
      );
    }

    await client.query(
      `insert into public.shopify_installations (
        workspace_id, store_id, shop_domain, install_status, installed_by_email, installed_by_name,
        installed_by_shopify_user_id, install_payload, installed_at
       ) values ($1, $2, $3, 'completed', $4, $5, $6, $7::jsonb, now())
       on conflict (shop_domain) do update
       set workspace_id = excluded.workspace_id,
           store_id = excluded.store_id,
           install_status = 'completed',
           installed_by_email = excluded.installed_by_email,
           installed_by_name = excluded.installed_by_name,
           installed_by_shopify_user_id = excluded.installed_by_shopify_user_id,
           install_payload = excluded.install_payload,
           installed_at = now(),
           uninstalled_at = null,
           error_message = null`,
      [
        workspaceId,
        storeId,
        normalizedShopDomain,
        installer.email || null,
        installer.name || null,
        installer.shopifyUserId || null,
        JSON.stringify(installPayload || {}),
      ]
    );

    const syncRun = await client.query(
      `insert into public.store_sync_runs (workspace_id, store_id, status, sync_type, stats)
       values ($1, $2, 'queued', 'full_catalog', $3::jsonb)
       returning id`,
      [workspaceId, storeId, JSON.stringify({ source: 'register-shopify-user' })]
    );

    return {
      workspaceId,
      storeId,
      memberRole,
      installationStatus: 'completed',
      initialSyncQueued: true,
      initialSyncRunId: syncRun.rows[0].id,
      normalizedShopDomain,
      normalizedStoreUrl,
    };
  });
}

export async function markStoreUninstalled({ shopDomain, payload = {} }) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  return withTransaction(async (client) => {
    const store = await client.query(`select * from public.stores where shop_domain = $1 limit 1`, [normalizedShopDomain]);
    if (!store.rows.length) return null;

    const storeRow = store.rows[0];

    await client.query(
      `update public.stores
       set connection_status = 'disconnected',
           app_install_state = 'uninstalled'
       where id = $1`,
      [storeRow.id]
    );

    await client.query(
      `update public.shopify_installations
       set install_status = 'uninstalled',
           uninstalled_at = now(),
           install_payload = install_payload || $2::jsonb
       where shop_domain = $1`,
      [normalizedShopDomain, JSON.stringify(payload || {})]
    );

    return { storeId: storeRow.id, workspaceId: storeRow.workspace_id, shopDomain: normalizedShopDomain };
  });
}

export async function createPlatformAuditRun({
  workspaceId,
  storeId,
  requestedByUserId = null,
  scope = {},
  requestedChecks = [],
  callbackUrl = null,
  callbackToken = null,
}) {
  const db = getDb();
  const storeResult = await db.query(
    `select s.*, w.id as workspace_id
     from public.stores s
     join public.workspaces w on w.id = s.workspace_id
     where s.id = $1 and s.workspace_id = $2
     limit 1`,
    [storeId, workspaceId]
  );
  if (!storeResult.rows.length) throw new Error('Store not found');

  const store = storeResult.rows[0];
  const scopeType = scope.type || 'all_products';

  const auditRun = await withTransaction(async (client) => {
    const inserted = await client.query(
      `insert into public.audit_runs (
        workspace_id, store_id, requested_by_user_id, status, scope_type, scope_filters, requested_checks, callback_url, callback_token
       ) values ($1, $2, $3, 'queued', $4, $5::jsonb, $6::text[], $7, $8)
       returning *`,
      [workspaceId, storeId, requestedByUserId, scopeType, JSON.stringify(scope || {}), requestedChecks || [], callbackUrl, callbackToken]
    );
    return inserted.rows[0];
  });

  const category = scopeType === 'collection' ? (scope.category || scope.collectionTitle || null) : null;
  const queueJob = await createAuditJob({
    storeUrl: store.normalized_store_url,
    category,
    callbackUrl,
    callbackToken,
    metadata: {
      workspaceId,
      storeId,
      auditRunId: auditRun.id,
      requestedChecks,
      scope,
    },
  });

  await db.query(
    `insert into public.audit_queue_links (workspace_id, audit_run_id, audit_job_id)
     values ($1, $2, $3)
     on conflict (audit_run_id) do update set audit_job_id = excluded.audit_job_id`,
    [workspaceId, auditRun.id, queueJob.id]
  );

  return {
    auditRunId: auditRun.id,
    queueJobId: queueJob.id,
    status: queueJob.status,
  };
}

export async function getPlatformAuditRun(auditRunId) {
  const db = getDb();
  const runResult = await db.query(
    `select ar.*, aql.audit_job_id
     from public.audit_runs ar
     left join public.audit_queue_links aql on aql.audit_run_id = ar.id
     where ar.id = $1
     limit 1`,
    [auditRunId]
  );

  if (!runResult.rows.length) return null;
  const auditRun = runResult.rows[0];

  let queueJob = null;
  if (auditRun.audit_job_id) {
    queueJob = await getAuditJob(auditRun.audit_job_id, { limit: 100, offset: 0 });
  }

  return {
    ...auditRun,
    queue: queueJob,
  };
}
