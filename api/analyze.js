export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  const { title, imageUrls, variants, productType, brandContext, imageAlts, imageFilenames } = req.body;
  if (!imageUrls || !imageUrls.length) {
    return res.status(400).json({ error: 'imageUrls required' });
  }

  const imageContent = imageUrls.slice(0, 10).map((url) => ({
    type: 'image_url',
    image_url: { url, detail: 'low' },
  }));

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

  const prompt = `You are an expert e-commerce visual merchandising and SEO auditor. Analyze these ${imageContent.length} product images for "${title}".
${variantInfo}${categoryHint}${brandCtx}${altInfo}${filenameInfo}

CLASSIFY each image (index 0 to ${imageContent.length - 1}):
- has_model: true/false
- angle: "front" | "back" | "side" | "3/4" | "detail" | "flat_lay" | "lifestyle" | "overhead" | "closeup" | "sole" | "inside" | "top"
- background: "white" | "solid_color" | "studio" | "lifestyle" | "outdoor" | "other"
- quality: "professional" | "good" | "amateur" | "poor"
- crop_style: "full_body" | "half_body" | "product_only" | "close_up" | "wide"
- shows_detail: true/false (zippers, texture, hardware, stitching, lace, embroidery, closures)
- variant_guess: which variant this image likely belongs to (color/pattern name)

=== SEVERITY RULES (FOLLOW EXACTLY) ===

CRITICAL - use ONLY for issues that create product confusion or wrong variant presentation:
1. MISSING MEDIA FOR VISUAL VARIANT: A color/print/pattern/material/finish variant has NO dedicated imagery. Visual variants include: color, print, pattern, material, finish, hardware color, design version. Example: Burgundy variant exists but only Black images are shown.
2. WRONG MEDIA ASSIGNED: Images shown for one color belong to another. Detail shot doesn't match selected variant. Gallery mixes incompatible variants.
3. NO USABLE HERO IMAGE: A visual variant exists but has no clear front-facing/hero product image (only closeups or back views).
4. BUYABLE VARIANT HAS ZERO MEDIA: In-stock variant opens empty gallery or has no valid images.
5. VARIANT AMBIGUITY: Two+ visually different variants reuse the same gallery. Customer cannot distinguish options visually.
6. ALL KEY IMAGES MISSING ALT TEXT: All primary product images have empty alt text (accessibility failure).
7. ALT TEXT REFERENCES WRONG VARIANT: Alt says "Black dress" but image shows Burgundy.

HIGH - product is purchasable but coverage is weak, conversion risk is high:
1. MISSING SUPPORTING ANGLES: No back view, no side view, no 3/4 where relevant.
2. MISSING DETAIL SHOT: Lace, sequins, embroidery, fabric texture, zipper, buttons, hardware not shown on a premium/detailed product.
3. MISSING MODEL/ON-BODY: Fit-dependent category (dress, top, coat, pants, shoes) lacks model shot.
4. MISSING CATEGORY-SPECIFIC COVERAGE: Shoes without sole view. Bags without inside view. Furniture without context shot.
5. DUPLICATE ALT TEXT: All gallery images use identical alt text with no angle/detail differentiation.
6. POOR FILENAMES: Machine-generated names like IMG_4488.jpg, final-final.png, screenshot.webp.
7. POOR IMAGE FORMAT/SIZE: Photographic images using PNG unnecessarily. No WebP. Oversized files.

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

Respond ONLY in valid JSON (no markdown, no backticks):
{
  "images": [{"index": 0, "has_model": true, "angle": "front", "background": "white", "quality": "professional", "crop_style": "full_body", "shows_detail": false, "variant_guess": "black", "brief": "model wearing black version, white studio, front view"}],
  "inconsistencies": [
    {"type": "variant_coverage", "severity": "critical", "detail": "Burgundy variant has no dedicated gallery. Customers may see the wrong product before purchase."},
    {"type": "missing_angles", "severity": "high", "detail": "Black variant lacks back and detail views."},
    {"type": "seo_alt_text", "severity": "high", "detail": "All 6 images use identical alt text with no angle differentiation."},
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

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.1',
        max_tokens: 2000,
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
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    const text = data.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
