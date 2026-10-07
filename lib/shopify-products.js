import { HttpError } from './http.js';
import { parseSafeUrl, safeFetchText, SafeFetchError } from './safe-fetch.js';

function isProductAvailable(product) {
  if (product?.available === true) return true;
  if (product && Object.prototype.hasOwnProperty.call(product, 'available')) return false;
  return Array.isArray(product?.variants) && product.variants.some((variant) => variant.available === true);
}

export function normalizeStoreUrl(storeUrl) {
  if (storeUrl != null && typeof storeUrl !== 'string') throw new HttpError(400, 'storeUrl must be a string');
  let baseUrl = (storeUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new HttpError(400, 'storeUrl is required');
  if (baseUrl.length > 2048) throw new HttpError(400, 'storeUrl is too long');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
  return baseUrl;
}

export function getProductUrl(storeUrl, product) {
  const baseUrl = normalizeStoreUrl(storeUrl);
  const handle = product?.handle || product?.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!handle) return null;
  return `${baseUrl}/products/${handle}`;
}

// Limits for fetching a (possibly hostile) store's products.json.
const PAGE_TIMEOUT_MS = 20000;
const PAGE_MAX_BYTES = 20 * 1024 * 1024;
const TOTAL_BUDGET_MS = 50000;

// Validates a user-supplied store URL (https, public host). Throws SafeFetchError (400).
export function assertSafeStoreUrl(storeUrl) {
  const baseUrl = normalizeStoreUrl(storeUrl);
  parseSafeUrl(baseUrl);
  return baseUrl;
}

export async function fetchAllAvailableProducts(storeUrl) {
  const baseUrl = assertSafeStoreUrl(storeUrl);
  const startedAt = Date.now();
  const allProducts = [];
  let page = 1;
  const maxPages = 50;
  let nextUrl = `${baseUrl}/products.json?limit=250`;
  let usedCursor = false;

  while (nextUrl && page <= maxPages) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
      throw new SafeFetchError('Store took too long to respond', { status: 502, code: 'timeout' });
    }

    const { response, text } = await safeFetchText(nextUrl, {
      timeoutMs: PAGE_TIMEOUT_MS,
      maxBytes: PAGE_MAX_BYTES,
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new SafeFetchError(`Store returned HTTP ${response.status}`, { status: 502, code: 'upstream_status' });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new SafeFetchError('Store did not return valid JSON', { status: 502, code: 'bad_json' });
    }

    if (!Array.isArray(data?.products) || data.products.length === 0) break;

    allProducts.push(...data.products);

    const linkHeader = response.headers.get('link');
    nextUrl = null;

    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        nextUrl = nextMatch[1];
        if (nextUrl.startsWith('/')) {
          const urlObj = new URL(baseUrl);
          nextUrl = urlObj.origin + nextUrl;
        }
        // Pagination must stay on the store's own origin.
        let sameOrigin = false;
        try {
          sameOrigin = new URL(nextUrl).origin === new URL(baseUrl).origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          throw new SafeFetchError('Store returned an unexpected pagination link', { status: 502, code: 'bad_pagination' });
        }
        usedCursor = true;
      }
    }

    if (!usedCursor && data.products.length === 250) {
      page += 1;
      nextUrl = `${baseUrl}/products.json?limit=250&page=${page}`;
    } else if (usedCursor) {
      page += 1;
    }
  }

  const products = allProducts.filter(isProductAvailable);

  return {
    products,
    storeBaseUrl: baseUrl,
    meta: {
      total: products.length,
      fetched: allProducts.length,
      pages: page,
      pagination: usedCursor ? 'cursor' : 'page',
    },
  };
}
