import { useState, useRef, useCallback } from 'react'

const BATCH_DELAY = 1500

const SEV = {
  none:   { bg: '#052e16', text: '#4ade80', border: '#166534', light: '#f0fdf4', ltext: '#166534', lborder: '#bbf7d0' },
  low:    { bg: '#1a1a0a', text: '#facc15', border: '#854d0e', light: '#fefce8', ltext: '#854d0e', lborder: '#fde68a' },
  medium: { bg: '#1c0f05', text: '#fb923c', border: '#9a3412', light: '#fff7ed', ltext: '#9a3412', lborder: '#fed7aa' },
  high:   { bg: '#1c0505', text: '#f87171', border: '#991b1b', light: '#fef2f2', ltext: '#991b1b', lborder: '#fecaca' },
}

export default function App() {
  const [storeUrl, setStoreUrl] = useState('')
  const [products, setProducts] = useState([])
  const [phase, setPhase] = useState('input') // input | loading | loaded | analyzing | results
  const [results, setResults] = useState([])
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [error, setError] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [exporting, setExporting] = useState(false)
  const abortRef = useRef(false)
  const accRef = useRef([])
  const reportRef = useRef(null)

  // ── Fetch products via server proxy ──
  const fetchProducts = async () => {
    setPhase('loading')
    setError('')
    try {
      const res = await fetch('/api/fetch-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeUrl }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch')
      if (!data.products?.length) throw new Error('No products found at this URL')
      setProducts(data.products)
      setPhase('loaded')
    } catch (e) {
      setError(e.message)
      setShowJson(true)
      setPhase('input')
    }
  }

  const loadJson = () => {
    try {
      const data = JSON.parse(jsonText)
      const prods = data.products || data
      if (!Array.isArray(prods)) throw new Error('Expected { products: [...] }')
      if (!prods.length) throw new Error('Empty products array')
      setProducts(prods)
      setPhase('loaded')
      setError('')
    } catch (e) {
      setError('Invalid JSON: ' + e.message)
    }
  }

  // ── Build variant-to-image mapping ──
  const getVariantImageMap = (product) => {
    if (!product.variants?.length || !product.images?.length) return []
    return product.variants.map(v => {
      const imageIndexes = product.images
        .map((img, idx) => (img.variant_ids?.includes(v.id) ? idx : null))
        .filter(i => i !== null)
      return {
        title: v.title || v.option1 || 'Default',
        imageIndexes: imageIndexes.length ? imageIndexes : undefined,
      }
    }).filter(v => v.title !== 'Default Title' || product.variants.length === 1)
  }

  // ── Run analysis ──
  const analyze = async () => {
    setPhase('analyzing')
    abortRef.current = false
    accRef.current = []

    const multi = products.filter(p => p.images?.length > 1)
    setProgress({ current: 0, total: multi.length, status: 'Analyzing products...' })

    if (!multi.length) {
      setError('No products with multiple images to analyze.')
      setPhase('loaded')
      return
    }

    // Build brand context from first 5 products (quick sample)
    let brandContext = ''
    const sample = multi.slice(0, Math.min(5, multi.length))
    const hasModels = sample.filter(p =>
      p.images?.some(img => img.src?.includes('model') || img.alt?.toLowerCase().includes('model'))
    ).length
    const avgImages = Math.round(sample.reduce((sum, p) => sum + (p.images?.length || 0), 0) / sample.length)
    brandContext = `Most products have ~${avgImages} images. ${hasModels > sample.length / 2 ? 'Most products appear to use model photography.' : 'Mix of model and product-only photography.'}`

    for (let i = 0; i < multi.length; i++) {
      if (abortRef.current) break
      const product = multi[i]
      setProgress({ current: i + 1, total: multi.length, status: `Analyzing: ${product.title.slice(0, 40)}...` })

      try {
        const variants = getVariantImageMap(product)
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: product.title,
            imageUrls: product.images.slice(0, 10).map(img => img.src),
            variants: variants.length > 1 ? variants : undefined,
            brandContext: i > 0 ? brandContext : undefined,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Analysis failed')

        accRef.current = [...accRef.current, { product, analysis: data }]
      } catch (e) {
        accRef.current = [...accRef.current, { product, error: e.message }]
      }

      setResults([...accRef.current])

      if (i < multi.length - 1 && !abortRef.current) {
        await new Promise(r => setTimeout(r, BATCH_DELAY))
      }
    }
    setPhase('results')
  }

  const stop = () => { abortRef.current = true; setPhase('results') }

  const reset = () => {
    setProducts([]); setPhase('input'); setResults([])
    setProgress({ current: 0, total: 0 }); setError('')
    accRef.current = []
  }

  // ── Export PDF ──
  const exportPdf = async () => {
    setExporting(true)
    try {
      const html2pdf = (await import('html2pdf.js')).default
      const el = reportRef.current
      if (!el) return

      const storeName = storeUrl
        ? storeUrl.replace(/https?:\/\//, '').replace(/\..*/,'')
        : 'store'

      await html2pdf()
        .set({
          margin: 0,
          filename: `aharoll-audit-${storeName}-${new Date().toISOString().slice(0,10)}.pdf`,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
        })
        .from(el)
        .save()
    } catch (e) {
      console.error('PDF export error:', e)
      setError('PDF export failed: ' + e.message)
    } finally {
      setExporting(false)
    }
  }

  // ── Derived data ──
  const issues = results.filter(r => r.analysis && r.analysis.severity !== 'none' && !r.error)
  const errors = results.filter(r => r.error)
  const clean = results.filter(r => r.analysis?.severity === 'none')
  const stats = {
    high: issues.filter(r => r.analysis.severity === 'high').length,
    medium: issues.filter(r => r.analysis.severity === 'medium').length,
    low: issues.filter(r => r.analysis.severity === 'low').length,
  }

  const sorted = [...issues].sort((a, b) => {
    const o = { high: 0, medium: 1, low: 2 }
    return (o[a.analysis.severity] ?? 3) - (o[b.analysis.severity] ?? 3)
  })

  // ── Render ──
  return (
    <div style={{ minHeight: '100vh' }}>
      {/* ── HEADER ── */}
      <header style={{
        borderBottom: '1px solid #18181b',
        padding: '16px 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: '#0a0a0b',
        position: 'sticky', top: 0, zIndex: 50,
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 7,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15, fontWeight: 900, color: '#fff',
          }}>A</div>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>
            AhaRoll
          </span>
          <span style={{
            fontSize: 11, color: '#52525b', borderLeft: '1px solid #27272a',
            paddingLeft: 10, marginLeft: 4,
          }}>
            Asset Auditor
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {phase === 'results' && issues.length > 0 && (
            <button onClick={exportPdf} disabled={exporting} style={{
              ...btn, background: exporting ? '#27272a' : 'linear-gradient(135deg, #6366f1, #7c3aed)',
              color: '#fff', fontWeight: 600,
            }}>
              {exporting ? 'Generating PDF...' : 'Export PDF Report'}
            </button>
          )}
          {phase !== 'input' && (
            <button onClick={reset} style={{ ...btn, background: '#18181b', color: '#a1a1aa' }}>
              New Audit
            </button>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px' }}>

        {/* ── INPUT PHASE ── */}
        {phase === 'input' && (
          <div style={{ maxWidth: 560, margin: '80px auto 0' }}>
            <h1 style={{
              fontSize: 36, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1.1,
              marginBottom: 12,
            }}>
              Audit your product<br />imagery consistency
            </h1>
            <p style={{ color: '#71717a', fontSize: 15, marginBottom: 40, lineHeight: 1.6 }}>
              Detect mismatched models, angles, backgrounds, and quality across
              every product in a Shopify store.
            </p>

            {!showJson ? (
              <div>
                <label style={labelStyle}>Shopify store URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    placeholder="brand.myshopify.com or brand.com"
                    value={storeUrl}
                    onChange={e => setStoreUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && storeUrl && fetchProducts()}
                    style={inputStyle}
                  />
                  <button
                    onClick={fetchProducts}
                    disabled={!storeUrl}
                    style={{
                      ...btn, padding: '12px 28px',
                      background: storeUrl ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : '#18181b',
                      color: storeUrl ? '#fff' : '#52525b', fontWeight: 600,
                      cursor: storeUrl ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Fetch
                  </button>
                </div>
                <button onClick={() => setShowJson(true)} style={linkBtn}>
                  Paste products.json manually instead
                </button>
              </div>
            ) : (
              <div>
                <label style={labelStyle}>
                  Paste products.json <span style={{ color: '#52525b' }}>(visit store.com/products.json)</span>
                </label>
                <textarea
                  placeholder='{"products": [...]}'
                  value={jsonText}
                  onChange={e => setJsonText(e.target.value)}
                  style={{ ...inputStyle, height: 180, resize: 'vertical', fontFamily: "'SF Mono', monospace", fontSize: 12 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={loadJson} disabled={!jsonText} style={{
                    ...btn, padding: '10px 24px',
                    background: jsonText ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : '#18181b',
                    color: jsonText ? '#fff' : '#52525b', fontWeight: 600,
                  }}>
                    Load Products
                  </button>
                  <button onClick={() => { setShowJson(false); setError('') }} style={{
                    ...btn, padding: '10px 24px', background: '#18181b', color: '#a1a1aa',
                  }}>
                    Back
                  </button>
                </div>
              </div>
            )}

            {error && <div style={errorBox}>{error}</div>}
          </div>
        )}

        {/* ── LOADING ── */}
        {phase === 'loading' && (
          <div style={{ textAlign: 'center', padding: '120px 0' }}>
            <Spinner />
            <div style={{ color: '#71717a', fontSize: 14, marginTop: 20 }}>
              Fetching products from store...
            </div>
          </div>
        )}

        {/* ── LOADED ── */}
        {phase === 'loaded' && (
          <div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
              marginBottom: 24,
            }}>
              <div>
                <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: '-0.04em' }}>
                  {products.length}
                </div>
                <div style={{ color: '#71717a', fontSize: 14 }}>
                  products found &middot;{' '}
                  <span style={{ color: '#a1a1aa' }}>
                    {products.filter(p => p.images?.length > 1).length} with multiple images
                  </span>
                </div>
              </div>
            </div>

            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
              gap: 6, marginBottom: 28, maxHeight: 340, overflowY: 'auto',
              padding: 2,
            }}>
              {products.slice(0, 80).map((p, i) => (
                <div key={i} style={{
                  position: 'relative', aspectRatio: '1', borderRadius: 8,
                  overflow: 'hidden', border: '1px solid #1e1e24', background: '#111',
                }}>
                  {p.images?.[0] ? (
                    <img src={p.images[0].src} alt="" loading="lazy" style={{
                      width: '100%', height: '100%', objectFit: 'cover',
                    }} />
                  ) : (
                    <div style={{
                      width: '100%', height: '100%', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, color: '#52525b',
                    }}>No img</div>
                  )}
                  {p.images?.length > 1 && (
                    <div style={{
                      position: 'absolute', top: 4, right: 4,
                      background: 'rgba(0,0,0,0.75)', borderRadius: 4,
                      padding: '1px 6px', fontSize: 10, color: '#ccc',
                    }}>{p.images.length}</div>
                  )}
                </div>
              ))}
            </div>

            <button onClick={analyze} style={{
              width: '100%', ...btn, padding: '16px',
              background: 'linear-gradient(135deg, #6366f1, #7c3aed)',
              color: '#fff', fontSize: 16, fontWeight: 700,
            }}>
              Run Consistency Audit
            </button>
            {error && <div style={errorBox}>{error}</div>}
          </div>
        )}

        {/* ── ANALYZING + RESULTS ── */}
        {(phase === 'analyzing' || phase === 'results') && (
          <div>
            {phase === 'analyzing' && (
              <div style={{ marginBottom: 32 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#a1a1aa', marginBottom: 8 }}>
                  <span>{progress.status || `Analyzing ${progress.current} of ${progress.total}`}</span>
                  <span>{Math.round((progress.current / progress.total) * 100)}%</span>
                </div>
                <div style={{ height: 4, background: '#1e1e24', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${(progress.current / progress.total) * 100}%`,
                    background: 'linear-gradient(90deg, #6366f1, #a78bfa)',
                    borderRadius: 2, transition: 'width 0.4s ease',
                  }} />
                </div>
                <button onClick={stop} style={{
                  ...btn, marginTop: 10, background: '#18181b', color: '#f87171', fontSize: 12,
                }}>Stop</button>
              </div>
            )}

            {/* Stats */}
            {results.length > 0 && (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 10, marginBottom: 24,
              }}>
                {[
                  { label: 'High', n: stats.high, c: '#f87171' },
                  { label: 'Medium', n: stats.medium, c: '#fb923c' },
                  { label: 'Low', n: stats.low, c: '#facc15' },
                  { label: 'Clean', n: clean.length, c: '#4ade80' },
                ].map(s => (
                  <div key={s.label} style={{
                    background: '#111114', border: '1px solid #1e1e24',
                    borderRadius: 10, padding: '14px 12px', textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: s.c, letterSpacing: '-0.03em' }}>
                      {s.n}
                    </div>
                    <div style={{ fontSize: 11, color: '#71717a', marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Issue cards */}
            {sorted.length > 0 && (
              <div style={{ marginBottom: 32 }}>
                <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 16 }}>
                  Inconsistencies Found
                </h3>
                {sorted.map((r, i) => <ProductCard key={i} r={r} />)}
              </div>
            )}

            {/* Errors */}
            {errors.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <h4 style={{ fontSize: 13, color: '#71717a', marginBottom: 8 }}>
                  Failed ({errors.length})
                </h4>
                {errors.map((r, i) => (
                  <div key={i} style={{
                    background: '#111', border: '1px solid #1e1e24', borderRadius: 8,
                    padding: '8px 14px', marginBottom: 4, fontSize: 12, color: '#71717a',
                  }}>
                    {r.product.title}: {r.error}
                  </div>
                ))}
              </div>
            )}

            {/* Clean */}
            {phase === 'results' && clean.length > 0 && (
              <div>
                <h4 style={{ fontSize: 13, color: '#4ade80', fontWeight: 600, marginBottom: 8 }}>
                  Consistent ({clean.length})
                </h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {clean.map((r, i) => (
                    <span key={i} style={{
                      background: '#052e16', border: '1px solid #166534',
                      borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#4ade80',
                    }}>{r.product.title}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── HIDDEN PDF REPORT (rendered off-screen, used by html2pdf) ── */}
      {results.length > 0 && (
        <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
          <div ref={reportRef} style={{
            width: '794px', background: '#fff', color: '#111',
            fontFamily: "'Inter', sans-serif", fontSize: '13px',
          }}>
            <PdfReport
              storeUrl={storeUrl}
              products={products}
              issues={sorted}
              clean={clean}
              stats={stats}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Product Card Component ──
const ISSUE_LABELS = {
  variant_coverage: { icon: '🎨', label: 'Variant Gap' },
  missing_angles: { icon: '📐', label: 'Missing Angle' },
  style_mismatch: { icon: '🎭', label: 'Style Mismatch' },
  quality_mismatch: { icon: '📸', label: 'Quality Gap' },
  no_model: { icon: '🚫', label: 'No Model' },
  model_inconsistency: { icon: '👤', label: 'Model Inconsistency' },
  brand_deviation: { icon: '⚠️', label: 'Brand Deviation' },
}

function ProductCard({ r }) {
  const sev = SEV[r.analysis.severity] || SEV.low
  const inconsistencies = (r.analysis.inconsistencies || []).map(i =>
    typeof i === 'string' ? { type: 'other', detail: i } : i
  )

  return (
    <div style={{
      background: sev.bg, border: `1px solid ${sev.border}`,
      borderRadius: 12, padding: 20, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{r.product.title}</div>
          <div style={{ fontSize: 12, color: '#71717a', marginTop: 2 }}>
            {r.product.images?.length} images &middot; {r.product.variants?.length || 0} variants
            {r.product.variants?.length > 1 && (
              <span style={{ color: '#52525b' }}>
                {' '}({r.product.variants.slice(0, 4).map(v => v.title || v.option1).join(', ')}
                {r.product.variants.length > 4 ? ` +${r.product.variants.length - 4}` : ''})
              </span>
            )}
          </div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.06em', color: sev.text,
          background: `${sev.text}20`, padding: '3px 8px', borderRadius: 4,
          height: 'fit-content',
        }}>{r.analysis.severity}</span>
      </div>

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 14, paddingBottom: 4 }}>
        {r.product.images?.slice(0, 10).map((img, idx) => {
          const a = r.analysis.images?.find(x => x.index === idx)
          return (
            <div key={idx} style={{ flexShrink: 0, textAlign: 'center' }}>
              <img src={img.src} alt="" loading="lazy" style={{
                width: 72, height: 72, objectFit: 'cover', borderRadius: 8,
                border: `2px solid ${sev.border}`,
              }} />
              {a && (
                <div style={{ fontSize: 9, color: '#71717a', marginTop: 3, lineHeight: 1.3, maxWidth: 72 }}>
                  {a.has_model ? '👤' : '📦'} {a.angle}
                  {a.variant_guess && <><br /><span style={{ color: '#52525b' }}>{a.variant_guess}</span></>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ fontSize: 13, color: '#a1a1aa', fontStyle: 'italic', marginBottom: 12 }}>
        {r.analysis.summary}
      </div>

      {inconsistencies.map((issue, j) => {
        const meta = ISSUE_LABELS[issue.type] || { icon: '▸', label: issue.type || 'Issue' }
        return (
          <div key={j} style={{
            display: 'flex', gap: 8, fontSize: 13, color: sev.text, marginBottom: 6,
            alignItems: 'flex-start',
          }}>
            <span style={{ flexShrink: 0, fontSize: 11 }}>{meta.icon}</span>
            <div>
              <span style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.04em', opacity: 0.7, marginRight: 6,
              }}>{meta.label}</span>
              <span style={{ color: '#d4d4d8' }}>{issue.detail}</span>
            </div>
          </div>
        )
      })}

      {r.analysis.missing?.length > 0 && (
        <div style={{
          marginTop: 10, padding: '8px 12px',
          background: `${sev.text}10`, borderRadius: 6,
          fontSize: 12, color: sev.text,
        }}>
          <span style={{ fontWeight: 600 }}>Missing: </span>
          {r.analysis.missing.join(' · ')}
        </div>
      )}
    </div>
  )
}

// ── PDF Report Component (light theme, rendered to PDF) ──
function PdfReport({ storeUrl, products, issues, clean, stats }) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const storeName = storeUrl ? storeUrl.replace(/https?:\/\//, '').replace(/\/.*/, '') : 'Store'

  return (
    <div>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(135deg, #1e1b4b, #312e81)',
        padding: '40px 48px', color: '#fff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 900,
          }}>A</div>
          <span style={{ fontWeight: 700, fontSize: 14 }}>AhaRoll</span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', margin: 0 }}>
          Asset Consistency Report
        </h1>
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
          {storeName} &middot; {date} &middot; {products.length} products analyzed
        </p>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, padding: '24px 48px' }}>
        {[
          { label: 'High Severity', n: stats.high, c: '#dc2626' },
          { label: 'Medium', n: stats.medium, c: '#ea580c' },
          { label: 'Low', n: stats.low, c: '#ca8a04' },
          { label: 'Consistent', n: clean.length, c: '#16a34a' },
        ].map(s => (
          <div key={s.label} style={{
            flex: 1, border: '1px solid #e5e7eb', borderRadius: 10,
            padding: '16px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: s.c }}>{s.n}</div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Issues */}
      <div style={{ padding: '8px 48px 40px' }}>
        {issues.length > 0 && (
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
            Inconsistencies Found ({issues.length})
          </h2>
        )}

        {issues.map((r, i) => {
          const sev = SEV[r.analysis.severity] || SEV.low
          return (
            <div key={i} style={{
              background: sev.light, border: `1px solid ${sev.lborder}`,
              borderRadius: 10, padding: 20, marginBottom: 12,
              pageBreakInside: 'avoid',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111' }}>{r.product.title}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {r.product.images?.length} images &middot; {r.product.variants?.length || 0} variants
                  </div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.06em', color: sev.ltext,
                  background: sev.lborder, padding: '3px 10px', borderRadius: 5,
                  height: 'fit-content',
                }}>{r.analysis.severity}</span>
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                {r.product.images?.slice(0, 8).map((img, idx) => {
                  const a = r.analysis.images?.find(x => x.index === idx)
                  return (
                    <div key={idx} style={{ textAlign: 'center' }}>
                      <img src={img.src} alt="" style={{
                        width: 72, height: 72, objectFit: 'cover', borderRadius: 6,
                        border: `2px solid ${sev.lborder}`,
                      }} crossOrigin="anonymous" />
                      {a && (
                        <div style={{ fontSize: 8, color: '#888', marginTop: 2 }}>
                          {a.has_model ? 'Model' : 'No model'} / {a.angle}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic', marginBottom: 8 }}>
                {r.analysis.summary}
              </div>

              {r.analysis.inconsistencies?.map((issue, j) => {
                const item = typeof issue === 'string' ? { type: 'other', detail: issue } : issue
                const meta = { variant_coverage: 'Variant Gap', missing_angles: 'Missing Angle', style_mismatch: 'Style Mismatch', quality_mismatch: 'Quality Gap', no_model: 'No Model', model_inconsistency: 'Model Issue', brand_deviation: 'Brand Deviation' }
                return (
                  <div key={j} style={{
                    display: 'flex', gap: 6, fontSize: 12, color: sev.ltext, marginBottom: 4,
                  }}>
                    <span>&#9656;</span>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 10, textTransform: 'uppercase', marginRight: 4 }}>{meta[item.type] || item.type || 'Issue'}</span>
                      <span style={{ color: '#333' }}>{item.detail}</span>
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

        {clean.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#16a34a', marginBottom: 8 }}>
              Consistent Products ({clean.length})
            </h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {clean.map((r, i) => (
                <span key={i} style={{
                  background: '#f0fdf4', border: '1px solid #bbf7d0',
                  borderRadius: 6, padding: '4px 10px', fontSize: 11, color: '#166534',
                }}>{r.product.title}</span>
              ))}
            </div>
          </div>
        )}

        <div style={{
          marginTop: 40, paddingTop: 20, borderTop: '1px solid #e5e7eb',
          textAlign: 'center', fontSize: 11, color: '#aaa',
        }}>
          Generated by AhaRoll &middot; aharoll.com
        </div>
      </div>
    </div>
  )
}

// ── Spinner ──
function Spinner() {
  return (
    <>
      <div style={{
        width: 36, height: 36,
        border: '3px solid #27272a', borderTop: '3px solid #6366f1',
        borderRadius: '50%', animation: 'spin 0.7s linear infinite',
        margin: '0 auto',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )
}

// ── Shared styles ──
const btn = {
  border: 'none', borderRadius: 8, cursor: 'pointer',
  fontSize: 13, padding: '8px 16px', transition: 'opacity 0.15s',
}
const inputStyle = {
  flex: 1, background: '#111114', border: '1px solid #27272a',
  borderRadius: 8, padding: '12px 16px', color: '#e4e4e7',
  fontSize: 14, outline: 'none', width: '100%',
}
const labelStyle = { fontSize: 13, color: '#a1a1aa', display: 'block', marginBottom: 8 }
const linkBtn = {
  background: 'none', border: 'none', color: '#6366f1',
  fontSize: 12, cursor: 'pointer', marginTop: 14, padding: 0,
}
const errorBox = {
  marginTop: 14, padding: '10px 14px',
  background: '#1c0f05', border: '1px solid #9a3412',
  borderRadius: 8, color: '#fb923c', fontSize: 13,
}
