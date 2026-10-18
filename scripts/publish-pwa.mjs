import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = join(workspace, 'dist-pwa')
const statePath = join(workspace, 'artifacts', 'pwa-deploy', 'state.json')
const legacyState = join(workspace, 'artifacts', 'pwa-screen-off', 'deployment.json')
const repository = 'diad87/pletina'
const prefix = 'repos/' + repository
const branch = 'gh-pages'
const extensions = new Set(['.html', '.js', '.css', '.woff2', '.png', '.webmanifest'])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function api(method, endpoint, body) {
  const args = ['api', '--method', method, endpoint]
  if (body !== undefined) args.push('--input', '-')
  const output = execFileSync('gh', args, { encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'] })
  return output.trim() ? JSON.parse(output) : null
}

async function filesAt(folder, base = folder) {
  const files = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) files.push(...await filesAt(path, base))
    else if (entry.isFile()) files.push({ name: relative(base, path).split(sep).join('/'), bytes: await readFile(path) })
  }
  return files
}

const files = (await filesAt(directory)).sort((a, b) => a.name.localeCompare(b.name))
if (!files.some((file) => /^application\/index\.[a-f0-9]{16}\.html$/.test(file.name))) throw new Error('Falta el port completo; ejecuta npm run build:pwa.')
for (const file of files) {
  if (file.name !== '.nojekyll' && (!extensions.has(extname(file.name)) || file.name.split('/').some((part) => part.startsWith('.')))) {
    throw new Error('Archivo inesperado en la distribución: ' + file.name)
  }
}
const fingerprint = createHash('sha256')
for (const file of files) fingerprint.update(file.name).update(file.bytes)
const sourceHash = fingerprint.digest('hex')
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ repository, branch, files: files.map((file) => file.name), bytes: files.reduce((sum, file) => sum + file.bytes.length, 0), sourceHash }, null, 2))
} else {
  let saved
  try { saved = JSON.parse(await readFile(statePath, 'utf8')) }
  catch { saved = JSON.parse(await readFile(legacyState, 'utf8')) }
  const reference = api('GET', `${prefix}/git/ref/heads/${branch}`)
  if (reference.object.sha !== saved.commit) throw new Error('La rama de publicación tiene cambios ajenos a esta tarea; no se sustituirá.')
  const pages = api('GET', `${prefix}/pages`)
  if (pages.build_type !== 'legacy' || pages.source?.branch !== branch || pages.source?.path !== '/') throw new Error('La configuración de Pages ha cambiado.')
  if (saved.source_hash !== sourceHash) {
    const binaries = new Map()
    const entries = []
    for (const file of files) {
      const entry = { path: file.name, mode: '100644', type: 'blob' }
      if (['.png', '.woff2'].includes(extname(file.name))) {
        const digest = sha(file.bytes)
        if (!binaries.has(digest)) binaries.set(digest, api('POST', `${prefix}/git/blobs`, { content: file.bytes.toString('base64'), encoding: 'base64' }).sha)
        entry.sha = binaries.get(digest)
      } else entry.content = file.bytes.toString('utf8')
      entries.push(entry)
    }
    const tree = api('POST', `${prefix}/git/trees`, { tree: entries })
    const commit = api('POST', `${prefix}/git/commits`, { message: 'Port Pletina 0.11.2 to a static PWA with direct search and playback', tree: tree.sha, parents: [reference.object.sha] })
    api('PATCH', `${prefix}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
    saved = { repository, branch, commit: commit.sha, tree: tree.sha, source_hash: sourceHash }
  }
  saved.url = pages.html_url
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(saved, null, 2) + '\n')
  console.log(JSON.stringify(saved, null, 2))
}
