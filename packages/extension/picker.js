// Resolved from the extension's options before the picker can activate (see bridgeUp).
// ponytail: read once per activation, not watched — change the port, then re-toggle.
let BRIDGE = 'http://127.0.0.1:7331'
let active = false
let panel = null
let hoverBox = null
let selBox = null
let selected = null // { el, loc }
let drift = false
let previewSaved = null // { el, props: {name: originalValue} }

// Dormant unless the bridge answers /health
async function bridgeUp() {
  try {
    const { port } = await chrome.storage.sync.get({ port: 7331 })
    BRIDGE = 'http://127.0.0.1:' + port
  } catch {
    // storage unavailable — keep the default port
  }
  try {
    const r = await fetch(BRIDGE + '/health')
    return (await r.json()).writeback === true
  } catch {
    return false
  }
}

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.t !== 'wb-toggle') return
  if (!active && !(await bridgeUp())) return
  active = !active
  if (!active) teardown()
})

function teardown() {
  hoverBox?.remove()
  selBox?.remove()
  hoverLabel?.remove()
  panel?.remove()
  hoverBox = selBox = hoverLabel = panel = selected = null
  clearPreview()
  setDrift(false)
}

function deselect() {
  selected = null
  clearPreview()
  if (selBox) selBox.style.display = 'none'
  panel?.contentWindow.postMessage({ t: 'wb-deselect' }, BRIDGE)
}

function mkBox(color, dash) {
  const d = document.createElement('div')
  d.style.cssText =
    `position:fixed;pointer-events:none;z-index:2147483646;border:1.5px ${dash ? 'dashed' : 'solid'} ${color};border-radius:3px;display:none;`
  document.documentElement.appendChild(d)
  return d
}

function place(box, el) {
  const r = el.getBoundingClientRect()
  box.style.display = 'block'
  box.style.left = r.left - 2 + 'px'
  box.style.top = r.top - 2 + 'px'
  box.style.width = r.width + 2 + 'px'
  box.style.height = r.height + 2 + 'px'
  return r
}

// floating label on the hover outline: tag + live dimensions, like DevTools/Figma
let hoverLabel = null
function showLabel(el, r) {
  if (!hoverLabel) {
    hoverLabel = document.createElement('div')
    hoverLabel.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;background:#0d9488;color:#fff;font:11px/1.4 ui-monospace,Consolas,monospace;padding:1px 6px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3);'
    document.documentElement.appendChild(hoverLabel)
  }
  hoverLabel.textContent = `${el.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`
  hoverLabel.style.display = 'block'
  // flip below the box when there's no room above
  const below = r.top < 22
  hoverLabel.style.left = r.left - 2 + 'px'
  hoverLabel.style.top = (below ? r.bottom + 4 : r.top - 20) + 'px'
}
function hideLabel() { if (hoverLabel) hoverLabel.style.display = 'none' }

function ensurePanel() {
  if (!panel) {
    panel = document.createElement('iframe')
    panel.src = BRIDGE + '/panel'
    panel.style.cssText =
      'position:fixed;top:10px;right:10px;width:352px;height:calc(100vh - 20px);z-index:2147483647;border:1px solid rgba(120,120,130,.35);border-radius:10px;background:#fbfbfa;box-shadow:0 4px 24px rgba(15,18,26,.18);color-scheme:light dark;'
    document.documentElement.appendChild(panel)
  }
  return panel
}

// ── drift radar: outline every off-scale (arbitrary-value) token in amber ──
const DRIFT_RE = /(^|\s|:)-?[\w-]+-\[[^\]]+\]/
let driftObserver = null
function markDrift() {
  let n = 0
  document.querySelectorAll('[data-wb-drift]').forEach((el) => el.removeAttribute('data-wb-drift'))
  document.querySelectorAll('[class]').forEach((el) => {
    const cls = typeof el.className === 'string' ? el.className : ''
    if (DRIFT_RE.test(cls)) { el.setAttribute('data-wb-drift', ''); n++ }
  })
  panel?.contentWindow.postMessage({ t: 'wb-drift-state', on: drift, count: n }, BRIDGE)
}
function setDrift(on) {
  drift = on
  if (!document.getElementById('wb-drift-style')) {
    const s = document.createElement('style')
    s.id = 'wb-drift-style'
    s.textContent = '[data-wb-drift]{outline:1.5px dashed #f59e0b !important;outline-offset:1px;}'
    document.documentElement.appendChild(s)
  }
  if (!on) {
    driftObserver?.disconnect(); driftObserver = null
    document.querySelectorAll('[data-wb-drift]').forEach((el) => el.removeAttribute('data-wb-drift'))
    panel?.contentWindow.postMessage({ t: 'wb-drift-state', on: false, count: 0 }, BRIDGE)
    return
  }
  markDrift()
  // ponytail: full re-scan per mutation batch so HMR edits / re-renders / route
  // changes stay flagged (the radar was a stale one-shot before). Scope to changed
  // subtrees if this ever gets slow. attributeFilter:['class'] avoids self-retrigger.
  driftObserver = new MutationObserver(() => markDrift())
  driftObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
}

document.addEventListener('mousemove', (e) => {
  if (!active) return
  if (panel && (e.target === panel || panel.contains(e.target))) return
  const el = e.target.closest?.('[data-wb]')
  if (!hoverBox) hoverBox = mkBox('#2dd4bf66')
  if (el && el !== selected?.el) { showLabel(el, place(hoverBox, el)) }
  else { hoverBox.style.display = 'none'; hideLabel() }
}, true)

// selection outline must track the element through scroll, resize, and HMR swaps
function refreshSelBox() {
  if (!selected) return
  if (!selected.el.isConnected) {
    // HMR replaced the node — find its successor by stamp
    const again = document.querySelector(`[data-wb="${selected.stamp}"]`)
    if (again) selected.el = again
    else { selBox.style.display = 'none'; return }
  }
  place(selBox, selected.el)
}
addEventListener('scroll', () => { if (hoverBox) hoverBox.style.display = 'none'; hideLabel(); refreshSelBox() }, true)
addEventListener('resize', () => refreshSelBox(), true)
setInterval(() => refreshSelBox(), 500) // ponytail: covers HMR/layout shifts; MutationObserver if it ever flickers

document.addEventListener('click', (e) => {
  if (!active) return
  if (panel && (e.target === panel || panel.contains(e.target))) return
  const el = e.target.closest?.('[data-wb]')
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  clearPreview()

  // data-wb = "rel/path.tsx:line:col" — split from the right
  const stamp = el.getAttribute('data-wb')
  const parts = stamp.split(':')
  const col = Number(parts.pop())
  const line = Number(parts.pop())
  const loc = { file: parts.join(':'), line, col }
  selected = { el, loc, stamp }
  if (!selBox) selBox = mkBox('#0d9488')
  place(selBox, el)
  if (hoverBox) hoverBox.style.display = 'none'

  // computed styles: the panel greys these out as "current value" where nothing is set
  const cs = getComputedStyle(el)
  const uniform = (a, b, c, d) => (cs[a] === cs[b] && cs[a] === cs[c] && cs[a] === cs[d] ? cs[a] : 'mixed')
  const computed = {
    p: uniform('paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'),
    px: cs.paddingLeft, py: cs.paddingTop,
    m: uniform('marginTop', 'marginRight', 'marginBottom', 'marginLeft'),
    gap: cs.gap,
    'text-size': cs.fontSize,
    'font-weight': cs.fontWeight,
    'font-family': cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
    tracking: cs.letterSpacing,
    leading: cs.lineHeight,
    rounded: cs.borderRadius,
    shadow: cs.boxShadow === 'none' ? 'none' : 'set',
    opacity: String(Math.round(parseFloat(cs.opacity) * 100)),
    text: cs.color,
    bg: cs.backgroundColor,
  }

  // fiber names come from the MAIN world; a per-inspect nonce rejects forged replies
  el.setAttribute('data-wb-sel', '')
  const nonce = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random())
  const shift = e.shiftKey
  const onFiber = (ev) => {
    if (ev.source !== window || ev.data?.t !== 'wb-fiber' || ev.data.nonce !== nonce) return
    window.removeEventListener('message', onFiber)
    el.removeAttribute('data-wb-sel')
    ensurePanel().contentWindow.postMessage(
      { t: 'wb-select', loc, components: ev.data.components, add: shift, computed },
      BRIDGE,
    )
  }
  window.addEventListener('message', onFiber)
  window.postMessage({ t: 'wb-inspect', nonce }, '*')
}, true)

// ── hover preview from the panel: see the change before committing ──
function clearPreview() {
  if (!previewSaved) return
  for (const [k, v] of Object.entries(previewSaved.props)) previewSaved.el.style[k] = v
  if (previewSaved.text !== undefined) previewSaved.el.textContent = previewSaved.text
  previewSaved = null
}
window.addEventListener('message', (ev) => {
  if (ev.origin !== BRIDGE) return
  const d = ev.data
  if (d?.t === 'wb-preview' && selected?.el) {
    clearPreview()
    previewSaved = { el: selected.el, props: {} }
    for (const [k, v] of Object.entries(d.style)) {
      previewSaved.props[k] = selected.el.style[k]
      selected.el.style[k] = v
    }
    // staged text edit — the panel only sends this for single-text-child elements
    if (d.text != null) {
      previewSaved.text = selected.el.textContent
      selected.el.textContent = d.text
    }
  }
  if (d?.t === 'wb-preview-clear') clearPreview()
  if (d?.t === 'wb-drift-toggle') setDrift(!drift) // setDrift echoes wb-drift-state
})

// ── keyboard nudging: arrows step spacing on the selected element ──
// plain = padding, Alt = margin, Shift = gap; 'd' toggles the drift radar
document.addEventListener('keydown', (e) => {
  if (!active) return
  if (e.key === 'Escape') {
    // first Escape clears the selection; a second exits inspect mode entirely
    if (selected) deselect()
    else { active = false; teardown() }
    return
  }
  if (e.key === 'd' && !e.altKey && !e.ctrlKey && e.target === document.body) {
    setDrift(!drift) // setDrift echoes wb-drift-state
    return
  }
  if (!selected || !panel) return
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  e.preventDefault()
  const group = e.altKey ? 'm' : e.shiftKey ? 'gap' : 'p'
  panel.contentWindow.postMessage(
    { t: 'wb-nudge', group, dir: e.key === 'ArrowUp' ? 1 : -1 },
    BRIDGE,
  )
}, true)
