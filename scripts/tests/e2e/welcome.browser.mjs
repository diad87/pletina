// Real compiled PWA welcome regression. No product modules or catalogue are mocked.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPwaServer } from '../../preview-pwa.mjs'

const args=process.argv.slice(2), option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback
const workspace=fileURLToPath(new URL('../../../',import.meta.url))
const temp=option('--temp','D:/tmp/pletina-welcome-release/browser-temp');await mkdir(temp,{recursive:true});process.env.TEMP=temp;process.env.TMP=temp
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync('D:/tmp/pletina-e2e-browsers'))process.env.PLAYWRIGHT_BROWSERS_PATH='D:/tmp/pletina-e2e-browsers'
const {chromium}=await import('playwright')
const dist=resolve(option('--dist',join(workspace,'dist-pwa'))), previous=resolve(option('--previous','D:/tmp/pletina-welcome-release/before-e6e79b96d898769a'))
const portable=resolve(option('--portable',join(workspace,'dist-pwa-portable/Pletina.html')))
const version=async path=>(await readFile(join(path,'sw.js'),'utf8')).match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
const build=await version(dist), previousBuild=await version(previous);assert.match(build??'',/^[a-f0-9]{16}$/)
const output=resolve(option('--output',`D:/tmp/pletina-welcome-release/run-${build}`));await mkdir(output,{recursive:true})
const summary={schemaVersion:1,build,previousBuild,startedAt:new Date().toISOString(),checks:[],errors:[],requests:[],screenshots:[],
scope:'Compiled PWA and native desktop Chromium, real service worker/IndexedDB/localStorage. Android/iPhone user-agent and standalone property are explicitly simulated. Library/queue migration uses declared metadata fixtures in isolated browser storage. No OS install, physical phone, car, provider audio or public deployment claim.',
physicalAndroidVerified:false,physicalIPhoneVerified:false,nativeInstallPromptVerified:false,published:false}
const uaAndroid='Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36'
const uaIPhone='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
let browser,server,baseURL,live='new',phase='',currentPage
const contexts=new Set()
const scrub=value=>String(value??'').replace(/https?:\/\/[^\s"'<>]+/g,'[URL]').slice(0,2400)
const save=()=>writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n')
async function check(name,action){phase=name;console.log(name+' ...');try{const details=await action();summary.checks.push({name,status:'pass',...details});console.log(name+': pass')}catch(error){const shot='failure-'+summary.checks.length+'.png';await currentPage?.screenshot({path:join(output,shot),fullPage:true}).catch(()=>{});summary.checks.push({name,status:'fail',error:scrub(error.message),screenshot:shot});console.log(name+': FAIL '+scrub(error.message))}await save()}
async function poll(read,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await read())return}catch(error){if(!/Execution context was destroyed|Cannot find context/i.test(error.message))throw error}await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Timed out waiting for resolved browser state')}
async function pageFor({userAgent=uaAndroid,standalone=false,viewport={width:390,height:844}}={}){
const context=await browser.newContext({viewport,userAgent,isMobile:true,hasTouch:true,deviceScaleFactor:1,serviceWorkers:'allow'});contexts.add(context)
await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===new URL(baseURL).origin||url.protocol==='file:'||url.protocol==='data:'?route.continue():route.abort('blockedbyclient')})
await context.addInitScript(()=>{addEventListener('beforeinstallprompt',event=>{if(event.isTrusted)event.stopImmediatePropagation()},{capture:true})})
if(standalone){
const observations=[];summary.standaloneObservations=observations
await context.exposeBinding('__qaWelcomePaint',(_source,value)=>observations.push(value))
await context.addInitScript(()=>{
if(window!==top)return
Object.defineProperty(navigator,'standalone',{configurable:true,get:()=>true})
if(!/\/application\//.test(location.pathname)){
void globalThis.__qaWelcomePaint({type:'initial',opened:localStorage.getItem('pletina:web:opened')})
let frames=0;const sample=()=>{const visible=[...document.querySelectorAll('#install,#open-player,#apply-update')].filter(node=>node.getClientRects().length).map(node=>node.id);void globalThis.__qaWelcomePaint({type:'frame',visible});if(++frames<60)requestAnimationFrame(sample)};requestAnimationFrame(sample)
}
})}
const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);currentPage=page
page.on('pageerror',error=>summary.errors.push({phase,name:error.name,message:scrub(error.message)}))
return{page,context,close:async()=>{await context.close();contexts.delete(context)}}
}
const settle=page=>page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})
async function landing(page){await page.goto(baseURL,{waitUntil:'load'});await page.locator('#home-screen').waitFor();await poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller)));assert.equal((await page.locator('#version').textContent()).trim(),live==='new'?build:previousBuild);await settle(page)}
async function shot(page,name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});summary.screenshots.push(name+'.png');return name+'.png'}
async function noApplicationCached(page){return page.evaluate(async()=>{const found=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())if(new URL(request.url).pathname.includes('/application/'))found.push(new URL(request.url).pathname);return found})}
async function geometry(page){return page.evaluate(()=>{
const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
const rgb=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number)
const luminance=color=>rgb(color).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
const screen=document.querySelector('#home-screen'),background=getComputedStyle(screen).backgroundColor
const contrastOf=node=>{let ancestor=node,bg=getComputedStyle(node).backgroundColor;while(/rgba\([^)]*,\s*0\)$|transparent/.test(bg)&&ancestor.parentElement){ancestor=ancestor.parentElement;bg=getComputedStyle(ancestor).backgroundColor}return contrast(getComputedStyle(node).color,bg)}
return{viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,screen:{...box(screen),scrollWidth:screen.scrollWidth,clientWidth:screen.clientWidth},background,color:getComputedStyle(screen).color,font:getComputedStyle(screen).fontFamily,fontReady:document.fonts.check('16px Figtree'),
headings:[...document.querySelectorAll('h1,h2')].filter(node=>node.getClientRects().length).map(node=>({tag:node.tagName,text:node.textContent.trim()})),
headingBeforeIntro:Boolean(document.querySelector('#headline').compareDocumentPosition(document.querySelector('#intro'))&Node.DOCUMENT_POSITION_FOLLOWING),
record:box(document.querySelector('.record-art')),sleeve:box(document.querySelector('.record-sleeve')),vinyl:box(document.querySelector('.vinyl')),headline:box(document.querySelector('#headline')),
controls:[...document.querySelectorAll('#home-screen button,#home-screen summary')].filter(node=>node.getClientRects().length).map(node=>({id:node.id,label:node.textContent.trim(),...box(node),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,contrast:contrastOf(node)})),
textContrast:['#intro','.trust','#status','.welcome-footer>p'].map(selector=>{const node=document.querySelector(selector);return{selector,contrast:contrastOf(node)}})}
})}
function assertGeometry(value){assert.ok(value.documentWidth<=value.viewport.width+1,'No horizontal document overflow');assert.ok(value.screen.x>=-1&&value.screen.right<=value.viewport.width+1&&value.screen.scrollWidth<=value.screen.clientWidth+1,'Welcome fits its width');assert.ok(Math.max(value.sleeve.bottom,value.vinyl.bottom)<value.headline.y,'Record does not overlap the headline');assert.equal(value.headings.length,1);assert.match(value.headings[0].text,/Dale\s*al play\./);assert.equal(value.headingBeforeIntro,true);assert.ok(value.fontReady);for(const control of value.controls){assert.ok(control.width>=44&&control.height>=44,control.label+':44px touch target');assert.ok(control.scrollWidth<=control.clientWidth+1,control.label+':text fits');assert.ok(control.contrast>=4.5,control.label+':readable contrast')}for(const text of value.textContrast)assert.ok(text.contrast>=4.5,text.selector+':readable contrast')}
async function database(page){return page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('pletina-web-library');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,stores=['tracks','likes','playlists','entries','progress','episodes','meta'],values={};const tx=db.transaction(stores,'readonly');for(const name of stores){const get=tx.objectStore(name).getAll();get.onsuccess=()=>values[name]=get.result}tx.oncomplete=()=>{db.close();resolve(values)};tx.onabort=()=>{db.close();reject(tx.error)}}}))}
const queueFields=value=>{const{savedAt,...fields}=value;return fields}
try{
const servers={new:createPwaServer({directory:dist}),old:createPwaServer({directory:previous})}
server=createServer((request,response)=>{summary.requests.push({phase,version:live,method:request.method,path:new URL(request.url,'http://localhost').pathname});servers[live].emit('request',request,response)})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});baseURL=`http://127.0.0.1:${server.address().port}/pletina/`
browser=await chromium.launch({headless:true,executablePath:option('--chrome','C:/Program Files/Google/Chrome/Application/chrome.exe'),args:['--mute-audio']});summary.browserVersion=browser.version()
await check('welcome.application-assets-unchanged',async()=>{
const assets=async path=>JSON.parse((await readFile(join(path,'sw.js'),'utf8')).match(/const OPTIONAL = (\[[^\n]+\])/)[1]).filter(file=>file.url.startsWith('application/'))
const before=await assets(previous),after=await assets(dist);assert.deepEqual(after,before,'The current application JavaScript/CSS/fonts must remain identical; only welcome changes');return{applicationAssetsCompared:after.length,previousBuild,build}
})
await check('welcome.first-visit-layout-lazy-loading-and-contrast',async()=>{
const env=await pageFor();try{const{page}=env;await landing(page);const sizes=[{width:320,height:844},{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:1280,height:900}],layouts=[]
for(const size of sizes){await page.setViewportSize(size);await settle(page);const value=await geometry(page);assertGeometry(value);layouts.push({...value,screenshot:await shot(page,`welcome-${size.width}x${size.height}`)})}
await page.emulateMedia({colorScheme:'light'});const light=await geometry(page);assert.equal(light.background,layouts[0].background);assert.equal(light.color,layouts[0].color)
assert.equal(await page.locator('#install').textContent(),'Instalar Pletina');assert.equal(await page.locator('#open-player').textContent(),'Probar sin instalar')
assert.deepEqual(await noApplicationCached(page),[]);assert.equal(summary.requests.filter(row=>row.phase===phase&&row.path.includes('/application/')).length,0)
return{layouts,applicationRequestsBeforeOpen:0,cachedApplicationFiles:0,fixedDarkInLightHost:true}
}finally{await env.close()}})
await check('welcome.android-guide-and-controlled-prompt-fallbacks',async()=>{
const env=await pageFor();try{const{page}=env;await landing(page);await page.locator('#install-help').click();await page.locator('#install-guide[open]').waitFor();assert.match(await page.locator('#install-guide').textContent(),/Android|Instalar aplicación/);await shot(page,'guide-android');await page.locator('#close-guide').click()
const prompts=[];for(const outcome of['reject','dismissed']){
await page.evaluate(outcome=>{const event=new Event('beforeinstallprompt',{cancelable:true});window.__qaPromptCalls=0;event.prompt=async()=>{window.__qaPromptCalls++;if(outcome==='reject')throw new Error('Controlled denied native prompt')};event.userChoice=Promise.resolve({outcome:'dismissed',platform:'web'});dispatchEvent(event)},outcome)
await page.locator('#install').click();await poll(()=>page.evaluate(()=>!document.querySelector('#install').disabled));assert.equal(await page.evaluate(()=>window.__qaPromptCalls),1)
if(outcome==='reject'){await page.locator('#install-guide[open]').waitFor();await page.locator('#close-guide').click()}else assert.equal(await page.locator('#install-guide[open]').count(),0)
prompts.push({outcome,promptCalls:1})}
assert.equal(summary.requests.filter(row=>row.phase===phase&&row.path.includes('/application/')).length,0);return{manualGuide:true,controlledPrompts:prompts,nativeOSPromptClaimed:false}
}finally{await env.close()}})
await check('welcome.iphone-guide-and-first-visit-open-current-app',async()=>{
const env=await pageFor({userAgent:uaIPhone,viewport:{width:320,height:844}});try{const{page}=env;await landing(page);await page.locator('#install-help').click();await page.locator('#install-guide[open]').waitFor();const guide=await page.locator('#install-guide').textContent();for(const text of['Safari','Compartir','Añadir a pantalla de inicio'])assert.ok(guide.includes(text));await shot(page,'guide-iphone-320');await page.locator('#close-guide').click()
assert.equal(summary.requests.filter(row=>row.phase===phase&&row.path.includes('/application/')).length,0)
await Promise.all([page.waitForURL(/\/application\/index\.[a-f0-9]{16}\.html$/),page.locator('#open-player').click()]);await page.locator('.app').waitFor();assert.equal(await page.locator('.bottom-nav').isVisible(),true);assert.equal(await page.locator('[data-application],[data-app-tab],.p-app-nav').count(),0);return{guideVerified:true,applicationPath:new URL(page.url()).pathname,actualExistingApplication:true,userAgentEmulationOnly:true,screenshot:await shot(page,'opened-current-app-iphone-layout')}
}finally{await env.close()}})
await check('welcome.confirmed-install-event-opens-app-without-another-cta',async()=>{
const env=await pageFor();try{const{page}=env;await landing(page);const openedBefore=await page.evaluate(()=>localStorage.getItem('pletina:web:opened'));assert.equal(openedBefore,null)
const transition=await page.evaluate(()=>{dispatchEvent(new Event('appinstalled'));return{homeHidden:document.querySelector('#home-screen').hidden,visibleCTAs:[...document.querySelectorAll('#install,#open-player,#apply-update')].filter(node=>node.getClientRects().length).map(node=>node.id),autoLaunching:document.documentElement.hasAttribute('data-auto-launch')}})
assert.equal(transition.homeHidden,true);assert.deepEqual(transition.visibleCTAs,[]);assert.equal(transition.autoLaunching,true)
await page.waitForURL(/\/application\/index\.[a-f0-9]{16}\.html$/);await page.locator('.app').waitFor();assert.equal(await page.locator('.bottom-nav').isVisible(),true)
return{syntheticAppInstalledEvent:true,nativeOSInstallationClaimed:false,openedFlagBefore:openedBefore,transition,applicationPath:new URL(page.url()).pathname,screenshot:await shot(page,'confirmed-install-auto-open')}
}finally{await env.close()}})
await check('welcome.standalone-auto-opens-without-opened-flag-or-visible-ctas',async()=>{
const env=await pageFor({standalone:true});try{const{page}=env;try{await page.goto(baseURL,{waitUntil:'load'})}catch(error){if(!/interrupted by another navigation|net::ERR_ABORTED/.test(error.message))throw error}await page.waitForURL(/\/application\/index\.[a-f0-9]{16}\.html$/);await page.locator('.app').waitFor();assert.equal(summary.standaloneObservations.find(value=>value.type==='initial')?.opened,null);assert.ok(summary.standaloneObservations.filter(value=>value.type==='frame').every(value=>value.visible.length===0),'No welcome CTA may be painted before automatic opening');assert.equal(await page.locator('#install:visible,#open-player:visible,#apply-update:visible').count(),0)
return{syntheticNavigatorStandalone:true,openedFlagBefore:null,paintFramesObserved:summary.standaloneObservations.filter(value=>value.type==='frame').length,visibleWelcomeCTAs:0,applicationPath:new URL(page.url()).pathname,physicalInstallationClaimed:false,screenshot:await shot(page,'standalone-auto-open')}
}finally{await env.close()}})
await check('welcome.portable-file-renders-without-application-network',async()=>{
const env=await pageFor();try{const{page}=env;await page.goto(pathToFileURL(portable).href,{waitUntil:'load'});await page.locator('#headline').waitFor();await settle(page);assert.equal(await page.locator('html[data-portable]').count(),1);assert.equal(await page.locator('#install').isVisible(),false);assert.equal(await page.locator('#open-player').isVisible(),false);assert.equal(await page.locator('link[rel="manifest"]').count(),0);assert.match(await page.locator('#status').textContent(),/Archivo local|sin servidor/);assertGeometry(await geometry(page));return{fileProtocol:true,selfContainedFont:true,applicationOpened:false,screenshot:await shot(page,'portable-file')}
}finally{await env.close()}})
await check('welcome.update-e6e-preserves-real-indexeddb-and-paused-queue',async()=>{
live='old';const env=await pageFor({viewport:{width:1280,height:900}});try{const{page,context}=env;await landing(page);await Promise.all([page.waitForURL(/\/application\/index\.[a-f0-9]{16}\.html$/),page.locator('#open-player').click()]);await page.locator('.app .sidebar').waitFor();await page.locator('.sidebar button[title="Crear playlist"]').click();const name='QA bienvenida conserva biblioteca';await page.getByRole('textbox',{name:'Nombre de la playlist',exact:true}).fill(name);await page.getByRole('textbox',{name:'Nombre de la playlist',exact:true}).press('Enter');await poll(async()=>Object.values(await database(page)).some(rows=>Array.isArray(rows)&&rows.some(row=>row.name===name)))
const track={id:901,title:'Canción QA bienvenida',duration:180,explicit:false,artistId:1,artistName:'Artista QA',albumId:1,albumTitle:'Disco QA',albumArtistId:1,cover:null},item={track:{id:901,title:track.title,duration:180,artist:{id:1,name:track.artistName},titleVersion:null,trackPosition:1,diskNumber:1,explicitLyrics:false,isrc:null},albumId:1,albumTitle:track.albumTitle,artistId:1,cover:null}
const queue={version:1,savedAt:Date.now(),queue:[item,item],order:[1,0],pos:0,context:name,userQueue:[{key:1,item}],manual:null,position:37,duration:180,repeat:'all',shuffle:true,recorded:true}
await page.evaluate(({track,name})=>new Promise((resolve,reject)=>{const request=indexedDB.open('pletina-web-library');request.onsuccess=()=>{const db=request.result,tx=db.transaction(['tracks','entries','likes','playlists'],'readwrite');const lists=tx.objectStore('playlists').getAll();lists.onsuccess=()=>{const playlist=lists.result.find(row=>row.name===name);tx.objectStore('tracks').put(track);tx.objectStore('likes').put({trackId:track.id,at:1700000000,order:2});for(const position of[0,1])tx.objectStore('entries').add({playlistId:playlist.id,trackId:track.id,position,at:1700000000})};tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>{db.close();reject(tx.error)}};request.onerror=()=>reject(request.error)}),{track,name})
await context.addInitScript(queue=>{if(location.pathname.includes('/application/')&&localStorage.getItem('qa:welcome:seed-queue')==='1'){localStorage.setItem('pletina:web:queue:v1',JSON.stringify(queue));localStorage.removeItem('qa:welcome:seed-queue')}},queue);await page.evaluate(()=>localStorage.setItem('qa:welcome:seed-queue','1'));await page.reload({waitUntil:'load'});await page.locator('.app').waitFor();await page.waitForFunction(title=>navigator.mediaSession?.metadata?.title===title,track.title);const beforeDatabase=await database(page),beforeQueue=queueFields(await page.evaluate(()=>JSON.parse(localStorage.getItem('pletina:web:queue:v1'))));assert.equal(beforeQueue.position,37)
live='new';await page.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration()).update()});await poll(()=>page.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistration())?.waiting)));await page.locator('.web-update button').waitFor();await Promise.all([page.waitForNavigation({waitUntil:'load'}),page.locator('.web-update button').click()]);await page.locator('.app').waitFor();await poll(()=>page.evaluate(async build=>(await caches.keys()).some(name=>name.startsWith('pletina-pwa:')&&name.endsWith(':'+build)),build));assert.deepEqual(await database(page),beforeDatabase);assert.deepEqual(queueFields(await page.evaluate(()=>JSON.parse(localStorage.getItem('pletina:web:queue:v1')))),beforeQueue);assert.equal(await page.evaluate(()=>navigator.mediaSession.playbackState),'paused')
await context.setOffline(true);await page.reload({waitUntil:'load'});await page.locator('.app').waitFor();assert.deepEqual(await database(page),beforeDatabase);assert.deepEqual(queueFields(await page.evaluate(()=>JSON.parse(localStorage.getItem('pletina:web:queue:v1')))),beforeQueue)
return{previousBuild,build,scopePreserved:true,playlistCreatedByUI:name,seededMetadataTrackId:track.id,duplicateEntries:2,queueEntries:beforeQueue.queue.length,djEntries:beforeQueue.userQueue.length,position:beforeQueue.position,pausedQueuePreserved:true,realServiceWorkerUpdate:true,offlineReload:true,providerAudioClaimed:false,screenshot:await shot(page,'updated-existing-app-offline')}
}finally{live='new';await env.close()}})
}catch(error){summary.errors.push({phase,message:scrub(error.message)})}finally{
for(const context of contexts)await context.close().catch(()=>{});await browser?.close().catch(()=>{});if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});summary.finishedAt=new Date().toISOString();summary.browserClosed=!browser?.isConnected();summary.serverClosed=!server?.listening;summary.counts=Object.fromEntries(['pass','fail'].map(status=>[status,summary.checks.filter(check=>check.status===status).length]));summary.passed=summary.checks.length===8&&summary.checks.every(check=>check.status==='pass')&&summary.errors.length===0;await save();console.log(JSON.stringify({output,build,counts:summary.counts,errors:summary.errors,passed:summary.passed},null,2));if(!summary.passed)process.exitCode=1
}
