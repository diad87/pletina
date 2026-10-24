// Auditoría local: no publica, instala aplicaciones ni usa la biblioteca del usuario.
// node scripts/audit-stability.mjs --profile quick [--dry-run] [--out carpeta]
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile, open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { arch, homedir, platform, release } from 'node:os'
import { randomUUID } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let profile = 'quick', outputBase = join(root, 'artifacts', 'stability'), dryRun = false
for (let i = 0; i < args.length; i++) {
  const key = args[i]
  if (key === '--dry-run') dryRun = true
  else if (key === '--profile' && args[i + 1]) profile = args[++i]
  else if (key === '--out' && args[i + 1]) outputBase = resolve(args[++i])
  else { console.error(`Argumento no válido: ${key}`); process.exit(2) }
}
const localCargo = join(homedir(), '.cargo', 'bin', platform() === 'win32' ? 'cargo.exe' : 'cargo')
const cargo = existsSync(localCargo) ? localCargo : 'cargo'
const node = (id, argv, timeoutSeconds = 180) => ({ id, command: process.execPath, args: argv, timeoutSeconds })
const profiles = {
  quick: [
    node('svelte-types', ['node_modules/svelte-check/bin/svelte-check', '--tsconfig', './tsconfig.app.json']),
    node('tooling-types', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.node.json']),
    node('player-baseline', ['--test', 'scripts/tests/player.test.mjs']),
    node('podcast-favorites', ['--test', 'scripts/tests/podcast-favorites.test.mjs']),
    node('player-forum-regressions', ['--test', 'scripts/tests/forum-playback.test.mjs']),
    node('player-recovery', ['--test', 'scripts/tests/player-recovery.test.mjs']),
    node('frontend-build', ['node_modules/vite/bin/vite.js', 'build']),
  ],
  data: [node('frontend-data', ['--test', 'scripts/tests/audit-frontend.test.mjs'])],
  core: [{ id: 'rust-unit', command: cargo, args: ['test', '-j', '1', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--test-threads=1'], timeoutSeconds: 1800 }],
  network: [{ id: 'youtube-native-real', command: cargo, args: ['run', '-j', '1', '--locked', '--manifest-path', 'scripts/tests/forum-native/Cargo.toml', '--', '$OUTPUT/network-probe.json'], timeoutSeconds: 600 }],
}
if (!(profile in profiles)) { console.error('Perfiles válidos: quick, data, core, network'); process.exit(2) }
const suites = profiles[profile]
if (dryRun) {
  console.log(JSON.stringify({ profile, cwd: root, suites, note: 'Plan únicamente; no ejecuta pruebas. $OUTPUT se sustituye por una carpeta nueva por ejecución.' }, null, 2))
  process.exit(0)
}
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${platform()}-${randomUUID().slice(0, 8)}`
const output = join(outputBase, runId)
await mkdir(output, { recursive: true })
const git = (...argv) => {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : null
}
const report = {
  schemaVersion: 1, runId, profile, startedAt: new Date().toISOString(),
  environment: { platform: platform(), arch: arch(), osRelease: release(), node: process.version, cwd: root },
  source: { commit: git('rev-parse', 'HEAD'), changes: git('status', '--short') },
  scope: 'Solo las suites enumeradas. No certifica plataformas, hardware, reproducción audible, pruebas manuales o casos omitidos.',
  status: 'running', suites: [],
}
const save = () => writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
await save()
console.log(`Resultados: ${output}`)

async function execute(suite) {
  const argv = suite.args.map((value) => value.replace('$OUTPUT', output))
  const logPath = join(output, `${suite.id}.log`)
  const log = await open(logPath, 'w')
  const start = Date.now()
  let timedOut = false, timer
  const outcome = await new Promise((done) => {
    const child = spawn(suite.command, argv, {
      cwd: root, windowsHide: true, detached: platform() !== 'win32',
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, CARGO_BUILD_JOBS: '1' },
    })
    child.once('error', (error) => done({ status: 'blocked', error: error.message, exitCode: null }))
    child.once('close', (code, signal) => done({ status: timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail', exitCode: code, signal }))
    timer = setTimeout(() => {
      timedOut = true
      if (!child.pid || child.exitCode !== null) return
      if (platform() === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }, suite.timeoutSeconds * 1000)
  })
  clearTimeout(timer)
  await log.close()
  return { id: suite.id, ...outcome, seconds: (Date.now() - start) / 1000, command: suite.command, args: argv, log: logPath }
}

for (const suite of suites) {
  console.log(`START ${suite.id}`)
  const result = await execute(suite)
  report.suites.push(result)
  await save()
  console.log(`${result.status.toUpperCase()} ${suite.id} (${result.seconds.toFixed(1)} s)`)
}
report.finishedAt = new Date().toISOString()
report.status = report.suites.every((s) => s.status === 'pass') ? 'pass' : 'not-passed'
await save()
console.log(`Resultado ${profile}: ${report.status}. Esto no equivale a aprobar la auditoría completa.`)
process.exitCode = report.status === 'pass' ? 0 : 1
