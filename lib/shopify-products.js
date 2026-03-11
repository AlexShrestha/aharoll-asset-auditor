function isProductAvailable(product) {
  if (product?.available === true) return true;
  if (product && Object.prototype.hasOwnProperty.call(product, 'available')) return false;
  return Array.isArray(product?.variants) && product.variants.some((variant) => variant.available === true);
}

export function normalizeStoreUrl(storeUrl) {
  let baseUrl = (storeUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('storeUrl is required');
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
  return baseUrl;
}

export function getProductUrl(storeUrl, product) {
  const baseUrl = normalizeStoreUrl(storeUrl);
  const handle = product?.handle || product?.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!handle) return null;
  return `${baseUrl}/products/${handle}`;
}

export async function fetchAllAvailableProducts(storeUrl) {
  const baseUrl = normalizeStoreUrl(storeUrl);
  const allProducts = [];
  let page = 1;
  const maxPages = 50;
  let nextUrl = `${baseUrl}/products.json?limit=250`;
  let usedCursor = false;

  while (nextUrl && page <= maxPages) {
    const response = await fetch(nextUrl, {
      headers: {
        'User-Agent': 'AhaRoll-Asset-Auditor/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Shopify returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.products || data.products.length === 0) break;

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
