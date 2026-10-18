import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = dirname(dirname(fileURLToPath(import.meta.url)))
const distribution = join(workspace, 'dist-pwa')
const base = new URL('https://diad87.github.io/pletina/')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function filesAt(folder) {
  const paths = []
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, item.name)
    if (item.isDirectory()) paths.push(...await filesAt(path))
    else if (item.isFile()) paths.push(path)
  }
  return paths
}

const pending = await filesAt(distribution)
const files = []
await Promise.all(Array.from({ length: 4 }, async () => {
  while (pending.length) {
    const path = pending.pop()
    const name = relative(distribution, path).split(sep).join('/')
    const expected = hash(await readFile(path))
    try {
      const response = await fetch(new URL(name, base), { cache: 'no-store', signal: AbortSignal.timeout(30000) })
      const actual = hash(Buffer.from(await response.arrayBuffer()))
      files.push({ path: name, status: response.status, contentType: response.headers.get('content-type'), expected, actual,
        pass: response.ok && !response.redirected && expected === actual })
    } catch (error) {
      files.push({ path: name, pass: false, error: error.name })
    }
  }
}))
files.sort((a, b) => a.path.localeCompare(b.path))
const build = (await readFile(join(distribution, 'sw.js'), 'utf8')).match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
if (!build) throw new Error('Falta la versión compilada del worker.')
const report = { testedAt: new Date().toISOString(), build, url: base.href, passed: files.every((file) => file.pass), files }
const output = join(workspace, 'artifacts', 'pwa-deploy', 'public-files.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
await writeFile(join(dirname(output), `public-files-${build}.json`), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ url: report.url, passed: report.passed, checked: files.length,
  failures: files.filter((file) => !file.pass), report: relative(workspace, output) }, null, 2))
if (!report.passed) process.exitCode = 1
