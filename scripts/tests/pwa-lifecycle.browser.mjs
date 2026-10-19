// Player real + Chrome Audio/WAV local. Explicit CDP freeze is not a physical screen-off test.
// node scripts/tests/pwa-lifecycle.browser.mjs --playwright packageOrPath --chrome executable
//   [--expect-prepared] [--only-script-control] [--report lifecycle-browser.json]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'
import { build, normalizePath } from 'vite'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const require = createRequire(import.meta.url)
const { chromium } = require(option('--playwright', 'playwright'))
const expectPrepared = args.includes('--expect-prepared')
const onlyScriptControl = args.includes('--only-script-control')
const reportName = option('--report', 'lifecycle-browser.json')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const output = join(workspace, 'artifacts', 'pwa-port', reportName)
const commonJs = (value) => ts.transpileModule(value, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS,
} }).outputText
const source = await readFile(join(workspace, 'src', 'lib', 'player.svelte.ts'), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
} }).outputText
const compiled = commonJs(compileModule(javascript, { filename: 'diagnostic-player.svelte.js' }).js.code)
const queue = commonJs(await readFile(join(workspace, 'src', 'lib', 'queue.ts'), 'utf8'))
const sleepTimer = commonJs(await readFile(join(workspace, 'src', 'lib', 'sleep-timer.ts'), 'utf8'))
const queuePersistence = commonJs(await readFile(join(workspace, 'web-port', 'queue-persistence.ts'), 'utf8'))
const report = {
  testedAt: new Date().toISOString(), sourcePlayerSha256: createHash('sha256').update(source).digest('hex'),
  scope: 'Real compiled Player with controlled API adapter and real Chrome Audio decoding local WAV. Explicit renderer freezing/throttling only; no physical screen-off equivalence.',
  physicalScreenOffVerified: false, androidVerified: false, iOSVerified: false,
  fullApplicationTest: false, realYouTubeResolverTested: false, externalNetworkUsed: false,
  audioOutputSilencedByChromeArgument: true, mediaElementMuted: false,
  expectPrepared, onlyScriptControl, cases: [], errors: [],
}
const scrub = (value) => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]')
  .replace(/[A-Z]:[\\/][^\s\n"']+/gi, '[path]').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 700)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let temporary, browser, server, page, cdp, origin, currentCase
const requests = []
function wav(seconds) {
  const rate = 22050, samples = rate * seconds
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * 330) * 3000), 44 + i * 2)
  return bytes
}
async function snapshot() { return page.evaluate(() => window.qaSnapshot()) }
async function waitPlaying(id, timeout = 15000) {
  await page.waitForFunction((id) => {
    const state = window.qaSnapshot()
    return state.current === id && state.status === 'playing' && !state.audio.paused && state.audio.time > 0.15
  }, id, { timeout })
}
async function testCase(name, scenario, action) {
  currentCase = name
  process.stdout.write(`${name} ... `)
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  let background
  try {
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort('blockedbyclient'))
    page = await context.newPage()
    page.on('pageerror', (error) => report.errors.push({ case: name, error: scrub(error.message) }))
    await page.goto(origin + '/qa/', { waitUntil: 'load' })
    await page.evaluate((scenario) => { window.qaScenario = scenario }, scenario)
    cdp = await context.newCDPSession(page)
    await page.locator('#start').click()
    await waitPlaying(1)
    background = await context.newPage()
    await background.goto('about:blank')
    await background.bringToFront()
    // Some headless Chrome versions report both tabs visible. Record the real value;
    // never override visibility properties or equate a second tab with screen off.
    const detail = await action({ context, background })
    report.cases.push({ name, pass: true, ...detail, final: await snapshot() })
    process.stdout.write('passed\n')
  } catch (error) {
    await cdp?.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {})
    await cdp?.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
    report.cases.push({ name, pass: false, error: scrub(error.message), final: await snapshot().catch(() => null) })
    process.stdout.write('FAILED\n')
  } finally {
    await cdp?.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {})
    await cdp?.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
    await context.close()
    page = null; cdp = null
  }
}

try {
  temporary = await mkdtemp(join(tmpdir(), 'pletina-lifecycle-browser-'))
  const entry = `import * as svelte from ${JSON.stringify(normalizePath(require.resolve('svelte/internal/client')))};
window.qaScenario={};window.qaEvents=[];window.qaPending=[];
const log=(type,detail={})=>window.qaEvents.push({type,at:Date.now(),hidden:document.hidden,...detail});
const audios=[];const NativeAudio=window.Audio;let WrappedAudio;
WrappedAudio=new Proxy(NativeAudio,{construct(target,args,newTarget){
 const audio=Reflect.construct(target,args,newTarget===WrappedAudio?target:newTarget);audios.push(audio);
 for(const type of ['loadstart','loadedmetadata','playing','pause','waiting','stalled','error','ended'])audio.addEventListener(type,()=>log(type,{source:new URL(audio.src||location.href).pathname,time:audio.currentTime,paused:audio.paused,errorCode:audio.error?.code??null}));
 const remove=audio.removeAttribute.bind(audio);audio.removeAttribute=(name)=>{if(name==='src')log('source-cleared');return remove(name)};
 if(window.qaScenario.attachAudio){audio.setAttribute('playsinline','');document.body.append(audio)}
 return audio;
}});window.Audio=WrappedAudio;
const nativePlay=HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play=function(){
 log('play-called',{source:new URL(this.src||location.href).pathname});
 if(window.qaScenario.blockAutoplay&&this.src.endsWith('/2.wav')){log('autoplay-rejected');return Promise.reject(new DOMException('Diagnostic simulated autoplay denial','NotAllowedError'))}
 return nativePlay.call(this);
};
document.addEventListener('freeze',()=>log('freeze'));document.addEventListener('resume',()=>log('resume'));
window.qaResolve=async(track,refresh)=>{
 const late=window.qaPlayer?.current?.track.id===2&&track.id===2;
 log('resolve-start',{id:track.id,refresh,late});
 if(window.qaScenario.blockLateResolver&&late)await new Promise(resolve=>window.qaPending.push(resolve));
 await Promise.resolve();log('resolve-complete',{id:track.id,late});
 return {url:new URL('/audio/'+track.id+'.wav',location.href).href,local:false};
};
window.qaRelease=()=>{window.qaScenario.blockAutoplay=false;window.qaScenario.blockLateResolver=false;for(const resolve of window.qaPending.splice(0))resolve()};
const queue={};new Function('exports',${JSON.stringify(queue)})(queue);
const sleepTimer={};new Function('exports',${JSON.stringify(sleepTimer)})(sleepTimer);
const queuePersistence={};new Function('exports',${JSON.stringify(queuePersistence)})(queuePersistence);
const modules={
 'svelte/internal/client':svelte,
 '@tauri-apps/api/core':{convertFileSrc(){throw Error('Unexpected native path')}},
 '@tauri-apps/api/window':{getCurrentWindow(){throw Error('Unexpected native window')}},
 './api':{inPwa:true,inTauri:false,resolve:(track,refresh)=>window.qaResolve(track,refresh),recordPlay:async()=>{}},
 './downloads.svelte':{downloads:{done:new Set(),start(){}}},
 './extractor/capture':{stopCapture(){},setAudioSource(audio,url){log('source-assigned',{source:new URL(url).pathname});audio.src=url;audio.load()}},
 './library.svelte':{library:{historyVersion:0},toLib:value=>value},
 './media':{isPodcast:()=>false,isYouTubeTrack:()=>false,mediaUrl:value=>value},
 './toast.svelte':{toast:{show:message=>log('toast',{message})}},
 './podcast-progress.svelte':{episodeProgress:{position:async()=>0,save:async()=>{},flush:async()=>{}}},
 './player-android.svelte':{isAndroid:false},'./queue':{...queue,load:(_key,fallback)=>fallback,save(){}},'./sleep-timer':sleepTimer,
 '../../web-port/queue-persistence':queuePersistence,
};
const exports={};new Function('require','exports',${JSON.stringify(compiled)})(name=>{if(!(name in modules))throw Error('Unknown diagnostic module '+name);return modules[name]},exports);
window.qaPlayer=exports.player;
window.qaSnapshot=()=>{const p=window.qaPlayer,a=audios.at(-1);return {current:p.current?.track.id,status:p.status,pos:p.pos,hasNext:p.hasNext,upcoming:p.upcoming.map(x=>x.item.track.id),hidden:document.hidden,audioCount:audios.length,audio:{time:a.currentTime,duration:Number.isFinite(a.duration)?a.duration:null,paused:a.paused,ended:a.ended,errorCode:a.error?.code??null,source:a.src?new URL(a.src).pathname:null},events:window.qaEvents}};
const item=id=>({track:{id,title:'QA '+id,duration:id===1?4:12,artist:{id:1,name:'QA'}},albumId:1,albumTitle:'QA',artistId:1,cover:null});
document.querySelector('#start').onclick=()=>window.qaPlayer.playQueue(window.qaScenario.single?[item(1)]:[item(1),item(2)],0);
document.querySelector('#resume').onclick=()=>window.qaPlayer.toggle();
document.querySelector('#next').onclick=()=>window.qaPlayer.next();
`
  await writeFile(join(temporary, 'entry.mjs'), entry)
  await writeFile(join(temporary, 'index.html'), '<!doctype html><html><body><button id="start">Start fixture</button><button id="resume">Resume fixture</button><button id="next">Next fixture</button><script type="module" src="./entry.mjs"></script></body></html>')
  await build({ configFile: false, root: temporary, base: '/qa/', logLevel: 'silent', build: {
    outDir: join(temporary, 'output'), emptyOutDir: true, minify: false,
  } })
  const content = new Map([['/audio/1.wav', wav(4)], ['/audio/2.wav', wav(12)]])
  const collect = async (directory, base = directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) await collect(path, base)
      else content.set('/qa/' + normalizePath(path.slice(base.length + 1)), await readFile(path))
    }
  }
  await collect(join(temporary, 'output'))
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const key = path === '/qa/' ? '/qa/index.html' : path
    const bytes = content.get(key)
    if (!bytes) { response.writeHead(404); response.end(); return }
    if (path.startsWith('/audio/')) requests.push({ case: currentCase, path, at: Date.now() })
    const headers = { 'Content-Type': key.endsWith('.wav') ? 'audio/wav' : key.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' }
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    if (match) {
      const start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1)
      if (start > end) { response.writeHead(416); response.end(); return }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 })
      response.end(bytes.subarray(start, end + 1))
    } else { response.writeHead(200, { ...headers, 'Content-Length': bytes.length }); response.end(bytes) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
    ...(option('--chrome', null) ? { executablePath: option('--chrome') } : {}) })
  report.browser = browser.version()
  if (!onlyScriptControl) {
  await testCase('single-track queue exhaustion control', { single: true }, async () => {
    await page.waitForFunction(() => window.qaSnapshot().events.some(event => event.type === 'ended') && window.qaPlayer.status === 'paused')
    const state = await snapshot()
    assert.equal(state.current, 1); assert.equal(state.hasNext, false); assert.equal(state.pos, 0)
    return { diagnosis: 'Queue exhausted; no next resolver or next source is expected.' }
  })
  await testCase('natural ended transition with measured tab visibility', {}, async () => {
    await waitPlaying(2)
    const state = await snapshot(), ended = state.events.findIndex(event => event.type === 'ended')
    assert.ok(ended >= 0)
    const lateResolves = state.events.slice(ended).filter(event => event.type === 'resolve-start')
    if (expectPrepared) assert.equal(lateResolves.length, 0)
    return { diagnosis: 'JavaScript and playback both progressed; tab visibility is recorded rather than assumed.', endedEventHidden: state.events[ended].hidden, lateResolvesAfterEnded: lateResolves.length,
      clearsAfterEnded: state.events.slice(ended).filter(event => event.type === 'source-cleared').length }
  })
  await testCase('CPU-throttled renderer transition', {}, async () => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    await waitPlaying(2, 20000)
    return { cpuThrottleRate: 6, diagnosis: 'CPU throttling permitted ended handler and the next source.' }
  })
  await testCase('explicit frozen renderer limitation', {}, async () => {
    await page.waitForFunction(() => window.qaSnapshot().audio.time > 0.4)
    const before = await snapshot(), frozenAt = Date.now()
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
    await sleep(5500)
    const during = requests.filter(request => request.case === currentCase && request.path === '/audio/2.wav' && request.at >= frozenAt)
    const resumedAt = Date.now()
    await cdp.send('Page.setWebLifecycleState', { state: 'active' })
    await waitPlaying(2, 20000)
    const state = await snapshot()
    return { frozenDurationMs: resumedAt - frozenAt, beforeTime: before.audio.time, nextMediaRequestsDuringFreeze: during.length,
      endedEventsDuringFreeze: state.events.filter(event => event.type === 'ended' && event.at >= frozenAt && event.at < resumedAt).length,
      diagnosis: during.length === 0 ? 'No next media request during explicit freeze; next audio starts after renderer resumes.' : 'Chrome still allowed the media transition under this explicit freeze; this control did not suspend the relevant work.' }
  })
  await testCase('late resolver barrier versus prepared source', { blockLateResolver: true }, async () => {
    await page.waitForFunction(() => window.qaPlayer.current?.track.id === 2)
    await sleep(300)
    const blocked = await snapshot(), ended = blocked.events.findIndex(event => event.type === 'ended')
    const lateResolves = blocked.events.slice(ended).filter(event => event.type === 'resolve-start')
    const prepared = blocked.status === 'playing' && blocked.audio.source === '/audio/2.wav' && lateResolves.length === 0
    if (expectPrepared) assert.ok(prepared, 'Prepared next source should avoid the intentionally blocked late resolver')
    if (!prepared) {
      assert.equal(blocked.status, 'loading')
      assert.ok(lateResolves.length > 0)
      await page.evaluate(() => window.qaRelease())
      await waitPlaying(2)
    }
    return { preparedSourceBypassedBarrier: prepared, beforeRelease: { status: blocked.status, current: blocked.current, source: blocked.audio.source },
      diagnosis: prepared ? 'Prepared source transitions without a new resolve call.' : 'Next queue item selected, resolver pending; releasing only that barrier starts audio.' }
  })
  await testCase('simulated autoplay rejection signature and manual retry', { blockAutoplay: true }, async () => {
    await page.waitForFunction(() => window.qaPlayer.current?.track.id === 2 && window.qaPlayer.status === 'paused')
    const blocked = await snapshot()
    assert.equal(blocked.audio.source, '/audio/2.wav')
    assert.ok(blocked.events.some(event => event.type === 'autoplay-rejected'))
    assert.ok(blocked.events.some(event => event.type === 'toast' && /Audio preparado/.test(event.message)))
    await page.evaluate(() => window.qaRelease())
    await page.bringToFront()
    await page.locator('#resume').click()
    await waitPlaying(2)
    return { simulated: true, beforeRetry: { status: blocked.status, current: blocked.current, source: blocked.audio.source },
      diagnosis: 'Next source was prepared; simulated NotAllowedError left it paused; a user tap resumed it.' }
  })
  }
  await testCase('explicit script execution suspension control', {}, async () => {
    await page.waitForFunction(() => window.qaSnapshot().audio.time > 0.4)
    const disabledAt = Date.now()
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true })
    await sleep(5500)
    const during = requests.filter(request => request.case === currentCase && request.path === '/audio/2.wav' && request.at >= disabledAt)
    const enabledAt = Date.now()
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false })
    await sleep(200)
    const after = await snapshot()
    const endedDuringSuspension = after.events.filter(event => event.type === 'ended' && event.at >= disabledAt && event.at < enabledAt).length
    const controlSuspendedTransition = during.length === 0 && endedDuringSuspension === 0
    let manualNextRequired = false
    if (controlSuspendedTransition && after.current === 1 && after.audio.ended) {
      manualNextRequired = true
      await page.bringToFront()
      await page.locator('#next').click()
    }
    await waitPlaying(2)
    return { scriptExecutionDisabledMs: enabledAt - disabledAt, nextMediaRequestsWhileDisabled: during.length,
      endedEventsWhileDisabled: endedDuringSuspension, controlSuspendedTransition, manualNextRequired,
      afterEnable: { current: after.current, status: after.status, ended: after.audio.ended, source: after.audio.source },
      diagnosis: controlSuspendedTransition
        ? 'Explicitly disabling JavaScript stopped the transition despite a prepared source; this is an artificial control, not Android screen-off.'
        : 'Chrome continued the transition even with this command; this control did not suspend the relevant work.' }
  })
} catch (error) { report.fatal = scrub(error.message) }
finally {
  await cdp?.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {})
  await cdp?.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  await browser?.close().catch(() => {})
  if (server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); report.localServerClosed = !server.listening }
  if (temporary) {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
    assert.match(basename(temporary), /^pletina-lifecycle-browser-/)
    await rm(temporary, { recursive: true, force: true }); report.temporarySiteRemoved = true
  }
  report.finishedAt = new Date().toISOString()
  report.passed = !report.fatal && report.cases.length === (onlyScriptControl ? 1 : 7) && report.cases.every(value => value.pass) && report.errors.length === 0
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(`Report: artifacts/pwa-port/${reportName}; ${report.passed ? 'PASS' : 'FAIL'}\n`)
  if (!report.passed) process.exitCode = 1
}
