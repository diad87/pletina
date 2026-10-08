// The Linux packages carry the same Node runtime used to build them, so yt-dlp
// also works on machines without Node/Deno installed or a shell-specific PATH.
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('Prepare the Linux runtime on Linux, with Node 24 or newer.')
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Linux packaging requires Node 24 or newer.')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'src-tauri/runtime')
const licensePaths = [
  join(dirname(process.execPath), '..', 'LICENSE'),
  join(dirname(process.execPath), 'LICENSE'),
]
let license
for (const path of licensePaths) {
  try {
    const contents = await readFile(path, 'utf8')
    if (contents.includes('Node.js') && contents.includes('Permission is hereby granted')) {
      license = contents
      break
    }
  } catch { /* Try the next standard Node distribution layout. */ }
}
if (!license) throw new Error('Node license not found. Build with an official Node.js tarball, preserving its LICENSE file.')
await mkdir(target, { recursive: true })
await copyFile(process.execPath, join(target, 'node'))
await chmod(join(target, 'node'), 0o755)
await writeFile(join(target, 'LICENSE-node'), license)
console.log(`Linux runtime ready: Node ${process.versions.node} (${process.arch})`)
