import { useState, useRef } from 'react'

const BATCH_DELAY = 1500

const SEV = {
  critical: { bg: '#14091f', text: '#c084fc', border: '#7e22ce', light: '#faf5ff', ltext: '#7e22ce', lborder: '#e9d5ff' },
  high:     { bg: '#1c0808', text: '#f87171', border: '#7f1d1d', light: '#fff1f2', ltext: '#be123c', lborder: '#fda4af' },
  medium:   { bg: '#1c0f05', text: '#fb923c', border: '#9a3412', light: '#fff7ed', ltext: '#9a3412', lborder: '#fed7aa' },
  low:      { bg: '#1a1a0a', text: '#facc15', border: '#854d0e', light: '#fefce8', ltext: '#854d0e', lborder: '#fde68a' },
  info:     { bg: '#0a1628', text: '#60a5fa', border: '#1e3a5f', light: '#eff6ff', ltext: '#1d4ed8', lborder: '#bfdbfe' },
  none:     { bg: '#052e16', text: '#4ade80', border: '#166534', light: '#f0fdf4', ltext: '#166534', lborder: '#bbf7d0' },
}

const ISSUE_ICONS = {
  variant_coverage: '🎨', missing_angles: '📐', style_mismatch: '🎭',
  quality_mismatch: '📸', no_model: '🚫', model_inconsistency: '👤',
  brand_deviation: '⚠️', seo: '🔍', seo_alt_text: '🔍', seo_filenames: '🔍',
  seo_format: '🔍', seo_gallery_order: '📋', duplicate: '♻️', resolution: '🖼',
  page_load: '⏱️', image_size: '🗜️',
  gallery_order: '📋', size_info: 'ℹ️', size_only: 'ℹ️', variant_integrity: '🏷️',
  missing_detail: '🔬', missing_hero: '⭐', wrong_variant_media: '❌',
  missing_model: '🚫', variant_ambiguity: '🏷️', missing_category: '📐',
  near_duplicate: '♻️', consistency: '🎭', merchandising: '⚠️', other: '▸',
}

function getStoreBaseUrl(storeUrl) {
  if (!storeUrl) return ''
  let u = storeUrl.trim().replace(/\/+$/, '')
  if (!u.startsWith('http')) u = 'https://' + u
  return u
}

function getProductUrl(storeUrl, product) {
  if (!storeUrl || !storeUrl.trim()) return null
  const handle = product?.handle || product?.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!handle) return null
  return `${getStoreBaseUrl(storeUrl)}/products/${handle}`
}

function getProductCategory(product) {
  return (product?.product_type || '').trim() || 'Uncategorized'
}

function isProductAvailable(product) {
  if (product?.available === true) return true
  if (product && Object.prototype.hasOwnProperty.call(product, 'available')) return false
  return Array.isArray(product?.variants) && product.variants.some(v => v.available === true)
}

function filterAvailableProducts(products) {
  return Array.isArray(products) ? products.filter(isProductAvailable) : []
}

function slugify(value) {
  return (value || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return 'n/a'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function normalizeIssueEntry(entry, fallbackSeverity, forcedType) {
  if (typeof entry === 'string') {
    const detail = entry.trim()
    if (!detail) return null
    return { type: forcedType || 'other', severity: fallbackSeverity, detail }
  }

  if (!entry || typeof entry !== 'object') return null

  const detail = typeof entry.detail === 'string'
    ? entry.detail.trim()
    : typeof entry.message === 'string'
      ? entry.message.trim()
      : ''

  if (!detail) return null

  return {
    ...entry,
    type: forcedType || entry.type || 'other',
    severity: entry.severity || fallbackSeverity,
    detail,
  }
}

function collectIssues(analysis) {
  if (!analysis) return []
  return [
    ...(analysis.inconsistencies || []).map((entry) => normalizeIssueEntry(entry, analysis.severity)),
    ...(analysis.seo_issues || []).map((entry) => normalizeIssueEntry(entry, 'low', 'seo')),
  ].filter(Boolean)
}

export default function App() {
  const [storeUrl, setStoreUrl] = useState('')
  const [products, setProducts] = useState([])
  const [category, setCategory] = useState('all')
  const [phase, setPhase] = useState('input')
  const [results, setResults] = useState([])
  const [progress, setProgress] = useState({ current: 0, total: 0, status: '' })
  const [error, setError] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [exportingFormat, setExportingFormat] = useState('')
  const abortRef = useRef(false)
  const accRef = useRef([])
  const reportRef = useRef(null)

  const fetchProducts = async () => {
    setPhase('loading'); setError('')
    try {
      const res = await fetch('/api/fetch-products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeUrl }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')
      const availableProducts = filterAvailableProducts(data.products)
      if (!availableProducts.length) throw new Error('No available products found')
      // Use resolved URL from server (handles https:// normalization)
      if (data.storeBaseUrl) setStoreUrl(data.storeBaseUrl)
      setProducts(availableProducts); setCategory('all'); setPhase('loaded')
    } catch (e) {
      setError(e.message); setShowJson(true); setPhase('input')
    }
  }

  const loadJson = () => {
    try {
      const data = JSON.parse(jsonText)
      const prods = data.products || data
      if (!Array.isArray(prods) || !prods.length) throw new Error('Invalid or empty products')
      const availableProducts = filterAvailableProducts(prods)
      if (!availableProducts.length) throw new Error('No available products found')
      setProducts(availableProducts); setCategory('all'); setPhase('loaded'); setError('')
    } catch (e) { setError(e.message) }
  }

  // Classify variant dimension as visual or non-visual
  const classifyVariantDimension = (optionName) => {
    if (!optionName) return 'non_visual_variant'
    const lower = optionName.toLowerCase()
    const sizePatterns = /^(xx?[sl]|[sl]|m|xx?l|2xl|3xl|4xl|5xl|\d+|\d+\/\d+|one size|os|regular|petite|tall|short|long)$/
    if (sizePatterns.test(lower)) return 'non_visual_variant'
    const sizeWords = ['size', 'length', 'width', 'inseam', 'waist']
    if (sizeWords.some(w => lower.includes(w))) return 'non_visual_variant'
    return 'visual_variant'
  }

  const analyze = async () => {
    setPhase('analyzing'); abortRef.current = false; accRef.current = []
    const multi = filteredProducts.filter(p => p.images?.length > 1)
    setProgress({ current: 0, total: multi.length, status: 'Starting...' })

    if (!multi.length) { setError('No products with multiple images.'); setPhase('loaded'); return }

    for (let i = 0; i < multi.length; i++) {
      if (abortRef.current) break
      const product = multi[i]
      setProgress({ current: i + 1, total: multi.length, status: `Analyzing: ${product.title.slice(0, 50)}...` })

      try {
        // Filter to only available variants (strict: must be explicitly true)
        const availableVariants = (product.variants || []).filter(v => v.available === true)
        const variantData = availableVariants.map(v => {
          const dim = classifyVariantDimension(v.option1)
          return {
            title: v.title, option1: v.option1, option2: v.option2, option3: v.option3,
            dimension: dim,
            imageIndexes: product.images
              ?.map((img, idx) => img.variant_ids?.includes(v.id) ? idx : null)
              .filter(i => i !== null),
          }
        }) || []

        const imageAlts = product.images?.slice(0, 10).map(img => img.alt || '') || []
        const imageFilenames = product.images?.slice(0, 10).map(img => {
          try { return new URL(img.src).pathname.split('/').pop() } catch { return '' }
        }) || []

        const res = await fetch('/api/analyze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: product.title,
            productUrl: getProductUrl(storeUrl, product),
            imageUrls: product.images.slice(0, 10).map(img => img.src),
            variants: variantData.length > 1 ? variantData : undefined,
            productType: product.product_type || undefined,
            imageAlts,
            imageFilenames,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Analysis failed')
        accRef.current = [...accRef.current, { product, analysis: data }]
      } catch (e) {
        accRef.current = [...accRef.current, { product, error: e.message }]
      }
      setResults([...accRef.current])
      if (i < multi.length - 1 && !abortRef.current) await new Promise(r => setTimeout(r, BATCH_DELAY))
    }
    setPhase('results')
  }

  const stop = () => { abortRef.current = true; setPhase('results') }
  const reset = () => { setProducts([]); setCategory('all'); setPhase('input'); setResults([]); setProgress({ current: 0, total: 0, status: '' }); setError(''); accRef.current = [] }

  const buildReportData = () => {
    const generatedAt = new Date().toISOString()
    const selectedCategory = category === 'all' ? 'All categories' : category
    const enrich = (entry) => ({
      title: entry.product.title,
      category: getProductCategory(entry.product),
      productUrl: getProductUrl(storeUrl, entry.product),
      imageCount: entry.product.images?.length || 0,
      availableVariantCount: entry.product.variants?.filter(v => v.available === true).length || 0,
      handle: entry.product.handle || null,
      summary: entry.analysis?.summary || null,
      severity: entry.analysis?.severity || null,
      inconsistencies: entry.analysis?.inconsistencies || [],
      seoIssues: entry.analysis?.seo_issues || [],
      missing: entry.analysis?.missing || [],
      scores: entry.analysis?.scores || null,
      images: entry.analysis?.images || [],
      performance: entry.analysis?.performance || null,
      error: entry.error || null,
    })

    return {
      app: 'AhaRoll Asset Consistency Auditor',
      generatedAt,
      storeUrl: getStoreBaseUrl(storeUrl),
      selectedCategory,
      totalAvailableProducts: products.length,
      totalScopedProducts: filteredProducts.length,
      analyzedProducts: results.length,
      actionableProducts: sorted.length,
      stats,
      issues: sorted.map(enrich),
      clean: clean.map(enrich),
      infoOnly: infoOnly.map(enrich),
      errors: errors.map(enrich),
    }
  }

  const exportPdf = async () => {
    setExportingFormat('pdf')
    try {
      const html2pdf = (await import('html2pdf.js')).default
      const el = reportRef.current; if (!el) return
      const storeName = storeUrl ? storeUrl.replace(/https?:\/\//, '').replace(/\..*/,'') : 'store'
      const categorySuffix = category === 'all' ? 'all-categories' : slugify(category)
      await html2pdf().set({
        margin: [10, 10, 10, 10],
        filename: `aharoll-audit-${storeName}-${categorySuffix}-${new Date().toISOString().slice(0,10)}.pdf`,
        image: { type: 'jpeg', quality: 0.9 },
        html2canvas: { scale: 2, useCORS: true, allowTaint: true, logging: false, imageTimeout: 15000 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
      }).from(el).save()
    } catch (e) { setError('PDF export failed: ' + e.message) }
    finally { setExportingFormat('') }
  }

  const exportJson = () => {
    setExportingFormat('json')
    try {
      const data = buildReportData()
      const storeName = storeUrl ? storeUrl.replace(/https?:\/\//, '').replace(/\..*/, '') : 'store'
      downloadFile(
        `aharoll-audit-${storeName}-${category === 'all' ? 'all-categories' : slugify(category)}-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(data, null, 2),
        'application/json'
      )
    } catch (e) {
      setError('JSON export failed: ' + e.message)
    } finally {
      setExportingFormat('')
    }
  }

  const exportMarkdown = () => {
    setExportingFormat('md')
    try {
      const data = buildReportData()
      const storeName = data.storeUrl || 'Store'
      const sections = [
        '# Asset & SEO Audit Report',
        '',
        `- Store: ${storeName}`,
        `- Category: ${data.selectedCategory}`,
        `- Generated: ${data.generatedAt}`,
        `- Available products: ${data.totalAvailableProducts}`,
        `- Scoped products: ${data.totalScopedProducts}`,
        `- Analyzed products: ${data.analyzedProducts}`,
        '',
        '## Severity Summary',
        '',
        `- Critical: ${data.stats.critical}`,
        `- High: ${data.stats.high}`,
        `- Medium: ${data.stats.medium}`,
        `- Low: ${data.stats.low}`,
        `- Clean: ${data.clean.length + data.infoOnly.length}`,
        '',
        '## Issues',
        '',
      ]

      if (!data.issues.length) sections.push('No actionable issues found.', '')
      data.issues.forEach((issue, index) => {
        sections.push(`### ${index + 1}. ${issue.title}`)
        sections.push(`- Severity: ${issue.severity}`)
        sections.push(`- Category: ${issue.category}`)
        sections.push(`- Product URL: ${issue.productUrl || 'N/A'}`)
        sections.push(`- Summary: ${issue.summary || 'N/A'}`)
        if (issue.missing.length) sections.push(`- Missing: ${issue.missing.join(' | ')}`)
        if (issue.inconsistencies.length) {
          sections.push('- Findings:')
          issue.inconsistencies.forEach((entry) => {
            const normalized = normalizeIssueEntry(entry, issue.severity)
            if (!normalized) return
            const detail = normalized.detail
            const severity = normalized.severity
            sections.push(`  - [${severity}] ${detail}`)
          })
        }
        if (issue.seoIssues.length) {
          sections.push('- SEO:')
          issue.seoIssues.forEach((entry) => {
            const normalized = normalizeIssueEntry(entry, 'low', 'seo')
            if (!normalized) return
            const detail = normalized.detail
            sections.push(`  - ${detail}`)
          })
        }
        sections.push('')
      })

      sections.push('## Clean / Info Only', '')
      if (!data.clean.length && !data.infoOnly.length) sections.push('None', '')
      ;[...data.clean, ...data.infoOnly].forEach((entry) => {
        sections.push(`- ${entry.title} (${entry.category})${entry.productUrl ? ` - ${entry.productUrl}` : ''}`)
      })
      sections.push('', '## Failed', '')
      if (!data.errors.length) sections.push('None')
      data.errors.forEach((entry) => {
        sections.push(`- ${entry.title}: ${entry.error}`)
      })

      const storeNameSlug = storeUrl ? storeUrl.replace(/https?:\/\//, '').replace(/\..*/, '') : 'store'
      downloadFile(
        `aharoll-audit-${storeNameSlug}-${category === 'all' ? 'all-categories' : slugify(category)}-${new Date().toISOString().slice(0, 10)}.md`,
        sections.join('\n'),
        'text/markdown'
      )
    } catch (e) {
      setError('Markdown export failed: ' + e.message)
    } finally {
      setExportingFormat('')
    }
  }

  const exportHtml = () => {
    setExportingFormat('html')
    try {
      const data = buildReportData()
      const rows = data.issues.map((issue) => {
        const findings = issue.inconsistencies
          .map((entry) => normalizeIssueEntry(entry, issue.severity))
          .filter(Boolean)
          .map((entry) => `<li><strong>${escapeHtml(entry.severity || '')}</strong> ${escapeHtml(entry.detail || '')}</li>`)
          .join('')
        const seo = issue.seoIssues
          .map((entry) => normalizeIssueEntry(entry, 'low', 'seo'))
          .filter(Boolean)
          .map((entry) => `<li>${escapeHtml(entry.detail || '')}</li>`)
          .join('')
        return `
          <section class="card severity-${escapeHtml(issue.severity)}" data-severity="${escapeHtml(issue.severity || 'none')}">
            <div class="card-header">
              <div>
                <h3>${escapeHtml(issue.title)}</h3>
                <p>${escapeHtml(issue.category)} · <a href="${escapeHtml(issue.productUrl || '#')}">${escapeHtml(issue.productUrl || 'N/A')}</a></p>
              </div>
              <span class="badge">${escapeHtml(issue.severity || 'unknown')}</span>
            </div>
            <p class="summary">${escapeHtml(issue.summary || 'N/A')}</p>
            ${issue.missing.length ? `<p><strong>Missing:</strong> ${escapeHtml(issue.missing.join(' | '))}</p>` : ''}
            ${findings ? `<h4>Findings</h4><ul>${findings}</ul>` : ''}
            ${seo ? `<h4>SEO</h4><ul>${seo}</ul>` : ''}
          </section>
        `
      }).join('')

      const cleanRows = [...data.clean, ...data.infoOnly].map((entry) =>
        `<li>${escapeHtml(entry.title)} (${escapeHtml(entry.category)})${entry.productUrl ? ` - <a href="${escapeHtml(entry.productUrl)}">${escapeHtml(entry.productUrl)}</a>` : ''}</li>`
      ).join('')

      const failedRows = data.errors.map((entry) =>
        `<li>${escapeHtml(entry.title)}: ${escapeHtml(entry.error || '')}</li>`
      ).join('')

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Asset & SEO Audit Report</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 0; background: #f5f3ff; color: #1f2937; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
    .hero { background: linear-gradient(135deg, #581c87, #7e22ce); color: white; padding: 28px; border-radius: 16px; }
    .toolbar { display: flex; gap: 12px; align-items: center; margin: 20px 0 16px; flex-wrap: wrap; }
    .toolbar label { font-size: 14px; font-weight: 600; color: #4c1d95; }
    .toolbar select { border: 1px solid #d8b4fe; background: white; color: #1f2937; border-radius: 10px; padding: 10px 12px; font-size: 14px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 20px 0 28px; }
    .stat, .card { background: white; border: 1px solid #e9d5ff; border-radius: 14px; padding: 16px; }
    .stat strong { display: block; font-size: 28px; color: #7e22ce; }
    .card { margin-bottom: 16px; }
    .card-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .badge { background: #f3e8ff; color: #7e22ce; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .summary { color: #4b5563; }
    h1, h2, h3, h4, p { margin: 0 0 10px; }
    ul { margin: 0 0 12px 18px; }
    a { color: #6d28d9; }
    .severity-critical { border-color: #c084fc; box-shadow: 0 0 0 1px #e9d5ff inset; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>Asset & SEO Audit Report</h1>
      <p>Store: ${escapeHtml(data.storeUrl || 'N/A')}</p>
      <p>Category: ${escapeHtml(data.selectedCategory)}</p>
      <p>Generated: ${escapeHtml(data.generatedAt)}</p>
    </section>
    <section class="stats">
      <div class="stat"><strong>${data.stats.critical}</strong><span>Critical</span></div>
      <div class="stat"><strong>${data.stats.high}</strong><span>High</span></div>
      <div class="stat"><strong>${data.stats.medium}</strong><span>Medium</span></div>
      <div class="stat"><strong>${data.stats.low}</strong><span>Low</span></div>
      <div class="stat"><strong>${data.clean.length + data.infoOnly.length}</strong><span>Clean</span></div>
    </section>
    <section class="toolbar">
      <label for="severity-filter">Severity filter</label>
      <select id="severity-filter">
        <option value="all">All severities</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
    </section>
    <section>
      <h2>Issues</h2>
      ${rows || '<p>No actionable issues found.</p>'}
    </section>
    <section>
      <h2>Clean / Info Only</h2>
      ${cleanRows ? `<ul>${cleanRows}</ul>` : '<p>None</p>'}
    </section>
    <section>
      <h2>Failed</h2>
      ${failedRows ? `<ul>${failedRows}</ul>` : '<p>None</p>'}
    </section>
  </main>
  <script>
    const filter = document.getElementById('severity-filter');
    const cards = Array.from(document.querySelectorAll('[data-severity]'));
    if (filter) {
      filter.addEventListener('change', function () {
        const value = filter.value;
        cards.forEach((card) => {
          card.style.display = value === 'all' || card.dataset.severity === value ? '' : 'none';
        });
      });
    }
  </script>
</body>
</html>`

      const storeName = storeUrl ? storeUrl.replace(/https?:\/\//, '').replace(/\..*/, '') : 'store'
      downloadFile(
        `aharoll-audit-${storeName}-${category === 'all' ? 'all-categories' : slugify(category)}-${new Date().toISOString().slice(0, 10)}.html`,
        html,
        'text/html'
      )
    } catch (e) {
      setError('HTML export failed: ' + e.message)
    } finally {
      setExportingFormat('')
    }
  }

  // Derived
  const sevOrder = ['critical', 'high', 'medium', 'low', 'info', 'none']
  const categories = ['all', ...Array.from(new Set(products.map(getProductCategory))).sort((a, b) => a.localeCompare(b))]
  const filteredProducts = category === 'all' ? products : products.filter(p => getProductCategory(p) === category)
  const scopedAnalyzableProducts = filteredProducts.filter(p => p.images?.length > 1)
  const actionable = results.filter(r => r.analysis && !['none', 'info'].includes(r.analysis.severity) && !r.error)
  const infoOnly = results.filter(r => r.analysis && r.analysis.severity === 'info')
  const clean = results.filter(r => r.analysis?.severity === 'none')
  const errors = results.filter(r => r.error)
  const stats = {
    critical: actionable.filter(r => r.analysis.severity === 'critical').length,
    high: actionable.filter(r => r.analysis.severity === 'high').length,
    medium: actionable.filter(r => r.analysis.severity === 'medium').length,
    low: actionable.filter(r => r.analysis.severity === 'low').length,
  }
  const sorted = [...actionable].sort((a, b) => sevOrder.indexOf(a.analysis.severity) - sevOrder.indexOf(b.analysis.severity))

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* HEADER */}
      <header style={{
        borderBottom: '1px solid #18181b', padding: '16px 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: '#0a0a0b', position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 900, color: '#fff' }}>A</div>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>AhaRoll</span>
          <span style={{ fontSize: 11, color: '#52525b', borderLeft: '1px solid #27272a', paddingLeft: 10, marginLeft: 4 }}>Asset Auditor</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {phase === 'results' && results.length > 0 && (
            <>
              <button onClick={exportPdf} disabled={!!exportingFormat} style={{ ...btn, background: exportingFormat === 'pdf' ? '#27272a' : 'linear-gradient(135deg, #581c87, #7c3aed)', color: '#fff', fontWeight: 600 }}>
                {exportingFormat === 'pdf' ? 'Generating PDF...' : 'PDF'}
              </button>
              <button onClick={exportMarkdown} disabled={!!exportingFormat} style={{ ...btn, background: '#18181b', color: '#e4e4e7', fontWeight: 600 }}>
                {exportingFormat === 'md' ? 'Generating MD...' : 'MD'}
              </button>
              <button onClick={exportHtml} disabled={!!exportingFormat} style={{ ...btn, background: '#18181b', color: '#e4e4e7', fontWeight: 600 }}>
                {exportingFormat === 'html' ? 'Generating HTML...' : 'HTML'}
              </button>
              <button onClick={exportJson} disabled={!!exportingFormat} style={{ ...btn, background: '#18181b', color: '#e4e4e7', fontWeight: 600 }}>
                {exportingFormat === 'json' ? 'Generating JSON...' : 'JSON'}
              </button>
            </>
          )}
          {phase !== 'input' && <button onClick={reset} style={{ ...btn, background: '#18181b', color: '#a1a1aa' }}>New Audit</button>}
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px' }}>
        {/* INPUT */}
        {phase === 'input' && (
          <div style={{ maxWidth: 560, margin: '80px auto 0' }}>
            <h1 style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1.1, marginBottom: 12 }}>
              Audit your product<br />imagery & SEO
            </h1>
            <p style={{ color: '#71717a', fontSize: 15, marginBottom: 40, lineHeight: 1.6 }}>
              Detect variant coverage gaps, missing angles, SEO issues, and visual inconsistencies across every product.
            </p>
            {!showJson ? (
              <div>
                <label style={labelStyle}>Shopify store URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" placeholder="brand.myshopify.com or brand.com" value={storeUrl}
                    onChange={e => setStoreUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && storeUrl && fetchProducts()}
                    style={inputStyle} />
                  <button onClick={fetchProducts} disabled={!storeUrl} style={{ ...btn, padding: '12px 28px', background: storeUrl ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : '#18181b', color: storeUrl ? '#fff' : '#52525b', fontWeight: 600, cursor: storeUrl ? 'pointer' : 'not-allowed' }}>Fetch</button>
                </div>
                <button onClick={() => setShowJson(true)} style={linkBtn}>Paste products.json manually instead</button>
              </div>
            ) : (
              <div>
                <label style={labelStyle}>Store URL <span style={{ color: '#52525b' }}>(for product links)</span></label>
                <input type="text" placeholder="brand.com" value={storeUrl} onChange={e => setStoreUrl(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />
                <label style={labelStyle}>Paste products.json</label>
                <textarea placeholder='{"products": [...]}' value={jsonText} onChange={e => setJsonText(e.target.value)} style={{ ...inputStyle, height: 180, resize: 'vertical', fontFamily: "'SF Mono', monospace", fontSize: 12 }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={loadJson} disabled={!jsonText} style={{ ...btn, padding: '10px 24px', background: jsonText ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : '#18181b', color: jsonText ? '#fff' : '#52525b', fontWeight: 600 }}>Load</button>
                  <button onClick={() => { setShowJson(false); setError('') }} style={{ ...btn, padding: '10px 24px', background: '#18181b', color: '#a1a1aa' }}>Back</button>
                </div>
              </div>
            )}
            {error && <div style={errorBox}>{error}</div>}
          </div>
        )}

        {/* LOADING */}
        {phase === 'loading' && (
          <div style={{ textAlign: 'center', padding: '120px 0' }}>
            <Spinner />
            <div style={{ color: '#71717a', fontSize: 14, marginTop: 20 }}>Fetching products...</div>
          </div>
        )}

        {/* LOADED */}
        {phase === 'loaded' && (
          <div>
            <div style={{ background: 'linear-gradient(180deg, #12091b, #0f0f13)', border: '1px solid #2a1b3d', borderRadius: 18, padding: '20px 20px 18px', marginBottom: 28 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#a78bfa', marginBottom: 10 }}>
                Step 1
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap' }}>
                <div>
                  <h2 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.04em', marginBottom: 6 }}>Choose category scope first</h2>
                  <div style={{ color: '#a1a1aa', fontSize: 14 }}>
                    {products.length} available products loaded across {categories.length - 1} categories
                  </div>
                </div>
                <div style={{ minWidth: 220, background: '#140f1c', border: '1px solid #312042', borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ fontSize: 11, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Current scope</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: '#f5f3ff' }}>{category === 'all' ? 'All categories' : category}</div>
                  <div style={{ fontSize: 12, color: '#8a7ca2', marginTop: 4 }}>{filteredProducts.length} products · {scopedAnalyzableProducts.length} analyzable</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {categories.map(option => {
                  const selected = option === category
                  const count = option === 'all' ? products.length : products.filter(p => getProductCategory(p) === option).length
                  const analyzableCount = option === 'all'
                    ? products.filter(p => p.images?.length > 1).length
                    : products.filter(p => getProductCategory(p) === option && p.images?.length > 1).length

                  return (
                    <button
                      key={option}
                      onClick={() => setCategory(option)}
                      style={{
                        ...btn,
                        padding: '12px 14px',
                        minWidth: 170,
                        textAlign: 'left',
                        background: selected ? 'linear-gradient(135deg, #6d28d9, #9333ea)' : '#141419',
                        border: selected ? '1px solid #c084fc' : '1px solid #26262f',
                        color: '#fff',
                      }}
                    >
                      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{option === 'all' ? 'All categories' : option}</div>
                      <div style={{ fontSize: 11, color: selected ? '#ede9fe' : '#8b8b98' }}>{count} products</div>
                      <div style={{ fontSize: 11, color: selected ? '#ddd6fe' : '#6b7280', marginTop: 2 }}>{analyzableCount} with multiple images</div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: '-0.04em' }}>{filteredProducts.length}</div>
              <div style={{ color: '#71717a', fontSize: 14 }}>
                available products in scope · <span style={{ color: '#a1a1aa' }}>{scopedAnalyzableProducts.length} with multiple images</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 6, marginBottom: 28, maxHeight: 340, overflowY: 'auto', padding: 2 }}>
              {filteredProducts.slice(0, 80).map((p, i) => (
                <a key={i} href={getProductUrl(storeUrl, p)} target="_blank" rel="noopener noreferrer" style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', border: '1px solid #1e1e24', background: '#111', display: 'block', textDecoration: 'none' }}>
                  {p.images?.[0] ? <img src={p.images[0].src} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#52525b' }}>No img</div>}
                  {p.images?.length > 1 && <div style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.75)', borderRadius: 4, padding: '1px 6px', fontSize: 10, color: '#ccc' }}>{p.images.length}</div>}
                </a>
              ))}
            </div>
            <button onClick={analyze} style={{ width: '100%', ...btn, padding: '16px', background: 'linear-gradient(135deg, #581c87, #7c3aed)', color: '#fff', fontSize: 16, fontWeight: 700 }}>
              Run {category === 'all' ? 'Full' : category} Audit
            </button>
            {error && <div style={errorBox}>{error}</div>}
          </div>
        )}

        {/* ANALYZING + RESULTS */}
        {(phase === 'analyzing' || phase === 'results') && (
          <div>
            {phase === 'analyzing' && (
              <div style={{ marginBottom: 32 }}>
                <div style={{ fontSize: 12, color: '#a78bfa', marginBottom: 10 }}>
                  Scope: {category === 'all' ? 'All categories' : category} · {scopedAnalyzableProducts.length} products queued
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#a1a1aa', marginBottom: 8 }}>
                  <span style={{ maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progress.status}</span>
                  <span>{Math.round((progress.current / progress.total) * 100)}%</span>
                </div>
                <div style={{ height: 4, background: '#1e1e24', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(progress.current / progress.total) * 100}%`, background: 'linear-gradient(90deg, #6366f1, #a78bfa)', borderRadius: 2, transition: 'width 0.4s ease' }} />
                </div>
                <button onClick={stop} style={{ ...btn, marginTop: 10, background: '#18181b', color: '#f87171', fontSize: 12 }}>Stop</button>
              </div>
            )}

            {/* Stats */}
            {results.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 24 }}>
                {[
                  { label: 'Critical', n: stats.critical, c: '#ef4444' },
                  { label: 'High', n: stats.high, c: '#f87171' },
                  { label: 'Medium', n: stats.medium, c: '#fb923c' },
                  { label: 'Low', n: stats.low, c: '#facc15' },
                  { label: 'Clean', n: clean.length + infoOnly.length, c: '#4ade80' },
                ].map(s => (
                  <div key={s.label} style={{ background: '#111114', border: '1px solid #1e1e24', borderRadius: 10, padding: '12px 8px', textAlign: 'center' }}>
                    <div style={{ fontSize: 26, fontWeight: 800, color: s.c, letterSpacing: '-0.03em' }}>{s.n}</div>
                    <div style={{ fontSize: 10, color: '#71717a', marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Issue cards */}
            {sorted.length > 0 && (
              <div style={{ marginBottom: 32 }}>
                <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 16 }}>Issues Found ({sorted.length})</h3>
                {sorted.map((r, i) => <ProductCard key={i} r={r} storeUrl={storeUrl} />)}
              </div>
            )}

            {errors.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <h4 style={{ fontSize: 13, color: '#71717a', marginBottom: 8 }}>Failed ({errors.length})</h4>
                {errors.map((r, i) => <div key={i} style={{ background: '#111', border: '1px solid #1e1e24', borderRadius: 8, padding: '8px 14px', marginBottom: 4, fontSize: 12, color: '#71717a' }}>{r.product.title}: {r.error}</div>)}
              </div>
            )}

            {phase === 'results' && (clean.length > 0 || infoOnly.length > 0) && (
              <div>
                <h4 style={{ fontSize: 13, color: '#4ade80', fontWeight: 600, marginBottom: 8 }}>Clean / Info Only ({clean.length + infoOnly.length})</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {[...clean, ...infoOnly].map((r, i) => (
                    <a key={i} href={getProductUrl(storeUrl, r.product)} target="_blank" rel="noopener noreferrer" style={{ background: '#052e16', border: '1px solid #166534', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#4ade80', textDecoration: 'none' }}>
                      {r.product.title}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* PDF REPORT */}
      {results.length > 0 && (
        <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
          <div ref={reportRef} style={{ width: '794px', background: '#fff', color: '#111', fontFamily: "'Inter', sans-serif", fontSize: '13px' }}>
            <PdfReport storeUrl={storeUrl} products={filteredProducts} issues={sorted} clean={clean} infoOnly={infoOnly} stats={stats} category={category} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── ProductCard ──
function ProductCard({ r, storeUrl }) {
  const sev = SEV[r.analysis.severity] || SEV.medium
  const productUrl = getProductUrl(storeUrl, r.product)
  const allIssues = collectIssues(r.analysis)

  return (
    <div style={{ background: sev.bg, border: `1px solid ${sev.border}`, borderRadius: 12, padding: 20, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {productUrl
              ? <a href={productUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#e4e4e7', textDecoration: 'none', borderBottom: '1px dashed #52525b' }}>{r.product.title}</a>
              : r.product.title}
          </div>
          <div style={{ fontSize: 12, color: '#71717a', marginTop: 2 }}>
            {r.product.images?.length} images · {r.product.variants?.filter(v => v.available === true).length || 0} available variants
            {r.analysis.detected_category && <span style={{ color: '#52525b' }}> · {r.analysis.detected_category}</span>}
            {r.product.variants?.filter(v => v.available === true).length > 1 && (
              <span style={{ color: '#52525b' }}>
                {' '}({r.product.variants.filter(v => v.available === true).slice(0, 4).map(v => v.title || v.option1).join(', ')}{r.product.variants.filter(v => v.available === true).length > 4 ? ` +${r.product.variants.filter(v => v.available === true).length - 4}` : ''})
              </span>
            )}
          </div>
          {productUrl && <a href={productUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#6366f1', textDecoration: 'underline' }}>{productUrl}</a>}
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: sev.text, background: `${sev.text}20`, padding: '3px 8px', borderRadius: 4, height: 'fit-content' }}>{r.analysis.severity}</span>
      </div>

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 14, paddingBottom: 4 }}>
        {r.product.images?.slice(0, 10).map((img, idx) => {
          const a = r.analysis.images?.find(x => x.index === idx)
          return (
            <div key={idx} style={{ flexShrink: 0, textAlign: 'center' }}>
              <img src={img.src} alt="" loading="lazy" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `2px solid ${sev.border}` }} />
              {a && <div style={{ fontSize: 9, color: '#71717a', marginTop: 3, lineHeight: 1.3, maxWidth: 72 }}>
                {a.has_model ? '👤' : '📦'} {a.angle}
                {a.variant_guess && <><br /><span style={{ color: '#52525b' }}>{a.variant_guess}</span></>}
              </div>}
            </div>
          )
        })}
      </div>

      <div style={{ fontSize: 13, color: '#a1a1aa', fontStyle: 'italic', marginBottom: 12 }}>{r.analysis.summary}</div>

      {r.analysis.performance && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 11, color: '#d4d4d8', background: '#18181b', border: '1px solid #27272a', borderRadius: 999, padding: '4px 8px' }}>
            Load {formatDuration(r.analysis.performance.pageLoadMs)}
          </span>
          <span style={{ fontSize: 11, color: '#d4d4d8', background: '#18181b', border: '1px solid #27272a', borderRadius: 999, padding: '4px 8px' }}>
            Images {formatBytes(r.analysis.performance.totalImageBytes)}
          </span>
        </div>
      )}

      {allIssues.map((issue, j) => {
        const icon = ISSUE_ICONS[issue.type] || '▸'
        const issueSev = SEV[issue.severity] || sev
        return (
          <div key={j} style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 6, alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, fontSize: 11 }}>{icon}</span>
            <div>
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: issueSev.text, marginRight: 6 }}>{issue.severity || ''}</span>
              <span style={{ color: '#d4d4d8' }}>{issue.detail}</span>
            </div>
          </div>
        )
      })}

      {r.analysis.missing?.length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: `${sev.text}10`, borderRadius: 6, fontSize: 12, color: sev.text }}>
          <span style={{ fontWeight: 600 }}>Missing: </span>{r.analysis.missing.join(' · ')}
        </div>
      )}

      {r.analysis.variant_classification?.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {r.analysis.variant_classification.map((vc, k) => (
            <span key={k} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: vc.type === 'visual_variant' ? '#6366f120' : '#27272a', color: vc.type === 'visual_variant' ? '#818cf8' : '#71717a', border: `1px solid ${vc.type === 'visual_variant' ? '#6366f140' : '#333'}` }}>
              {vc.name}: {vc.type === 'visual_variant' ? 'visual' : 'non-visual'}
            </span>
          ))}
        </div>
      )}

      {r.analysis.scores && (
        <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { key: 'asset_coverage', label: 'Assets' },
            { key: 'variant_integrity', label: 'Variants' },
            { key: 'seo_accessibility', label: 'SEO' },
          ].map(s => {
            const val = r.analysis.scores[s.key]
            if (val == null) return null
            const col = val >= 80 ? '#4ade80' : val >= 50 ? '#facc15' : '#f87171'
            return (
              <div key={s.key} style={{ flex: 1, minWidth: 80 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#71717a', marginBottom: 3 }}>
                  <span>{s.label}</span><span style={{ color: col, fontWeight: 600 }}>{val}</span>
                </div>
                <div style={{ height: 3, background: '#1e1e24', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${val}%`, background: col, borderRadius: 2 }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── PDF Report ──
function PdfReport({ storeUrl, products, issues, clean, infoOnly, stats, category }) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const storeName = storeUrl ? storeUrl.replace(/https?:\/\//, '').replace(/\/.*/, '') : 'Store'

  return (
    <div>
      <div style={{ background: 'linear-gradient(135deg, #1e1b4b, #312e81)', padding: '40px 48px', color: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 900 }}>A</div>
          <span style={{ fontWeight: 700, fontSize: 14 }}>AhaRoll</span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', margin: 0 }}>Asset & SEO Audit Report</h1>
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>{storeName} · {date} · {products.length} products in scope · {category === 'all' ? 'All categories' : category}</p>
      </div>

      <div style={{ display: 'flex', gap: 12, padding: '24px 48px' }}>
        {[
          { label: 'Critical', n: stats.critical, c: '#7e22ce' },
          { label: 'High', n: stats.high, c: '#e11d48' },
          { label: 'Medium', n: stats.medium, c: '#ea580c' },
          { label: 'Low', n: stats.low, c: '#ca8a04' },
          { label: 'Clean', n: (clean?.length || 0) + (infoOnly?.length || 0), c: '#16a34a' },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.c }}>{s.n}</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: '8px 48px 40px' }}>
        {issues.length > 0 && <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Issues ({issues.length})</h2>}

        {issues.map((r, i) => {
          const sev = SEV[r.analysis.severity] || SEV.medium
          const productUrl = getProductUrl(storeUrl, r.product)
          const allIssues = collectIssues(r.analysis)

          return (
            <div key={i} style={{ background: sev.light, border: `1px solid ${sev.lborder}`, borderRadius: 10, padding: 20, marginBottom: 12, pageBreakInside: 'avoid' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111' }}>{r.product.title}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {r.product.images?.length} images · {r.product.variants?.length || 0} variants
                    {r.analysis.detected_category && ` · ${r.analysis.detected_category}`}
                  </div>
                  {productUrl && <a href={productUrl} style={{ fontSize: 11, color: '#6366f1' }}>{productUrl}</a>}
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: sev.ltext, background: sev.lborder, padding: '3px 10px', borderRadius: 5, height: 'fit-content' }}>{r.analysis.severity}</span>
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                {r.product.images?.slice(0, 10).map((img, idx) => {
                  const a = r.analysis.images?.find(x => x.index === idx)
                  return (
                    <div key={idx} style={{ textAlign: 'center' }}>
                      <img src={img.src} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: `2px solid ${sev.lborder}` }} crossOrigin="anonymous" />
                      {a && <div style={{ fontSize: 8, color: '#888', marginTop: 2 }}>{a.has_model ? 'Model' : 'No model'} / {a.angle}{a.variant_guess ? ` / ${a.variant_guess}` : ''}</div>}
                    </div>
                  )
                })}
              </div>

              <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic', marginBottom: 8 }}>{r.analysis.summary}</div>

              {r.analysis.performance && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <span style={{ fontSize: 10, color: '#444', background: '#fff', border: '1px solid #ddd6fe', borderRadius: 999, padding: '4px 8px' }}>
                    Load {formatDuration(r.analysis.performance.pageLoadMs)}
                  </span>
                  <span style={{ fontSize: 10, color: '#444', background: '#fff', border: '1px solid #ddd6fe', borderRadius: 999, padding: '4px 8px' }}>
                    Images {formatBytes(r.analysis.performance.totalImageBytes)}
                  </span>
                </div>
              )}

              {allIssues.map((issue, j) => {
                const issueSev = SEV[issue.severity] || sev
                return (
                  <div key={j} style={{ display: 'flex', gap: 6, fontSize: 12, color: issueSev.ltext, marginBottom: 4 }}>
                    <span>▸</span>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 10, textTransform: 'uppercase', marginRight: 4 }}>{issue.severity || ''}</span>
                      <span style={{ color: '#333' }}>{issue.detail}</span>
                    </div>
                  </div>
                )
              })}

              {r.analysis.missing?.length > 0 && (
                <div style={{ marginTop: 8, padding: '6px 10px', background: `${sev.lborder}40`, borderRadius: 4, fontSize: 11, color: sev.ltext }}>
                  <span style={{ fontWeight: 600 }}>Missing: </span>{r.analysis.missing.join(' · ')}
                </div>
              )}
            </div>
          )
        })}

        {(clean?.length > 0 || infoOnly?.length > 0) && (
          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#16a34a', marginBottom: 8 }}>Clean / Info Only ({(clean?.length || 0) + (infoOnly?.length || 0)})</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[...(clean || []), ...(infoOnly || [])].map((r, i) => (
                <a key={i} href={getProductUrl(storeUrl, r.product) || '#'} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: '#166534', textDecoration: 'none' }}>{r.product.title}</a>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid #e5e7eb', textAlign: 'center', fontSize: 11, color: '#aaa' }}>
          Generated by AhaRoll · aharoll.com
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return (<>
    <div style={{ width: 36, height: 36, border: '3px solid #27272a', borderTop: '3px solid #6366f1', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto' }} />
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </>)
}

const btn = { border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, padding: '8px 16px' }
const inputStyle = { flex: 1, background: '#111114', border: '1px solid #27272a', borderRadius: 8, padding: '12px 16px', color: '#e4e4e7', fontSize: 14, outline: 'none', width: '100%' }
const labelStyle = { fontSize: 13, color: '#a1a1aa', display: 'block', marginBottom: 8 }
const linkBtn = { background: 'none', border: 'none', color: '#6366f1', fontSize: 12, cursor: 'pointer', marginTop: 14, padding: 0 }
const errorBox = { marginTop: 14, padding: '10px 14px', background: '#1c0f05', border: '1px solid #9a3412', borderRadius: 8, color: '#fb923c', fontSize: 13 }
