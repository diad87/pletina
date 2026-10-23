// Assemble only metadata evidence, validate frozen probe sources and audit this
// task's small text artifacts for accidental credential/media persistence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
const root = new URL('../../', import.meta.url), directory = new URL('artifacts/pwa-port/', root)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const p1Commit = '0aa9e1c1ad21a6b66924c18af41aab2d78533cf7'
const reports = ['p1-alternative-session-2026-10-23.json', 'p1-alternative-config-player-2026-10-23.json', 'p1-alternative-config-shape-final-2026-10-23.json']
const evidence = []
for (const name of reports) {
  const bytes = await readFile(new URL(name, directory)), report = JSON.parse(bytes)
  if (report.execution?.sourceSnapshot) assert.equal(hash(await readFile(new URL(report.execution.sourceSnapshot, root))), report.execution.scriptSha256)
  else {
    const script = await readFile(new URL('scripts/tests/p1-alternative-session.browser.mjs', root))
    assert.equal(hash(script), report.scriptSha256)
    const snapshot = `p1-alternative-session-source-${report.scriptSha256.slice(0, 16)}.mjs`
    await writeFile(new URL(snapshot, directory), script)
  }
  assert.deepEqual(report.errors, [])
  evidence.push({ path: 'artifacts/pwa-port/' + name, sha256: hash(bytes), testedAt: report.testedAt })
}
const artifactNames = (await readdir(directory)).filter(name => name.startsWith('p1-alternative-'))
const audit = { checkedFiles: artifactNames.length, credentialPatternFindings: 0, rawContextValueFindings: 0, signedMediaUrlFindings: 0, nonTextFiles: 0 }
const checkContext = value => {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:visitorData|poToken|encryptedHostFlags|coldConfigData|coldHashData|hotHashData|configData|clientKey|encryptedClientKey)$/.test(key) && typeof child === 'string' && child.length > 0) audit.rawContextValueFindings++
    if (child && typeof child === 'object') checkContext(child)
  }
}
for (const name of artifactNames) {
  if (!/\.(?:json|mjs)$/.test(name)) audit.nonTextFiles++
  const text = await readFile(new URL(name, directory), 'utf8')
  audit.credentialPatternFindings += (text.match(/AIza[0-9A-Za-z_-]{30,}/g) ?? []).length
  audit.signedMediaUrlFindings += (text.match(/https?:\/\/[^\s"'<>]*\.googlevideo\.com\/[^\s"'<>]*/g) ?? []).length
  if (name.endsWith('.json')) checkContext(JSON.parse(text))
}
assert.equal(audit.credentialPatternFindings + audit.rawContextValueFindings + audit.signedMediaUrlFindings + audit.nonTextFiles, 0)
const p1Files = ['src-tauri/src/native_embedded.rs', 'src-tauri/src/youtube-decoder.js']
const result = {
  schemaVersion: 1, assembledAt: new Date().toISOString(), evidence,
  fixedP1: { commit: p1Commit, sourceFiles: p1Files.map(path => ({ path, sha256: hash(execFileSync('git', ['show', `${p1Commit}:${path}`], { cwd: 'C:/Users/iunan/musify-oficial', maxBuffer: 8 * 1024 * 1024 })) })),
    changes: ['Gzip on public text with decoded-byte ceiling', 'Delay speculative player POST until exact watch identity and explicit child-notice admission',
      'Lazy dependency analysis pinned to youtubei.js18.1 private analyzer state', 'Skip expired CDN retry slots and stop immediately on HTTP429', 'Additional bounded-stage timings'],
    portableScope: 'Lazy JS dependency analysis and bounded cancellation/retry design may transfer with pinned-version equivalence tests. Browser fetch already handles compression. This commit adds no browser-readable bootstrap, format, CORS permission or SABR transport.' },
  browserFindings: {
    swJsData: 'HTTP200 but MissingAllowOriginHeader from ordinary Pages and opaque frame; not readable.',
    config: 'Ordinary Pages POST gets403 and no ACAO. Opaque same endpoint succeeds200 without keys, visitor seed, credentials or custom headers. WEB provides own visitor and configInfo; embedded provides own visitor/configData but no configInfo fields.',
    playbackMetadata: 'Epoitaitaye DJzjkMBMook, Maite WtTRMAoN2Fw and control gpfVjKXVnDc: WEB with/without configInfo all OK with exact IDs and SABR-only metadata. Embedded using its own config visitor errors with zero audio for all three.',
    opaqueDataLimit: 'globalConfig was empty. Encoded config blobs were inspected for size/markers only, not assigned undocumented protobuf semantics. Absence of a plaintext marker is not proof that arbitrary binary fields lack related information.',
    noPlaybackClaim: 'No provider media was requested, no decoding or playback was attempted, and no mobile or physical lock-screen claim is made.' },
  primaryImplementations: [
    { url: 'https://github.com/LuanRT/YouTube.js/blob/204715b6acfb063dc306d8677e36fdbf09f293c5/src/core/Session.ts', finding: 'Documents sw.js_data session bootstrap and /config mapping used in this browser experiment.' },
    { url: 'https://github.com/LuanRT/YouTube.js/blob/204715b6acfb063dc306d8677e36fdbf09f293c5/src/utils/HTTPClient.ts', finding: 'Removes configInfo when changing from WEB to another client; WEB config fields were not transplanted into embedded.' },
    { url: 'https://github.com/LuanRT/googlevideo/blob/35b2b4e511030da265da2976a6d3009121fc094a/examples/sabr-shaka-example/src/main.ts', finding: 'The primary browser SABR example requires its ytc-bridge extension. It is not a pure-PWA recipe under this task constraints.' },
    { url: 'https://github.com/LuanRT/googlevideo/blob/35b2b4e511030da265da2976a6d3009121fc094a/examples/onesie-request/main.ts', finding: 'Onesie example requires separate TV player configuration and embedded encryption material; readable /config fields do not establish that mapping. No key or Onesie request was attempted.' },
  ],
  previousSabrControlNotRepeated: ['artifacts/pwa-port/provider-web-sabr-browser-network-2026-10-22.json', 'artifacts/pwa-port/provider-android-sabr-browser-network-2026-10-22.json'],
  conclusion: 'A new anonymous browser-readable config bootstrap is demonstrated. It does not resolve embedded playback or supply direct audio. No further high-probability pure-PWA SABR/Onesie route was supported by the inspected primary implementations; stop instead of repeating blocked transport or importing tokens/extensions.',
  audit, productChanged: false, built: false, deployed: false
}
await writeFile(new URL('p1-alternative-review-2026-10-23.json', directory), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ evidence: result.evidence, fixedP1: result.fixedP1.commit, audit, conclusion: result.conclusion }, null, 2))
