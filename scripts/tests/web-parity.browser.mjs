// Full-UI integration QA. A mobile viewport is desktop Chrome emulation, not phone evidence.
// node scripts/tests/web-parity.browser.mjs [--expected-build HASH] [--url HTTPS]
//   [--puppeteer PACKAGE] [--chrome EXECUTABLE] [--skip-audio | --navigation-only | --podcast-only] [--report ui-browser.json]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../preview-pwa.mjs'
const args=process.argv.slice(2)
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback
const onlyYouTube=args.includes('--youtube-only')
const require=createRequire(import.meta.url)
const puppeteer=require(option('--puppeteer','puppeteer'))
const directory=new URL('../../artifacts/pwa-parity/',import.meta.url)
await mkdir(directory,{recursive:true})
const reportName=option('--report','ui-browser.json')
assert.match(reportName,/^[a-z0-9-]+\.json$/i)
const csv=new URL('qa-import.csv',directory)
await writeFile(csv,'Track Name,Artist Name(s),Album Name,Duration (ms)\nCreep,Radiohead,Pablo Honey,238000\nCreep,Radiohead,Pablo Honey,238000\n')
const scrub=value=>String(value??'').replace(/https?:\/\/[^\s"'<>]+/g,'[URL]').slice(0,450)
const report={testedAt:new Date().toISOString(),build:null,checks:[],errors:[],network:[],
  evidence:'Desktop Chrome; Android user agent and 393px viewport check mobile UI only.',physicalPhoneVerified:false,iOSPlaybackVerified:false,offlineMusicClaimed:false}
let server,browser,page,stage=''
const snapshot=()=>page.evaluate(()=>({
  online:navigator.onLine,origin:location.origin,path:location.pathname,headings:[...document.querySelectorAll('.view h1,.view h2')].map(e=>e.textContent.trim()).slice(0,6),
  navigation:{index:history.state?.index,route:history.state?.snapshot?.stack[history.state?.index],historyLength:history.length},
  tabs:[...document.querySelectorAll('.bottom-nav button')].map(e=>e.textContent.trim()),
  audio:(window.__parityAudio??[]).map(a=>({time:Number(a.currentTime.toFixed(3)),duration:Number.isFinite(a.duration)?a.duration:null,
    paused:a.paused,muted:a.muted,srcPresent:Boolean(a.src),error:a.error?.code??null})),
  notices:[...document.querySelectorAll('[role="alert"],.toast,.notice')].map(e=>e.textContent.trim()).slice(0,5),
}))
async function wait(predicate,timeout=30000,...parameters){await page.waitForFunction(predicate,{polling:200,timeout},...parameters)}
async function check(name,action){
  process.stdout.write(`${name} ... `)
  try{const details=await action();report.checks.push({name,pass:true,...details});process.stdout.write('passed\n');return true}
  catch(error){report.checks.push({name,pass:false,stage,error:scrub(error.message),state:await snapshot().catch(()=>null)});process.stdout.write('FAILED\n');return false}
  finally{await writeFile(new URL(reportName,directory),JSON.stringify(report,null,2)+'\n');stage=''}
}
async function clickText(selector,text,exact=true){
  const handle=await page.evaluateHandle((selector,text,exact)=>[...document.querySelectorAll(selector)].find(e=>exact?e.textContent.trim()===text:e.textContent.includes(text)),selector,text,exact)
  assert.ok(handle.asElement(),`Action ${text}`)
  await handle.asElement().click();await handle.dispose()
}
const tab=name=>clickText('.bottom-nav button',name)
const capture=name=>page.screenshot({path:fileURLToPath(new URL(name,directory)),fullPage:true})
async function fillSearch(label,text){
  const selector=`input[aria-label="${label}"]`
  await page.waitForSelector(selector,{visible:true})
  // BottomNav enfoca y selecciona en rAF: el gesto de escritura debe empezar después.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  await page.click(selector,{clickCount:3});await page.type(selector,text)
}
async function safeClick(selector){
  await page.evaluate(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    await Promise.all((document.querySelector('.view')?.getAnimations()??[]).map(a=>a.finished.catch(()=>{})))
  })
  await page.$eval(selector,e=>e.scrollIntoView({block:'center',inline:'nearest'}))
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const target=await page.$eval(selector,e=>{
    const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y)
    return{x,y,hit:e===hit||e.contains(hit),hitTag:hit?.tagName,hitClass:hit?.getAttribute('class'),label:e.getAttribute('aria-label')}
  })
  assert.ok(target.hit,`Gesture obstructed: ${JSON.stringify(target)}`)
  await page.mouse.click(target.x,target.y)
  return target
}
try{
  let url=option('--url',null)
  if(!url){server=createPwaServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});url=`http://127.0.0.1:${server.address().port}/pletina/`}
  else assert.equal(new URL(url).protocol,'https:')
  report.target={origin:new URL(url).origin,path:new URL(url).pathname}
  browser=await puppeteer.launch({headless:true,args:['--mute-audio'],...(option('--chrome',null)?{executablePath:option('--chrome')}: {})})
  report.browser=await browser.version()
  page=await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 15; Xiaomi 15T Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36')
  await page.setViewport({width:393,height:852,isMobile:true,hasTouch:true,deviceScaleFactor:1})
  await page.evaluateOnNewDocument(()=>{
    const Native=window.Audio,instances=[];let Wrapped
    Wrapped=new Proxy(Native,{construct(target,args,newTarget){const a=Reflect.construct(target,args,newTarget===Wrapped?target:newTarget);instances.push(a);return a}})
    window.Audio=Wrapped;window.__parityAudio=instances
  })
  page.on('pageerror',error=>report.errors.push({name:error.name,message:scrub(error.message)}))
  page.on('response',response=>{const u=new URL(response.url());if(response.request().resourceType()==='media')report.network.push({host:u.hostname,status:response.status(),contentType:response.headers()['content-type']??null})})

  const opened=await check('mobile navigation has all four native tabs',async()=>{
    await page.goto(url,{waitUntil:'load'})
    await wait(()=>Boolean(navigator.serviceWorker.controller),30000)
    report.build=await page.$eval('#version',e=>e.textContent.trim())
    if(option('--expected-build',null))assert.equal(report.build,option('--expected-build'))
    await Promise.all([page.waitForNavigation({waitUntil:'load',timeout:45000}),page.click('#open-player')])
    await page.waitForSelector('.app.mobile .bottom-nav')
    const labels=await page.$$eval('.bottom-nav button',nodes=>nodes.map(e=>e.textContent.trim()))
    assert.deepEqual(labels,['Inicio','Buscar','Podcasts','Tu biblioteca'])
    const size=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}))
    assert.ok(size.document<=size.viewport+1)
    return{labels,size}
  })
  assert.ok(opened,'App required for following checks')

  if(!args.includes('--podcast-only')&&!onlyYouTube)await check('browser Back/Forward preserve the app route and visible bottom navigation',async()=>{
    const appURL=page.url()
    stage='open Search'
    await tab('Buscar')
    await fillSearch('Buscar música','Creep Radiohead')
    stage='query stored in history'
    await wait(()=>history.state?.snapshot?.stack[history.state.index]?.query==='Creep Radiohead')
    await page.evaluate(()=>history.back())
    stage='Back to Home'
    await wait(()=>history.state?.snapshot?.stack[history.state.index]?.name==='home')
    assert.equal(page.url(),appURL)
    await page.evaluate(()=>history.forward())
    stage='Forward restores query'
    await wait(()=>document.querySelector('input[aria-label="Buscar música"]')?.value==='Creep Radiohead')
    const dock=await page.$eval('.bottom-nav',e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight}})
    assert.ok(dock.height>0&&dock.top>=0&&dock.bottom<=dock.viewport+1)
    await page.reload({waitUntil:'load'})
    stage='reload restores Search query'
    await wait(()=>document.querySelector('input[aria-label="Buscar música"]')?.value==='Creep Radiohead')
    await page.evaluate(()=>history.back())
    stage='Back after reload'
    await wait(()=>history.state?.snapshot?.stack[history.state.index]?.name==='home')
    assert.ok(await page.$('.bottom-nav'))
    return{sameURL:true,querySurvivedReload:true,dock}
  })

  if(!args.includes('--navigation-only')){
  const podcasts=await check('podcast search keeps RSS and YouTube catalogs in the native view',async()=>{
    await tab('Podcasts')
    await fillSearch('Buscar podcasts','Nadie sabe nada')
    await page.waitForSelector('[aria-label="Resultados de pódcasts"] .hit[aria-label="Nadie Sabe Nada"]',{timeout:60000})
    await page.waitForSelector('[aria-label="Pódcasts de YouTube"] .hit',{timeout:30000})
    const results=await page.evaluate(()=>({rss:document.querySelectorAll('[aria-label="Resultados de pódcasts"] .hit').length,
      youtube:document.querySelectorAll('[aria-label="Pódcasts de YouTube"] .hit').length,
      language:document.querySelector('select[aria-label="Idioma de los pódcasts"]').value}))
    assert.ok(results.rss>0&&results.youtube>0);assert.equal(results.language,'es')
    await capture('mobile-podcasts.png')
    return results
  })
  assert.ok(podcasts,'Real podcast results required')
  if(!onlyYouTube)await check('RSS detail renders 300 episodes and saving the show is durable',async()=>{
    await page.click('[aria-label="Resultados de pódcasts"] .hit[aria-label="Nadie Sabe Nada"]')
    await page.waitForSelector('.episodes .episode',{timeout:30000})
    const count=await page.$$eval('.episodes .episode',nodes=>nodes.length)
    assert.equal(count,300)
    await page.click('button.favorite[title="Guardar programa en Tus pódcasts"]')
    await page.waitForSelector('button.favorite[aria-pressed="true"]:not(:disabled)')
    return{episodeCount:count,title:await page.$eval('.hero h1',e=>e.textContent.trim())}
  })

  if(!args.includes('--skip-audio')&&!onlyYouTube)await check('RSS episode plays; seek/pause stores its resume position',async()=>{
    stage='RSS first episode gesture'
    const target=await safeClick('.episodes .episode:first-child .episode-play')
    stage='RSS audio starts and advances'
    await wait(()=>window.__parityAudio.some(a=>!a.paused&&a.currentTime>2),60000)
    let state=await snapshot();assert.equal(state.audio.length,1);assert.equal(state.audio[0].muted,false)
    await page.click('.mini button[aria-label="Sonando ahora"]')
    await page.waitForSelector('input[aria-label="Posición"]',{visible:true})
    await page.$eval('input[aria-label="Posición"]',e=>{e.value='45';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})
    await wait(()=>window.__parityAudio.some(a=>a.currentTime>=45&&a.currentTime<50),10000)
    await page.click('.transport button.play[title="Pausa (espacio)"]')
    await wait(()=>window.__parityAudio.every(a=>a.paused),5000)
    await page.evaluate(()=>history.back())
    await wait(()=>!document.querySelector('.np'),5000)
    assert.equal(await page.evaluate(()=>history.state.snapshot.stack[history.state.index].name),'podcast')
    await wait(()=>document.querySelector('.episodes .episode:first-child .listening-progress')?.textContent.includes('0:45')||document.querySelector('.episodes .episode:first-child .listening-progress')?.textContent.includes('0:46'),5000)
    return{audio:await snapshot(),seekThroughPositionControl:45,target}
  })

  await check('YouTube podcast detail opens as native episodes rather than an external link',async()=>{
    if(!onlyYouTube){await tab('Podcasts');await fillSearch('Buscar podcasts','Nadie sabe nada')}
    await page.waitForSelector('[aria-label="Pódcasts de YouTube"] .hit',{timeout:45000})
    await page.click('[aria-label="Pódcasts de YouTube"] .hit')
    await page.waitForSelector('.episodes .episode',{timeout:30000})
    const detail=await page.evaluate(()=>({title:document.querySelector('.hero h1').textContent.trim(),
      episodes:document.querySelectorAll('.episodes .episode').length,
      internalFeed:history.state.snapshot.stack[history.state.index].feedUrl?.startsWith('youtube:')??false}))
    assert.ok(detail.episodes>0);assert.equal(detail.internalFeed,true)
    await safeClick('.episodes .episode:first-child .add-queue[title="Más opciones"]')
    await page.waitForSelector('[role="menu"]')
    const before=await page.evaluate(()=>history.state.index)
    await page.evaluate(()=>history.back())
    await wait(()=>!document.querySelector('[role="menu"]'))
    assert.equal(await page.evaluate(()=>history.state.index),before)
    detail.backClosedMenu=true
    if(!args.includes('--skip-audio')){
      stage='YouTube episode gesture'
      await safeClick('.episodes .episode:first-child .episode-play')
      stage='YouTube episode audio advances'
      await wait(()=>window.__parityAudio.some(a=>!a.paused&&a.currentTime>2),60000)
      const state=await snapshot();assert.equal(state.audio.length,1);assert.equal(state.audio[0].muted,false)
      detail.audio=state.audio
      await page.click('.mini button[aria-label="Pausa"]')
      await wait(()=>window.__parityAudio.every(a=>a.paused),5000)
    }
    return detail
  })

  if(!args.includes('--podcast-only')&&!onlyYouTube){
  await check('CSV import uses real catalog matches and preserves repeated entries',async()=>{
    await tab('Tu biblioteca')
    await page.click('button.import')
    // Public URL success has its own real-provider canary in web-spotify.browser.mjs.
    if(!await page.$eval('details.csv',e=>e.open))await page.click('details.csv summary')
    const input=await page.$('#playlist-csv');await input.uploadFile(fileURLToPath(csv))
    await clickText('details.csv button','Buscar canciones del CSV')
    await page.waitForSelector('#playlist-name',{timeout:45000})
    const totals=await page.$$eval('.totals strong',nodes=>nodes.map(e=>e.textContent.trim()))
    assert.deepEqual(totals,['2','0'])
    await page.click('#playlist-name',{clickCount:3});await page.type('#playlist-name','QA CSV PWA 0.11.2')
    await clickText('.actions button','Guardar playlist')
    await wait(()=>document.querySelector('.hero h1')?.textContent.includes('QA CSV PWA 0.11.2'))
    const titles=await page.$$eval('.tracks li[data-reorder-index] .name',nodes=>nodes.map(e=>e.textContent.trim()))
    assert.deepEqual(titles,['Creep','Creep'])
    return{matches:totals,titles}
  })

  await check('downloads show browser storage without native folder controls in either layout',async()=>{
    await tab('Tu biblioteca');await clickText('.items .item','Descargas',false)
    await page.waitForSelector('.storage-note')
    assert.equal(await page.$('.folder'),null)
    await capture('mobile-downloads.png')
    await page.setViewport({width:1440,height:1000,isMobile:false,hasTouch:false,deviceScaleFactor:1})
    await page.waitForSelector('.app .sidebar')
    assert.equal(await page.$('.folder'),null)
    assert.ok((await page.$eval('.storage-note',e=>e.textContent)).includes('este navegador'))
    await page.setViewport({width:393,height:852,isMobile:true,hasTouch:true,deviceScaleFactor:1})
    return{nativeFolderControls:false}
  })
  }

  if(!onlyYouTube)await check('offline reload retains saved podcast detail and imported playlist metadata',async()=>{
    await page.setOfflineMode(true);await page.reload({waitUntil:'load',timeout:20000})
    await page.waitForSelector('.bottom-nav')
    if(!args.includes('--podcast-only')){
    await tab('Tu biblioteca')
    await wait(()=>[...document.querySelectorAll('.items .item')].some(e=>e.textContent.includes('QA CSV PWA 0.11.2')))
    await clickText('.items .item','QA CSV PWA 0.11.2',false)
    await page.waitForSelector('.tracks li[data-reorder-index="1"] .name')
    assert.equal(await page.$$eval('.tracks li[data-reorder-index]',nodes=>nodes.length),2)
    }
    await tab('Podcasts')
    await page.waitForSelector('[aria-label="Tus pódcasts"] .hit[aria-label="Nadie Sabe Nada"]',{timeout:15000})
    await page.click('[aria-label="Tus pódcasts"] .hit[aria-label="Nadie Sabe Nada"]')
    await page.waitForSelector('.episodes .episode',{timeout:20000})
    assert.equal(await page.$$eval('.episodes .episode',nodes=>nodes.length),300)
    if(!args.includes('--skip-audio'))assert.match(await page.$eval('.episodes .episode:first-child .listening-progress',e=>e.textContent),/Continuar desde 0:4[56]/)
    await capture('mobile-offline-podcast.png')
    return{online:await page.evaluate(()=>navigator.onLine),offlineMediaNotClaimed:true,state:await snapshot()}
  })
  }
}catch(error){report.fatal=scrub(error.message)}
finally{
  if(page&&!page.isClosed())report.finalState=await snapshot().catch(()=>null)
  report.finishedAt=new Date().toISOString();report.passed=!report.fatal&&report.checks.every(c=>c.pass)&&report.errors.length===0
  try{await writeFile(new URL(reportName,directory),JSON.stringify(report,null,2)+'\n')}
  finally{await Promise.allSettled([browser?.close(),server?new Promise(resolve=>server.close(resolve)):undefined])}
  console.log(`artifacts/pwa-parity/${reportName}: ${report.passed?'PASS':'FAIL'}`)
  if(!report.passed)process.exitCode=1
}
