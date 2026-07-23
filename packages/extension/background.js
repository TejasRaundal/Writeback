chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return
  // no receiver on non-localhost pages or tabs loaded before the extension — both fine
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(tab.url ?? '')) return
  chrome.tabs.sendMessage(tab.id, { t: 'wb-toggle' }).catch(() => {})
})
