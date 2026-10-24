// Standalone browser-network-event diagnostic. No Pletina modules or APIs.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const args=process.argv.slice(2), option=(n,d)=>args.includes(n)?args[args.indexOf(n)+1]:d
if(option('--browsers',null)) process.env.PLAYWRIGHT_BROWSERS_PATH=option('--browsers')
const {firefox}=await import('playwright')
const output=resolve(option('--output','artifacts/pwa-e2e/firefox-online-event-control-c2a70158ef06a3d5-win.json'))
const document=`<!doctype html><title>Standalone native online event control</title><h1>Native online event control</h1><script>window.events=[{type:'initial',online:navigator.onLine}];for(const type of ['online','offline'])addEventListener(type,event=>events.push({type,online:navigator.onLine,trusted:event.isTrusted}));navigator.serviceWorker.register('/worker.js').then(()=>navigator.serviceWorker.ready)</script>`
const worker=`self.addEventListener('install',e=>e.waitUntil(caches.open('qa-network-events').then(c=>c.add('/control.html')).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/control.html')e.respondWith(caches.match('/control.html'))})`
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':req.url==='/worker.js'?'text/javascript':'text/html','cache-control':'no-store'});res.end(req.url==='/worker.js'?worker:document)})
const report={scope:'Standalone native Firefox network-event control. Minimal QA-only cache worker and event logger; no Pletina code, navigator/event overrides, dispatchEvent, external providers or physical-device claim.',startedAt:new Date().toISOString(),host:{platform:process.platform,node:process.version},cases:[],errors:[]}
let browser
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await firefox.launch({headless:true});report.browserVersion=browser.version()
 for(const clock of [false,true]){
  const context=await browser.newContext({serviceWorkers:'allow'}),page=await context.newPage();page.on('pageerror',e=>report.errors.push({name:e.name,message:e.message}));if(clock)await page.clock.install()
  try{
   const url='http://127.0.0.1:'+server.address().port+'/control.html';await page.goto(url);await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller))
   const sample=async phase=>{await new Promise(r=>setTimeout(r,200));return{phase,...await page.evaluate(()=>({online:navigator.onLine,events:window.events}))}}
   await context.setOffline(true);report.cases.push({clock,...await sample('same-document-offline')})
   await context.setOffline(false);report.cases.push({clock,...await sample('same-document-online')})
   await context.setOffline(true);await page.reload({waitUntil:'load'});report.cases.push({clock,...await sample('offline-reloaded')})
   await context.setOffline(false);report.cases.push({clock,...await sample('offline-reload-then-online')})
  }finally{await context.close()}
 }
 report.nativeOnlineEventMissingAfterOfflineReload=report.cases.filter(c=>c.phase==='offline-reload-then-online').every(c=>c.online&&!c.events.some(e=>e.type==='online'))
 report.documentUnreloadedControlsHaveTrustedOnline=report.cases.filter(c=>c.phase==='same-document-online').every(c=>c.events.some(e=>e.type==='online'&&e.trusted))
 assert.equal(report.errors.length,0)
}finally{
 await browser?.close();report.browserClosed=true;server.closeAllConnections();await new Promise(r=>server.close(r));report.serverClosed=true;report.finishedAt=new Date().toISOString();await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n')
}
console.log(JSON.stringify(report))
