# AhaRoll Asset Consistency Auditor

Internal sales tool. Audits any Shopify store's product imagery for visual inconsistencies (models, angles, backgrounds, quality). Generates branded PDF reports for client presentations.

## Setup

```bash
npm install
```

## Local dev

```bash
# Create .env.local with your OpenAI API key
echo "OPENAI_API_KEY=sk-xxxxx" > .env.local

# Note: API routes (/api/*) only work on Vercel.
# For local dev, use: npx vercel dev
npx vercel dev
```

## Deploy to Vercel

```bash
# First time
npx vercel

# Production
npx vercel --prod
```

Add `OPENAI_API_KEY` as an environment variable in Vercel project settings.

## How it works

1. Enter a Shopify store URL (or paste products.json)
2. Server-side proxy fetches all products (no CORS issues)
3. AI analyzes each product's image set for inconsistencies
4. Results displayed with severity ratings and image thumbnails
5. Export PDF report for client presentation

## Architecture

- **Frontend**: Vite + React
- **API**: Vercel serverless functions
  - `/api/fetch-products` — proxies Shopify products.json
  - `/api/analyze` — sends images to GPT-4o-mini Vision, returns classifications
- **PDF**: html2pdf.js (client-side generation with product images)
