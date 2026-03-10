# Application Description

AhaRoll Asset Consistency Auditor is an internal sales tool for auditing Shopify product imagery and basic image SEO at store scale. It accepts either a Shopify store URL or raw `products.json`, pulls the catalog, analyzes product galleries with an OpenAI vision model, surfaces severity-ranked issues, and exports a branded PDF report for client-facing use.

The application is optimized for audit throughput rather than deep workflow complexity. It focuses on products with multiple images, classifies likely visual merchandising issues, and produces a compact review artifact suitable for sales or account strategy conversations.

# Architecture

## Runtime shape

- Frontend: single-page React application built with Vite.
- Backend: two Vercel serverless functions under `api/`.
- External systems: Shopify storefront `products.json` endpoint and OpenAI Chat Completions API.
- Report generation: client-side HTML-to-PDF conversion with `html2pdf.js`.

## High-level flow

1. User enters a Shopify store URL or pastes `products.json`.
2. Frontend calls `/api/fetch-products` to normalize the store URL and fetch all products without browser CORS issues.
3. Frontend filters products down to those with multiple images and analyzes them sequentially.
4. For each product, frontend sends up to 10 image URLs plus variant and SEO metadata to `/api/analyze`.
5. `/api/analyze` builds a structured vision prompt and sends it to OpenAI.
6. The returned JSON is merged with the original product record and rendered into issue cards, severity summaries, and clean/info-only buckets.
7. The full result set can be rendered into an off-screen report component and exported as a PDF.

## Frontend structure

The UI is implemented almost entirely in [`src/App.jsx`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/src/App.jsx). It functions as a small state machine driven by the `phase` state:

- `input`: collect store URL or manual JSON.
- `loading`: fetch product catalog.
- `loaded`: preview catalog and start audit.
- `analyzing`: process products one by one with progress tracking and stop support.
- `results`: show grouped findings and allow PDF export.

Primary frontend responsibilities:

- Input normalization and fallback to manual JSON mode.
- Catalog preview with product links back to the audited store.
- Sequential audit orchestration with a fixed delay between products.
- Lightweight variant classification into `visual_variant` vs `non_visual_variant`.
- Aggregation of issue severity counts and separation of actionable, clean, info-only, and failed items.
- PDF report rendering through an off-screen `PdfReport` component.

Notable implementation choices:

- Analysis is intentionally serialized, not parallelized.
- Only the first 10 product images are sent for analysis.
- Only variants with `available === true` are considered during audit preparation.
- Products with 0 or 1 image are excluded from the analysis pass.

## Backend structure

### `/api/fetch-products`

File: [`api/fetch-products.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/fetch-products.js)

Responsibilities:

- Accept a POST body containing `storeUrl`.
- Normalize the URL to HTTPS and strip trailing slashes.
- Fetch Shopify `products.json` pages server-side.
- Support both cursor-based pagination via the `Link` header and legacy page-based pagination.
- Return the accumulated product list plus pagination metadata and normalized `storeBaseUrl`.

Operational constraints:

- Hard cap of 50 pages.
- Uses `limit=250` per page.
- Returns a 500 on Shopify fetch failures.

### `/api/analyze`

File: [`api/analyze.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/analyze.js)

Responsibilities:

- Validate API key presence and request payload.
- Convert image URLs into OpenAI vision input blocks.
- Encode product title, variant structure, product category hint, alt text, and filenames into the prompt.
- Instruct the model to return strict JSON containing image classifications, inconsistencies, severity, missing coverage, SEO issues, and numeric scores.
- Parse the model output and return it directly to the frontend.

Model contract:

- Uses OpenAI Chat Completions with model `gpt-5.1`.
- Expects machine-readable JSON only.
- Treats severity as one of `critical`, `high`, `medium`, `low`, `info`, or `none`.

## Data model assumptions

The app assumes Shopify-style product objects containing at least:

- `title`
- `handle`
- `images[]` with `src`, optional `alt`, and optional `variant_ids`
- `variants[]` with availability and option fields
- optional `product_type`

The analysis pipeline derives:

- variant-to-image index mapping from `image.variant_ids`
- alt-text quality signals from `images[].alt`
- filename quality signals from image URL path segments
- product page links from `storeUrl + /products/{handle}`

## Output model

The main output is a severity-ranked audit view with:

- summary counters by severity
- per-product issue cards
- thumbnail strip with model/angle annotations
- missing asset callouts
- score bars for asset coverage, variant integrity, and SEO accessibility
- clean/info-only product grouping
- failure list for products whose analysis request failed

The secondary output is a branded PDF report generated from the same result set in a print-oriented layout.

# File Map

- [`src/main.jsx`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/src/main.jsx): React bootstrap.
- [`src/App.jsx`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/src/App.jsx): application state, audit orchestration, UI, and PDF report rendering.
- [`src/index.css`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/src/index.css): global reset and base visual styling.
- [`api/fetch-products.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/fetch-products.js): Shopify product catalog proxy.
- [`api/analyze.js`](/Users/ilia/dev/aharoll/aharoll-asset-auditor/api/analyze.js): OpenAI-powered image audit endpoint.

# Operational Notes

- Local frontend-only Vite dev is insufficient for the full app because `/api/*` routes depend on the Vercel runtime.
- The app requires `OPENAI_API_KEY` in environment configuration.
- PDF generation happens in the browser, so report fidelity depends on browser rendering and remote image accessibility.
