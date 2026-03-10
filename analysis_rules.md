# Analysis Rules

These are the rules enforced by the image analysis prompt used by the application.

## Image Classification

Each image is classified with:

- `has_model`: `true` or `false`
- `angle`: `front` | `back` | `side` | `3/4` | `detail` | `flat_lay` | `lifestyle` | `overhead` | `closeup` | `sole` | `inside` | `top`
- `background`: `white` | `solid_color` | `studio` | `lifestyle` | `outdoor` | `other`
- `quality`: `professional` | `good` | `amateur` | `poor`
- `crop_style`: `full_body` | `half_body` | `product_only` | `close_up` | `wide`
- `shows_detail`: `true` or `false`
- `variant_guess`: likely color or pattern variant shown in the image

## Severity Rules

### Critical

Use only for issues that create product confusion or wrong variant presentation.

1. Missing media for a visual variant.
2. Wrong media assigned to a variant.
3. No usable hero image for a visual variant.
4. Buyable variant has zero media.
5. Variant ambiguity caused by gallery reuse across visually different variants.
6. All key images missing alt text.
7. Alt text references the wrong variant.

### High

Use when the product is purchasable but coverage is weak and conversion risk is high.

1. Missing supporting angles.
2. Missing detail shot.
3. Missing model or on-body imagery for fit-dependent products.
4. Missing category-specific coverage.
5. Duplicate alt text across all gallery images.
6. Poor filenames such as machine-generated names.
7. Poor image format or size choices.

### Medium

Use for quality or conversion problems that do not create product confusion.

1. Repetitive or near-duplicate images.
2. Inconsistent crop, framing, or aspect ratios.
3. Inconsistent background or lighting within a product gallery.
4. Weak gallery order.
5. No lifestyle image or optional media.
6. Duplicate images across different products.
7. Decorative text burned into images.

### Low

Use for minor issues that do not materially affect understanding.

1. One slightly redundant image.
2. One angle weaker than the rest.
3. Minor background inconsistency.
4. Metadata polish issues.

### Info

Use for acceptable omissions, not actionable gaps.

1. Size-only variants sharing images when appearance does not change.
2. Missing duplicate angle coverage per size.
3. Missing editorial extras such as a second lifestyle image.

## Size-Only Exception

Do not treat missing size-specific imagery as critical when the visual appearance does not change. Escalate only if size materially changes appearance, such as petite vs tall, width-driven footwear silhouette changes, or proportion changes in furniture.

## Category Coverage Templates

- Apparel and dresses: front, back, side or 3/4, detail, model shot
- Tops, knitwear, jackets: front, back, side, fabric or closure detail, model
- Shoes: lateral side, front or top, back, sole, detail, on-foot optional
- Bags and accessories: front, back, side, inside or open, hardware or strap detail
- Jewelry: hero, close-up, scale reference, clasp detail
- Furniture: hero, angled view, material detail, in-room context

## SEO Checks

Evaluate:

- Alt text quality
- Filename quality
- Gallery ordering
- Visible image quality issues such as blur, watermarks, screenshots, or low resolution

## Required Response Shape

The model must return JSON with:

- `images`
- `inconsistencies`
- `severity`
- `summary`
- `missing`
- `seo_issues`
- `scores.asset_coverage`
- `scores.variant_integrity`
- `scores.seo_accessibility`
