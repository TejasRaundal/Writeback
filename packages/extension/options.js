const $ = (id) => document.getElementById(id)

chrome.storage.sync.get({ port: 7331 }).then(({ port }) => { $('port').value = port })

$('save').onclick = async () => {
  const port = Number($('port').value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    $('ok').textContent = 'Enter a port between 1 and 65535.'
    $('ok').style.color = '#C23838'
    return
  }
  await chrome.storage.sync.set({ port })
  $('ok').textContent = 'Saved — re-open the picker to use it.'
  $('ok').style.color = ''
}
