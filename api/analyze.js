export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  const { title, imageUrls, variants, brandContext } = req.body;
  if (!imageUrls || !imageUrls.length) {
    return res.status(400).json({ error: 'imageUrls required' });
  }

  const imageContent = imageUrls.slice(0, 10).map((url) => ({
    type: 'image_url',
    image_url: { url, detail: 'low' },
  }));

  const variantInfo = variants && variants.length > 0
    ? `\nThis product has the following variants: ${variants.map(v => `"${v.title}" (images: ${v.imageIndexes?.join(', ') || 'unknown'})`).join(', ')}`
    : '';

  const brandCtx = brandContext
    ? `\nBRAND CONTEXT (what most products in this store look like): ${brandContext}`
    : '';

  const prompt = `You are an expert e-commerce visual merchandising auditor. Analyze these ${imageContent.length} product images for "${title}".
${variantInfo}
${brandCtx}

CLASSIFY each image (index 0 to ${imageContent.length - 1}):
- has_model: true/false (human wearing, holding, or modeling the product)
- angle: "front" | "back" | "side" | "detail" | "flat_lay" | "lifestyle" | "overhead" | "closeup"
- background: "white" | "solid_color" | "studio" | "lifestyle" | "outdoor" | "other"
- quality: "professional" | "good" | "amateur" | "poor"
- crop_style: "full_body" | "half_body" | "product_only" | "close_up" | "wide"
- shows_product_detail: true/false (shows zippers, openings, inside, texture, special features)

CHECK FOR THESE SPECIFIC INCONSISTENCIES (these are the most important):

1. VARIANT COVERAGE GAPS: If the product has color/style variants, do ALL variants have the same types of shots? For example: blue has a model photo but red and green don't. Or blue shows 5 angles but green only shows 2. Flag EACH missing shot type per variant.

2. MODEL INCONSISTENCY: Some images use a model, others don't. This is a problem when a customer sees a model on one color and a flat lay on another for the SAME product.

3. ANGLE COVERAGE GAPS: Some variants show product details (inside, openings, texture closeups) that other variants don't show at all.

4. STYLE MISMATCH: Within the same product, images have noticeably different photography styles - different lighting, different backgrounds, different crop ratios. Looks like photos were taken at different times or by different photographers.

5. QUALITY MISMATCH: Some images are professional studio quality while others look amateur or lower resolution within the same product.

6. NO MODEL AT ALL: Product has zero model/lifestyle images when similar products in the brand typically use models.
${brandCtx ? '\n7. BRAND DEVIATION: This product\'s photography style is significantly different from the brand norm described above.' : ''}

BE STRICT. Real stores have these problems constantly. If images look like they were shot differently, flag it. If one variant has fewer shot types than another, flag it specifically naming which variant is missing what.

Respond ONLY in valid JSON (no markdown, no backticks):
{
  "images": [{"index": 0, "has_model": true, "angle": "front", "background": "white", "quality": "professional", "crop_style": "full_body", "shows_product_detail": false, "variant_guess": "blue", "brief": "model wearing blue version, white studio, front view"}],
  "inconsistencies": [
    {"type": "variant_coverage", "detail": "Blue variant has model shots but Red and Green only have flat lays"},
    {"type": "missing_angles", "detail": "Green variant shows interior pocket detail not present in Blue or Red"},
    {"type": "style_mismatch", "detail": "Images 0-2 are studio shots with soft lighting, images 3-4 are harsh flash with shadows"}
  ],
  "severity": "none" | "low" | "medium" | "high",
  "summary": "One line overall assessment",
  "missing": ["List what's missing that should exist, e.g. 'back view for red variant', 'model shot for green variant'"]
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1500,
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
