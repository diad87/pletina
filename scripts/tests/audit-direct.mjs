// Uses cached dependency artifacts read-only; outputs and binary stay in a fresh audit directory.
// node scripts/tests/audit-direct.mjs <output-dir> <existing-cargo-target>
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const output = resolve(process.argv[2]), target = resolve(process.argv[3])
await mkdir(output, { recursive:true })
const deps = join(target, 'debug/deps'), files = await readdir(deps)
const externs = []
for (const name of ['reqwest','tokio','serde_json']) {
  const candidates = files.filter((file) => file.startsWith(`lib${name}-`) && file.endsWith('.rlib')).sort()
  assert.ok(candidates.length, `Missing cached ${name}`)
  let selected = candidates.at(-1)
  if (name === 'reqwest') {
    const matching = []
    for (const candidate of candidates) {
      const id = candidate.slice(3,-5)
      const metadata = JSON.parse(await readFile(join(target,'debug/.fingerprint',id,'lib-reqwest.json'),'utf8'))
      const features = JSON.parse(metadata.features)
      // The product uses reqwest 0.12 rustls-tls+gzip, not Tauri updater's reqwest 0.13.
      if (features.includes('rustls-tls') && features.includes('gzip') && features.includes('charset')) matching.push(candidate)
    }
    assert.equal(matching.length,1,'Must select the exact product reqwest feature set')
    selected = matching[0]
  }
  externs.push('--extern',`${name}=${join(deps,selected)}`)
}
const rustc = join(homedir(),'.cargo/bin/rustc.exe'), binary = join(output,'audit-direct.exe')
const args = ['--edition=2024',join(root,'scripts/tests/core-direct/main.rs'),'-L',`dependency=${deps}`,...externs,'-o',binary]
const build = spawnSync(rustc,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000})
await writeFile(join(output,'direct-build.log'),(build.stdout??'')+(build.stderr??''))
const manifest = { sourceSha256:createHash('sha256').update(await readFile(join(root,'src-tauri/src/direct.rs'))).digest('hex'),compile:{executable:rustc,args,status:build.status,error:build.error?.message} }
await writeFile(join(output,'direct-manifest.json'),JSON.stringify(manifest,null,2))
assert.equal(build.status,0,build.stderr)
const execution = spawnSync(binary,[output],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000})
await writeFile(join(output,'direct.log'),(execution.stdout??'')+(execution.stderr??''))
manifest.execute = {status:execution.status,error:execution.error?.message}
console.log(execution.stdout)
// Child process timeout is intentional: a synchronous remove-file retry loop cannot be interrupted by a Tokio timer.
const denied = spawnSync(binary,[output,'--undeletable'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:2500})
await writeFile(join(output,'undeletable.log'),(denied.stdout??'')+(denied.stderr??''))
const confirmedFault = (denied.stdout??'').includes('confirmed remove_file denial')
const timedOut = denied.error?.code === 'ETIMEDOUT'
const child = {id:'CORE-DL-008',test:'Oversized partial denied deletion must return a recoverable error',status:confirmedFault && timedOut?'fail':confirmedFault && denied.status===0?'pass':'blocked',confirmedDeletionDenial:confirmedFault,timedOut,timeoutMilliseconds:2500,exitCode:denied.status,error:denied.error?.message,stdout:denied.stdout}
const report = JSON.parse(await readFile(join(output,'direct-results.json'),'utf8'))
report.tests.push(child)
report.pass = report.tests.filter((row)=>row.status==='pass').length
report.fail = report.tests.filter((row)=>row.status==='fail').length
report.blocked = report.tests.filter((row)=>row.status==='blocked').length
await writeFile(join(output,'direct-results.json'),JSON.stringify(report,null,2))
await writeFile(join(output,'direct-manifest.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify(child))
console.log(`Direct harness: ${report.pass} pass, ${report.fail} fail, ${report.blocked} blocked; ${output}`)
process.exitCode = report.fail?1:report.blocked?2:0
