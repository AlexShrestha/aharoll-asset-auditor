const SEVERITY_ORDER = ['none', 'info', 'low', 'medium', 'high', 'critical'];

function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity || 'none');
  return index === -1 ? 0 : index;
}

function maxSeverity(...levels) {
  return levels.reduce((max, level) => severityRank(level) > severityRank(max) ? level : max, 'none');
}

function parseContentLength(headers) {
  const raw = headers.get('content-length');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function bytesToMb(bytes) {
  return bytes / (1024 * 1024);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'AhaRoll-Asset-Auditor/1.0',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function measurePageLoad(productUrl) {
  if (!productUrl) {
    return { productUrl: null, pageLoadMs: null, pageSizeBytes: null, error: 'productUrl_missing' };
  }

  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(productUrl, { method: 'GET', redirect: 'follow' }, 15000);
    const html = await response.text();

    return {
      productUrl,
      pageLoadMs: Date.now() - startedAt,
      pageSizeBytes: parseContentLength(response.headers) ?? Buffer.byteLength(html, 'utf8'),
      status: response.status,
      ok: response.ok,
    };
  } catch (error) {
    return {
      productUrl,
      pageLoadMs: null,
      pageSizeBytes: null,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  }
}

async function measureImage(url) {
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, 10000);
    const sizeBytes = parseContentLength(response.headers);

    if (sizeBytes != null || !response.ok) {
      return {
        url,
        sizeBytes,
        contentType: response.headers.get('content-type') || null,
        ok: response.ok,
      };
    }
  } catch (_) {
    // Fallback below.
  }

  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
    }, 10000);

    let sizeBytes = parseContentLength(response.headers);
    const contentRange = response.headers.get('content-range');
    if (sizeBytes == null && contentRange) {
      const match = contentRange.match(/\/(\d+)$/);
      if (match) sizeBytes = Number.parseInt(match[1], 10);
    }

    return {
      url,
      sizeBytes,
      contentType: response.headers.get('content-type') || null,
      ok: response.ok,
    };
  } catch (error) {
    return {
      url,
      sizeBytes: null,
      contentType: null,
      ok: false,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  }
}

async function measurePerformance(productUrl, imageUrls) {
  const [page, images] = await Promise.all([
    measurePageLoad(productUrl),
    Promise.all((imageUrls || []).slice(0, 10).map((url) => measureImage(url))),
  ]);

  const knownImageSizes = images.map((entry) => entry.sizeBytes).filter((value) => Number.isFinite(value));
  const totalImageBytes = knownImageSizes.reduce((sum, value) => sum + value, 0);
  const largestImageBytes = knownImageSizes.length ? Math.max(...knownImageSizes) : null;

  return {
    productUrl: page.productUrl,
    pageLoadMs: page.pageLoadMs,
    pageSizeBytes: page.pageSizeBytes,
    pageStatus: page.status || null,
    pageError: page.error || null,
    totalImageBytes: knownImageSizes.length ? totalImageBytes : null,
    largestImageBytes,
    measuredImageCount: knownImageSizes.length,
    imageCount: images.length,
    imageMetrics: images,
  };
}

function derivePerformanceIssues(performance) {
  const issues = [];

  if (performance.pageLoadMs != null) {
    if (performance.pageLoadMs >= 8000) {
      issues.push({
        type: 'page_load',
        severity: 'high',
        detail: `Product page load time is ${performance.pageLoadMs} ms, which is slow enough to risk functionality and conversion.`,
      });
    } else if (performance.pageLoadMs >= 4000) {
      issues.push({
        type: 'page_load',
        severity: 'medium',
        detail: `Product page load time is ${performance.pageLoadMs} ms, which is slower than expected for a product page.`,
      });
    } else if (performance.pageLoadMs >= 2500) {
      issues.push({
        type: 'page_load',
        severity: 'low',
        detail: `Product page load time is ${performance.pageLoadMs} ms and should be improved.`,
      });
    }
  }

  if (performance.totalImageBytes != null) {
    const totalMb = bytesToMb(performance.totalImageBytes);
    const largestMb = performance.largestImageBytes != null ? bytesToMb(performance.largestImageBytes) : null;

    if (totalMb >= 12 || (largestMb != null && largestMb >= 3)) {
      issues.push({
        type: 'image_size',
        severity: 'high',
        detail: `Image payload is heavy at ${totalMb.toFixed(2)} MB total${largestMb != null ? ` with a largest file of ${largestMb.toFixed(2)} MB` : ''}.`,
      });
    } else if (totalMb >= 5 || (largestMb != null && largestMb >= 1.5)) {
      issues.push({
        type: 'image_size',
        severity: 'medium',
        detail: `Image payload totals ${totalMb.toFixed(2)} MB${largestMb != null ? ` and the largest file is ${largestMb.toFixed(2)} MB` : ''}.`,
      });
    } else if (totalMb >= 2.5) {
      issues.push({
        type: 'image_size',
        severity: 'low',
        detail: `Image payload totals ${totalMb.toFixed(2)} MB and can likely be optimized further.`,
      });
    }
  }

  return issues;
}

function normalizeIssue(entry, fallbackSeverity) {
  if (typeof entry === 'string') {
    const detail = entry.trim();
    return detail ? { type: 'other', severity: fallbackSeverity, detail } : null;
  }

  if (!entry || typeof entry !== 'object') return null;
  const detail = typeof entry.detail === 'string' ? entry.detail.trim() : '';
  if (!detail) return null;

  return {
    ...entry,
    severity: entry.severity || fallbackSeverity,
    type: entry.type || 'other',
    detail,
  };
}

function buildPrompt({ title, imageCount, variants, productType, brandContext, imageAlts, imageFilenames }) {
  const variantInfo = variants && variants.length > 0
    ? `\nVARIANTS:\n${variants.map(v => `- "${v.title}" (type: ${v.dimension}, images: ${v.imageIndexes?.join(', ') ?? 'shared/unknown'})`).join('\n')}`
    : '';

  const altInfo = imageAlts && imageAlts.length > 0
    ? `\nIMAGE ALT TEXT:\n${imageAlts.map((a, i) => `- Image ${i}: alt="${a || '(empty)'}"`).join('\n')}`
    : '';

  const filenameInfo = imageFilenames && imageFilenames.length > 0
    ? `\nIMAGE FILENAMES:\n${imageFilenames.map((f, i) => `- Image ${i}: ${f}`).join('\n')}`
    : '';

  const brandCtx = brandContext
    ? `\nBRAND CONTEXT: ${brandContext}`
    : '';

  const categoryHint = productType
    ? `\nPRODUCT TYPE/CATEGORY: ${productType}`
    : '';

  return `You are an expert e-commerce visual merchandising and SEO auditor. Analyze these ${imageCount} product images for "${title}".
${variantInfo}${categoryHint}${brandCtx}${altInfo}${filenameInfo}

CLASSIFY each image (index 0 to ${imageCount - 1}):
- has_model: true/false
- angle: "front" | "back" | "side" | "3/4" | "detail" | "flat_lay" | "lifestyle" | "overhead" | "closeup" | "sole" | "inside" | "top"
- background: "white" | "solid_color" | "studio" | "lifestyle" | "outdoor" | "other"
- quality: "professional" | "good" | "amateur" | "poor"
- crop_style: "full_body" | "half_body" | "product_only" | "close_up" | "wide"
- shows_detail: true/false (zippers, texture, hardware, stitching, lace, embroidery, closures)
- variant_guess: which variant this image likely belongs to (color/pattern name)

=== SEVERITY DECISION POLICY (FOLLOW EXACTLY) ===

The overall "severity" must be determined ONLY from visual merchandising and asset coverage problems.
SEO, accessibility, alt text, filename, format, and gallery-order problems must ALWAYS be reported, but they must NOT raise or determine the overall severity.
If the only problems are SEO or metadata problems, set overall severity to "low" unless there are no issues at all, in which case use "none".
Never return "critical" or "high" based only on SEO/accessibility problems.

=== SEVERITY RULES (FOLLOW EXACTLY) ===

CRITICAL - use ONLY for issues that create product confusion or wrong variant presentation:
1. MISSING MEDIA FOR VISUAL VARIANT: A color/print/pattern/material/finish variant has NO dedicated imagery. Visual variants include: color, print, pattern, material, finish, hardware color, design version. Example: Burgundy variant exists but only Black images are shown.
2. WRONG MEDIA ASSIGNED: Images shown for one color belong to another. Detail shot doesn't match selected variant. Gallery mixes incompatible variants.
3. NO USABLE HERO IMAGE: A visual variant exists but has no clear front-facing/hero product image (only closeups or back views).
4. BUYABLE VARIANT HAS ZERO MEDIA: In-stock variant opens empty gallery or has no valid images.
5. VARIANT AMBIGUITY: Two+ visually different variants reuse the same gallery. Customer cannot distinguish options visually.

HIGH - product is purchasable but coverage is weak, conversion risk is high:
1. MISSING SUPPORTING ANGLES: No back view, no side view, no 3/4 where relevant.
2. MISSING DETAIL SHOT: Lace, sequins, embroidery, fabric texture, zipper, buttons, hardware not shown on a premium/detailed product.
3. MISSING MODEL/ON-BODY: Fit-dependent category (dress, top, coat, pants, shoes) lacks model shot.
4. MISSING CATEGORY-SPECIFIC COVERAGE: Shoes without sole view. Bags without inside view. Furniture without context shot.

MEDIUM - affects quality or conversion but does NOT cause product confusion:
1. Repetitive/near-duplicate images in gallery.
2. Inconsistent crop, framing, or aspect ratios.
3. Inconsistent background or lighting within same product.
4. Weak gallery order (starts with closeup or back instead of hero).
5. No lifestyle image. No video where optional.
6. Duplicate images across different products.
7. Decorative text burned into product images.

LOW - minor issues that don't materially affect understanding:
1. One slightly redundant image.
2. One angle weaker than rest.
3. Minor background inconsistency.
4. Metadata polish issues.
5. SEO-only or accessibility-only problems with otherwise strong imagery.

INFO - acceptable omissions, NOT gaps:
1. SIZE-ONLY VARIANTS SHARING IMAGES: XS/S/M/L/XL sharing one image set is ACCEPTABLE when appearance doesn't change. Do NOT flag this as critical or high. Mark as info.
2. Missing duplicate angle coverage per size. Not a gap.
3. Missing editorial extras (second lifestyle, alternate pose, campaign image).

=== SIZE-ONLY EXCEPTION ===
IMPORTANT: Do NOT treat missing size-specific imagery as critical. Sizes (XS, S, M, L, XL, XXL, 2XL, etc.) that share the same visual appearance should share imagery. Only escalate size gaps when size materially changes appearance: petite vs tall, plus-size with different cut, footwear width changing silhouette, furniture dimensions changing proportions.

=== CATEGORY COVERAGE TEMPLATES ===
Apply category-specific expected coverage:
- Apparel/dresses: front, back, side/3/4, detail, model shot
- Tops/knitwear/jackets: front, back, side, fabric/collar/closure detail, model
- Shoes: lateral side, front/top, back, sole, detail, on-foot optional
- Bags/accessories: front, back, side, inside/open, hardware/strap detail
- Jewelry: hero, close-up, scale reference, clasp detail
- Furniture: hero, angled view, material detail, in-room/context

=== SEO CHECKS ===
Also evaluate:
- Alt text quality (empty, generic like "image"/"product"/"photo", or lacking variant/angle specificity)
- Filename quality (machine names vs descriptive)
- Gallery ordering (hero first?)
- Image quality issues visible (blurry, watermarks, screenshots, low-res)

SEO findings must be listed in "seo_issues". They may also appear in "missing" when useful, but they must not control the overall "severity".
Do not duplicate SEO findings as blank or partial entries.

Respond ONLY in valid JSON (no markdown, no backticks):
{
  "images": [{"index": 0, "has_model": true, "angle": "front", "background": "white", "quality": "professional", "crop_style": "full_body", "shows_detail": false, "variant_guess": "black", "brief": "model wearing black version, white studio, front view"}],
  "inconsistencies": [
    {"type": "variant_coverage", "severity": "critical", "detail": "Burgundy variant has no dedicated gallery. Customers may see the wrong product before purchase."},
    {"type": "missing_angles", "severity": "high", "detail": "Black variant lacks back and detail views."},
    {"type": "size_only", "severity": "info", "detail": "XS, S, M, L share images. No action required - appearance unchanged across sizes."}
  ],
  "severity": "critical" | "high" | "medium" | "low" | "info" | "none",
  "summary": "One line assessment focused on the highest-severity issue",
  "missing": ["back view for Burgundy variant", "model shot for all variants"],
  "seo_issues": ["All images have empty alt text", "Filenames are machine-generated (IMG_xxxx.jpg)"],
  "scores": {
    "asset_coverage": 0-100,
    "variant_integrity": 0-100,
    "seo_accessibility": 0-100
  }
}`;
}

export async function analyzeProduct({
  apiKey,
  title,
  productUrl,
  imageUrls,
  variants,
  productType,
  brandContext,
  imageAlts,
  imageFilenames,
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  if (!imageUrls || !imageUrls.length) throw new Error('imageUrls required');

  const limitedImageUrls = imageUrls.slice(0, 10);
  const imageContent = limitedImageUrls.map((url) => ({
    type: 'image_url',
    image_url: { url, detail: 'low' },
  }));

  const prompt = buildPrompt({
    title,
    imageCount: imageContent.length,
    variants,
    productType,
    brandContext,
    imageAlts,
    imageFilenames,
  });

  const [performance, response] = await Promise.all([
    measurePerformance(productUrl, limitedImageUrls),
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.1',
        max_completion_tokens: 2000,
        temperature: 0.1,
        messages: [
          {
            role: 'user',
            content: [
              ...imageContent,
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    }),
  ]);

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  const text = data.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  const normalizedInconsistencies = (parsed.inconsistencies || [])
    .map((entry) => normalizeIssue(entry, parsed.severity || 'none'))
    .filter(Boolean);

  const performanceIssues = derivePerformanceIssues(performance);
  const performanceSeverity = performanceIssues.reduce((max, issue) => maxSeverity(max, issue.severity), 'none');
  const combinedSeverity = maxSeverity(parsed.severity || 'none', performanceSeverity);

  parsed.inconsistencies = [...normalizedInconsistencies, ...performanceIssues];
  parsed.performance = performance;

  if (severityRank(performanceSeverity) > severityRank(parsed.severity || 'none') && performanceIssues[0]) {
    parsed.summary = performanceIssues[0].detail;
  }

  parsed.severity = combinedSeverity;

  return parsed;
}
