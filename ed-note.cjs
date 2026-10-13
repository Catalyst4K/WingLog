const fs = require('fs')
function edit(file, fn) {
  let s = fs.readFileSync(file, 'utf8')
  const nl = s.includes('\r\n') ? '\r\n' : '\n'
  s = s.replace(/\r\n/g, '\n')
  s = fn(s)
  fs.writeFileSync(file, s.replace(/\n/g, nl))
}
function rep(s, a, b) {
  if (!s.includes(a)) throw new Error('not found: ' + a.slice(0, 80))
  return s.replace(a, () => b)
}
edit('src/renderer/src/settings/LanCard.tsx', (s) =>
  rep(s, "note={status.pairing ? t('lan.settings.pairingNote') : t('lan.settings.pairingHidden')}", "note={status.pairing ? t('lan.settings.pairingNote') : undefined}")
)
edit('src/renderer/src/settings/LanCard.test.tsx', (s) => {
  const i = s.indexOf("    expect(screen.getByText('The QR code and pairing code stay hidden until you ask for them.')")
  if (i < 0) throw new Error('test line')
  const end = s.indexOf('\n', s.indexOf(').toBeInTheDocument()', i)) + 1
  return s.slice(0, i) + s.slice(end)
})
for (const locale of ['en', 'de', 'es', 'fr', 'it', 'ru', 'zh-CN', 'zh-TW']) {
  const file = `src/renderer/src/locales/${locale}/common.json`
  const raw = fs.readFileSync(file, 'utf8')
  const json = JSON.parse(raw)
  delete json.lan.settings.pairingHidden
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + (raw.endsWith('\n') ? '\n' : ''))
}
