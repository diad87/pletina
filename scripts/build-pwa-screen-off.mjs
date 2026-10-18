import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('../', import.meta.url))
export const sourceDirectory = join(workspace, 'experiments', 'screen-off')
export const outputDirectory = join(workspace, 'dist-pwa', 'prueba-audio')

function contains(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))
}

async function readTree(directory, base = directory) {
  const files = new Map()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const item of await readTree(path, base)) files.set(...item)
    } else if (entry.isFile() && entry.name !== 'README.md') {
      files.set(relative(base, path).split(sep).join('/'), await readFile(path))
    }
  }
  return files
}

export async function buildScreenOff({ source = sourceDirectory, output = outputDirectory } = {}) {
  const files = await readTree(source)
  const fingerprint = createHash('sha256')
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) fingerprint.update(name).update(bytes)
  const version = fingerprint.digest('hex').slice(0, 16)
  const worker = files.get('sw.js')?.toString()
  if (!worker?.includes('__SCREEN_OFF_VERSION__')) throw new Error('Falta la versión del service worker de la prueba.')
  for (const [name, bytes] of files) {
    if (/\.(?:html|js|webmanifest)$/.test(name)) files.set(name, Buffer.from(bytes.toString().replaceAll('__SCREEN_OFF_VERSION__', version)))
  }
  const integrity = Object.fromEntries([...files].filter(([name]) => name !== 'sw.js')
    .map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]))
  files.set('sw.js', Buffer.from(files.get('sw.js').toString().replace('__SCREEN_OFF_INTEGRITY__', JSON.stringify(integrity))))
  const target = resolve(output)
  const sourcePath = resolve(source)
  if (contains(target, resolve(workspace)) || contains(target, sourcePath) || contains(sourcePath, target)) {
    throw new Error('La salida no puede contener el proyecto ni solaparse con los fuentes.')
  }
  for (const [name, bytes] of files) {
    const path = join(target, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
  return { version, files: [...files.keys()], output: target }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildScreenOff()
  console.log(`Prueba móvil ${result.version}: ${result.files.length} archivos en dist-pwa/prueba-audio/`)
}
