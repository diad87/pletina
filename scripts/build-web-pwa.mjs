import { build } from 'vite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPwa, buildPortablePwa } from './build-pwa.mjs'
import { buildScreenOff } from './build-pwa-screen-off.mjs'

const workspace = dirname(dirname(fileURLToPath(import.meta.url)))
export async function buildWebPwa() {
  await build({ configFile: join(workspace, 'vite.pwa.config.ts'), mode: 'pwa' })
  const result = await buildPwa({ application: join(workspace, 'dist-web-port') })
  await buildPortablePwa()
  await buildScreenOff()
  console.log(`Pletina 0.11.2 web ${result.version}: ${result.initialBytes} bytes iniciales; ${result.bytes - result.initialBytes} bajo demanda.`)
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWebPwa()
