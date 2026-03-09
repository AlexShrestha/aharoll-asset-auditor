import { useState, useRef } from 'react'

const BATCH_DELAY = 1500

const SEV = {
  critical: { bg: '#1c0505', text: '#ef4444', border: '#991b1b', light: '#fef2f2', ltext: '#991b1b', lborder: '#fecaca' },
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
  gallery_order: '📋', size_info: 'ℹ️', size_only: 'ℹ️', variant_integrity: '🏷️',
  missing_detail: '🔬', missing_hero: '⭐', wrong_variant_media: '❌',
  missing_model: '🚫', variant_ambiguity: '🏷️', missing_category: '📐',
  near_duplicate: '♻️', consistency: '🎭', merchandising: '⚠️', other: '▸',
}

function getStoreBaseUrl(storeUrl) {
  let u = storeUrl.trim().replace(/\/+$/, '')
  if (!u.startsWith('http')) u = 'https://' + u
  return u
}

function getProductUrl(storeUrl, handle) {
  if (!handle) return null
  return `${getStoreBaseUrl(storeUrl)}/products/${handle}`
}

export default function App() {
  const [storeUrl, setStoreUrl] = useState('')
  const [products, setProducts] = useState([])
  const [phase, setPhase] = useState('input')
  const [results, setResults] = useState([])
  const [progress, setProgress] = useState({ current: 0, total: 0, status: '' })
  const [error, setError] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [exporting, setExporting] = useState(false)
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
      if (!data.products?.length) throw new Error('No products found')
      setProducts(data.products); setPhase('loaded')
    } catch (e) {
      setError(e.message); setShowJson(true); setPhase('input')
    }
  }

  const loadJson = () => {
    try {
      const data = JSON.parse(jsonText)
      const prods = data.products || data
      if (!Array.isArray(prods) || !prods.length) throw new Error('Invalid or empty products')
      setProducts(prods); setPhase('loaded'); setError('')
    } catch (e) { setError('Invalid JSON: ' + e.message) }
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
    const multi = products.filter(p => p.images?.length > 1)
    setProgress({ current: 0, total: multi.length, status: 'Starting...' })

    if (!multi.length) { setError('No products with multiple images.'); setPhase('loaded'); return }

    for (let i = 0; i < multi.length; i++) {
      if (abortRef.current) break
      const product = multi[i]
      setProgress({ current: i + 1, total: multi.length, status: `Analyzing: ${product.title.slice(0, 50)}...` })

      try {
        const variantData = product.variants?.map(v => {
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
  const reset = () => { setProducts([]); setPhase('input'); setResults([]); setProgress({ current: 0, total: 0, status: '' }); setError(''); accRef.current = [] }

  const exportPdf = async () => {
    setExporting(true)
    try {
      const html2pdf = (await import('html2pdf.js')).default
      const el = reportRef.current; if (!el) return
      const storeName = storeUrl ? storeUrl.replace(/https?:\/\//, '').replace(/\..*/,'') : 'store'
      await html2pdf().set({
        margin: 0, filename: `aharoll-audit-${storeName}-${new Date().toISOString().slice(0,10)}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
      }).from(el).save()
    } catch (e) { setError('PDF export failed: ' + e.message) }
    finally { setExporting(false) }
  }

  // Derived
  const sevOrder = ['critical', 'high', 'medium', 'low', 'info', 'none']
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
          {phase === 'results' && actionable.length > 0 && (
            <button onClick={exportPdf} disabled={exporting} style={{ ...btn, background: exporting ? '#27272a' : 'linear-gradient(135deg, #6366f1, #7c3aed)', color: '#fff', fontWeight: 600 }}>
              {exporting ? 'Generating PDF...' : 'Export PDF Report'}
            </button>
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
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: '-0.04em' }}>{products.length}</div>
              <div style={{ color: '#71717a', fontSize: 14 }}>
                products found · <span style={{ color: '#a1a1aa' }}>{products.filter(p => p.images?.length > 1).length} with multiple images</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 6, marginBottom: 28, maxHeight: 340, overflowY: 'auto', padding: 2 }}>
              {products.slice(0, 80).map((p, i) => (
                <a key={i} href={getProductUrl(storeUrl, p.handle)} target="_blank" rel="noopener noreferrer" style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', border: '1px solid #1e1e24', background: '#111', display: 'block', textDecoration: 'none' }}>
                  {p.images?.[0] ? <img src={p.images[0].src} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#52525b' }}>No img</div>}
                  {p.images?.length > 1 && <div style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.75)', borderRadius: 4, padding: '1px 6px', fontSize: 10, color: '#ccc' }}>{p.images.length}</div>}
                </a>
              ))}
            </div>
            <button onClick={analyze} style={{ width: '100%', ...btn, padding: '16px', background: 'linear-gradient(135deg, #6366f1, #7c3aed)', color: '#fff', fontSize: 16, fontWeight: 700 }}>Run Full Audit</button>
            {error && <div style={errorBox}>{error}</div>}
          </div>
        )}

        {/* ANALYZING + RESULTS */}
        {(phase === 'analyzing' || phase === 'results') && (
          <div>
            {phase === 'analyzing' && (
              <div style={{ marginBottom: 32 }}>
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
                    <a key={i} href={getProductUrl(storeUrl, r.product.handle)} target="_blank" rel="noopener noreferrer" style={{ background: '#052e16', border: '1px solid #166534', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#4ade80', textDecoration: 'none' }}>
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
            <PdfReport storeUrl={storeUrl} products={products} issues={sorted} clean={clean} infoOnly={infoOnly} stats={stats} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── ProductCard ──
function ProductCard({ r, storeUrl }) {
  const sev = SEV[r.analysis.severity] || SEV.medium
  const productUrl = getProductUrl(storeUrl, r.product.handle)
  const allIssues = [
    ...(r.analysis.inconsistencies || []).map(i => typeof i === 'string' ? { type: 'other', severity: r.analysis.severity, detail: i } : i),
    ...(r.analysis.seo_issues || []).map(i => ({ ...i, type: 'seo' })),
  ]

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
            {r.product.images?.length} images · {r.product.variants?.length || 0} variants
            {r.analysis.detected_category && <span style={{ color: '#52525b' }}> · {r.analysis.detected_category}</span>}
            {r.product.variants?.length > 1 && (
              <span style={{ color: '#52525b' }}>
                {' '}({r.product.variants.slice(0, 4).map(v => v.title || v.option1).join(', ')}{r.product.variants.length > 4 ? ` +${r.product.variants.length - 4}` : ''})
              </span>
            )}
          </div>
          {productUrl && <a href={productUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#6366f1', textDecoration: 'none' }}>View product →</a>}
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
function PdfReport({ storeUrl, products, issues, clean, infoOnly, stats }) {
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
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>{storeName} · {date} · {products.length} products analyzed</p>
      </div>

      <div style={{ display: 'flex', gap: 12, padding: '24px 48px' }}>
        {[
          { label: 'Critical', n: stats.critical, c: '#dc2626' },
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
          const productUrl = getProductUrl(storeUrl, r.product.handle)
          const allIssues = [
            ...(r.analysis.inconsistencies || []).map(x => typeof x === 'string' ? { type: 'other', severity: r.analysis.severity, detail: x } : x),
            ...(r.analysis.seo_issues || []).map(x => ({ ...x, type: 'seo' })),
          ]

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
                <span key={i} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: '#166534' }}>{r.product.title}</span>
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
