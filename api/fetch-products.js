function isProductAvailable(product) {
  if (product?.available === true) return true;
  if (product && Object.prototype.hasOwnProperty.call(product, 'available')) return false;
  return Array.isArray(product?.variants) && product.variants.some((variant) => variant.available === true);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { storeUrl } = req.body;
  if (!storeUrl) {
    return res.status(400).json({ error: 'storeUrl is required' });
  }

  let baseUrl = storeUrl.trim().replace(/\/+$/, '');
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;

  const allProducts = [];
  let page = 1;
  const maxPages = 50;

  try {
    // Try cursor-based pagination first (newer Shopify stores)
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

      // Check for cursor-based pagination via Link header
      const linkHeader = response.headers.get('link');
      nextUrl = null;

      if (linkHeader) {
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          nextUrl = nextMatch[1];
          // Handle relative URLs
          if (nextUrl.startsWith('/')) {
            const urlObj = new URL(baseUrl);
            nextUrl = urlObj.origin + nextUrl;
          }
          usedCursor = true;
        }
      }

      // Fallback to page-based if no Link header and first page had full results
      if (!usedCursor && data.products.length === 250) {
        page++;
        nextUrl = `${baseUrl}/products.json?limit=250&page=${page}`;
      }

      if (usedCursor) page++;
    }

    const availableProducts = allProducts.filter(isProductAvailable);

    return res.status(200).json({
      products: availableProducts,
      storeBaseUrl: baseUrl,
      meta: {
        total: availableProducts.length,
        fetched: allProducts.length,
        pages: page,
        pagination: usedCursor ? 'cursor' : 'page',
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
