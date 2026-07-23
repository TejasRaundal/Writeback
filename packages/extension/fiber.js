// MAIN world: the isolated world cannot see __reactFiber$ expandos.
// Picker marks the element with data-wb-sel, we walk the fiber and post names back.
// The picker sends a per-inspect nonce; we echo it so page scripts can't forge a
// wb-fiber reply (component names are display-only, but the trust boundary matters).
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.t !== 'wb-inspect') return
  const nonce = e.data.nonce
  const el = document.querySelector('[data-wb-sel]')
  if (!el) return
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  const components = []
  if (key) {
    let fiber = el[key]
    while (fiber) {
      const t = fiber.type
      const name = typeof t === 'function' ? t.displayName || t.name : null
      if (name) components.push(name)
      fiber = fiber.return
    }
  }
  window.postMessage({ t: 'wb-fiber', nonce, components }, '*')
})
