import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
const root=process.argv[2], build='6bdc970908569e3c', source='9c437f92c385a418f95f5f014cf07d7ba756c5c6'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=async path=>JSON.parse(await readFile(join(root,path),'utf8'))
const bind=async path=>{const bytes=await readFile(join(root,path));return {path,sha256:sha(bytes),bytes:bytes.length}}
async function files(path){const result=[];for(const item of await readdir(join(root,path),{withFileTypes:true})){const child=path+'/'+item.name;result.push(...(item.isDirectory()?await files(child):[child]))}return result.sort()}
const winPath=`artifacts/pwa-e2e/p1-opaque-download-${build}-win-manifest.json`, win=await json(winPath)
const wkPath=`artifacts/pwa-e2e/p1-opaque-download-${build}-webkit-frozen-copy.json`, wk=await json(wkPath)
const wkReportPath=`artifacts/pwa-e2e/p1-opaque-download-${build}-webkit/summary.json`, wkReport=await json(wkReportPath)
assert.equal(win.counts.pass,30);assert.equal(win.counts.fail,0);assert.equal(wkReport.counts.pass,15);assert.equal(wkReport.counts.fail,0)
const updatePath=`artifacts/pwa-port/update-e2e-${build}.json`, update=await json(updatePath)
assert.equal(update.passed,true);assert.equal(update.prototypeVersion,'1ea46db9dc0b5af3');assert.equal(update.checks.length,11)
const prototypePath='artifacts/pwa-port/p1-song-opaque-prototype-1ea46db9dc0b5af3-euri-public-90s.json', prototype=await json(prototypePath)
assert.equal(prototype.checks.filter(check=>check.pass).length,3);assert.equal(prototype.errors.length,0)
const localPath=`artifacts/pwa-port/p1-opaque-download-${build}-local-live-manifest.json`, local=await json(localPath)
assert.equal(local.result.completedChecks,0);assert.equal(local.result.failedPhase,'online-play')
const publicPath=process.argv[3];assert.ok(publicPath,'Public canary manifest, including an honest failure if blocked, is required')
const live=await json(publicPath)
assert.equal(live.finalResult.passed,4);assert.equal(live.finalResult.failed,0);assert.equal(live.finalResult.errors,0)
const state=await json('artifacts/pwa-deploy/state.json'), publicFilesPath=`artifacts/pwa-deploy/public-files-${build}.json`, publicFiles=await json(publicFilesPath)
const workflowPath=`artifacts/pwa-deploy/workflow-${build}.json`, workflow=await json(workflowPath)
assert.equal(state.pwa_build,build);assert.equal(publicFiles.passed,true);assert.equal(publicFiles.files.length,33)
assert.equal(workflow.conclusion,'success');assert.equal(workflow.headSha,state.commit)
const dry=await json(`artifacts/pwa-port/p1-opaque-download-publish-dry-run-${build}.json`);assert.equal(dry.sourceHash,state.source_hash)
const distFiles=await files('dist-pwa'), inventory=[]
for(const path of distFiles)inventory.push({...await bind(path),path:relative('dist-pwa',path).replaceAll('\\','/')})
const unchanged=[]
for(const file of inventory.filter(file=>file.path.endsWith('.woff2')||file.path.endsWith('.css')||file.path.includes('p1-recipe.generated-'))){
assert.equal(sha(await readFile(join('D:/tmp/pletina-pwa-baseline-1ea46db9dc0b5af3/dist-pwa',file.path))),file.sha256);unchanged.push(file.path)}
const evidence=[]
const families=/\/(?:primary-cdn-recovery-|audio-expiration-parser-|audio-resolution-audit-|audio-transient-catalog-|p1-download-feasibility-|p1-song-download-feasibility-|p1-opaque-download-|p1-song-opaque-prototype-|p1-download-ui-live-|update-e2e-6bdc970908569e3c)/
for(const path of await files('artifacts/pwa-port'))if(families.test(path))evidence.push(await bind(path))
for(const item of await readdir(join(root,'artifacts/pwa-e2e'),{withFileTypes:true}))if(item.name.startsWith(`p1-opaque-download-${build}`)||item.name.startsWith('primary-cdn-recovery-negative-1ea46db9dc0b5af3')){
const path='artifacts/pwa-e2e/'+item.name;for(const child of item.isDirectory()?await files(path):[path])evidence.push(await bind(child))}
evidence.push(await bind(publicFilesPath),await bind(workflowPath))
const manifest={schemaVersion:1,generatedAt:new Date().toISOString(),build,sourceCommit:source,engineFixCommit:'c349e9b',
runtime:{purePwa:true,addedBackend:false,proxyAtRuntime:false,userAccountsRequired:false,subscriptionRequired:false},
changes:{sameVideoPrimaryCDNRepair:true,downloadRepairExplicitlyExcluded:true,expiredFormatDoesNotDiscardFreshSibling:true,transientYoutubeFailureCanTryExactAudius:true,p1MusicDownloadEnabled:true,p1PodcastDownloadEnabled:false,p1DownloadGate:'Positive declared size up to256MiB and duration up to24h; same selected original format.',opaqueCopyValidation:'Completed Cache.put, local cache-only decoder duration and decodable tail before metadata commit.',opaqueSizeIsDeclared:true,opaqueBodySHA256Verified:false,downloadJobBudget:'P1: max(90s,min(10min,duration+30s)) from job start, retries share deadline; explicit timeout wins.',resolverMilliseconds:45000,unknownByteProgressLabel:'En curso',signedLocatorsPersisted:false},
logic:{passed:847,failed:0,skipped:0,report:await bind('artifacts/pwa-port/p1-opaque-download-logic-final-2026-10-23.log')},
typecheck:{errors:0,warnings:0,report:await bind('artifacts/pwa-port/p1-opaque-download-types-final-2026-10-23.log')},
controlledBrowsers:{passed:45,failed:0,countsIncludeThreePreparationsPerEngine:true,scope:'Compiled Svelte UI, genuine silent AAC/Opus, provider HTTP fixtures, real IndexedDB/CacheStorage and worker. Desktop engines with emulated layouts, not physical phones.',windows:await bind(winPath),webkit:await bind(wkPath),windowsConsolidation:'Chrome13v1+2affectedv2 by unique ID, Firefox15v1 unchanged; repeated preparations are not added.',webkitOutage:'HTTP origin/provider outage, not navigator.onLine false.',headers:'Chrome Sec-Fetch-Mode is unobserved when absent; opaque CacheStorage response remains mandatory.'},
negativeControls:{frozenPreviousYoutubeModule:{baseline:'916314e',tests:84,passed:77,failed:7,report:await bind('artifacts/pwa-port/primary-cdn-recovery-negative-frozen-2026-10-23.log')},compiledPreviousBuild:{baseline:'1ea46db9dc0b5af3',passed:4,failed:1,reason:'Two VISIONOS JSON OK replies followed by two media403, no P1; healthy control works.',report:await bind('artifacts/pwa-e2e/primary-cdn-recovery-negative-1ea46db9dc0b5af3/summary.json')}},
update:{fromBuild:'1ea46db9dc0b5af3',passed:11,failed:0,report:await bind(updatePath),scope:'Final compiled app graph, real worker and IndexedDB/CacheStorage test data. Does not test extraction or physical icon migration.'},
realProvider:{previousBuildPrototype:{build:'1ea46db9dc0b5af3',passed:3,failed:0,productDownloadUI:false,report:await bind(prototypePath),scope:'Real exact Euri P1 bytes in temporary QA-only opaque cache; offline reload/native playback. A30s attempt timed out; fresh90s attempt completed in about55s, not an identical-URL performance comparison.'},currentLocal:{result:local.result,manifest:await bind(localPath),scope:'Provider403 before the download action; no product-download result inferred.'},currentPublic:{manifest:await bind(publicPath),state:live.state,result:live.finalResult,scope:'Frozen UI canary and actual public distribution; reports its own pass/fail phase.'}},
distribution:{files:inventory.length,bytes:inventory.reduce((n,file)=>n+file.bytes,0),initialBytes:51243,onDemandBytes:786967,sourceHash:dry.sourceHash,cssFontsAndRecipeUnchanged:unchanged,inventory},
publication:{...state,workflow:workflow.url,workflowConclusion:workflow.conclusion,publicFilesPassed:33,report:await bind(publicFilesPath)},
limits:{universalAvailabilityClaimed:false,niNiNi403Resolved:false,newPhysicalAndroidTest:false,newPhysicalIOSTest:false,screenOffVerifiedForThisBuild:false,backgroundDownloadsGuaranteed:false,APKMigration:false,androidAuto:false,carPlay:false},
sourceBindingPolicy:'Historical report source paths identify their bytes at execution time. Replay uses each immutable source snapshot; older live source paths need not match the latest QA revision.',evidence}
await writeFile(join(root,`artifacts/pwa-e2e/validation-${build}.json`),JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({build,logic:847,controlledBrowsers:45,update:11,publicFiles:33,publicCanary:{passed:live.finalResult.passed,failed:live.finalResult.failed},evidence:evidence.length,distributionBytes:manifest.distribution.bytes}))
