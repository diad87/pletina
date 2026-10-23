import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const code = ts.transpileModule(await readFile(new URL('../../web-port/funkwhale-audio.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const api = {}
new Function('exports','require',code)(api, path => path === './funkwhale' ? {
  rankFunkwhaleCandidates: values => [...values].sort((a,b) => b.bitrate-a.bitrate),
} : {})
const query = {id:123, isrc:'GBKPL1370800', title:'Exact song', titleVersion:'', artist:'Artist', album:'Album', duration:100}
const bytes = new TextEncoder().encode('Synthetic audio integrity fixture only')
const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('')
const deferred = () => {let resolve; const promise=new Promise(yes=>resolve=yes); return {promise,resolve}}
function fixture(overrides={}) {
  const entries = [1,2,3].map(id=>({catalog:{...query,id:id+122}, source:{uploadUuid:'upload'+id},
    file:{bytes:bytes.length,sha256:sha,mime:'audio/mpeg',durationSeconds:100}}))
  const candidates = entries.map((e,i)=>({uploadUuid:e.source.uploadUuid, bitrate:320000-i*1000, contentLength:bytes.length, mime:'audio/mpeg'}))
  const calls=[],created=[],revoked=[]
  const entriesFor=track=>entries.filter(e=>e.catalog.id===track.id && e.catalog.isrc===track.isrc && e.catalog.title===track.title && e.catalog.titleVersion===(track.titleVersion??''))
  const instance=api.createFunkwhaleAudioResolver({
    hasCatalogId:id=>entries.some(e=>e.catalog.id===id),
    hydrate:async track=>{calls.push('hydrate');return {...track,isrc:track.isrc??query.isrc}},
    entries:entriesFor,
    match:(track,candidate,entry)=>entriesFor(track).includes(entry) && candidate.uploadUuid===entry.source.uploadUuid,
    discover:async track=>{calls.push('discover');return candidates.filter(c=>entriesFor(track).some(e=>e.source.uploadUuid===c.uploadUuid))},
    load:async candidate=>{calls.push(candidate.uploadUuid);return {bytes,sha256:sha,mime:'audio/mpeg'}},
    createObjectURL:blob=>{created.push(blob);return 'blob:https://pwa.example/'+created.length},
    revokeObjectURL:url=>revoked.push(url),...overrides,
  })
  return {...instance,entries,candidates,calls,created,revoked}
}

test('unknown and changed identities perform no media request and a verified file becomes those exact Blob bytes',async()=>{
  const h=fixture()
  assert.equal(await h.resolve({...query,id:999}),null)
  assert.deepEqual(h.calls,[])
  assert.equal(await h.resolve({...query,title:'Same-title cover'}),null)
  assert.ok(!h.calls.includes('discover'))
  const source=await h.resolve({...query,isrc:null})
  assert.equal(source.source.provider,'funkwhale')
  assert.equal(source.source.download.allowed,false)
  assert.equal(source.source.download.sha256,sha)
  assert.equal(source.videoId,'')
  assert.deepEqual(new Uint8Array(await h.created[0].arrayBuffer()),bytes)
  assert.equal('url' in source.source,false)
  const before=h.calls.length
  assert.equal((await h.resolve({...query,isrc:null})).url,source.url)
  assert.equal(h.calls.length,before,'repeat may use the checked RAM copy without network')
  assert.equal(await h.resolve({...query,isrc:'GBSMU2086183'}),null)
  h.dispose()
  assert.deepEqual(h.revoked,[source.url])
})

test('size, hash and MIME changes are rejected before creating an audio URL',async()=>{
  for(const changed of [{bytes:new Uint8Array(bytes.length-1)},{sha256:'0'.repeat(64)},{mime:'audio/ogg'}]) {
    const h=fixture({load:async()=>({bytes,sha256:sha,mime:'audio/mpeg',...changed})})
    await assert.rejects(h.resolve(query),/no coincide/)
    assert.deepEqual(h.created,[])
    h.dispose()
  }
})

test('an unverified candidate is not downloaded and a failed best encoding can try another approved encoding',async()=>{
  let calls=0
  const h=fixture({discover:async()=>[{uploadUuid:'unverified',bitrate:999999}],load:async()=>{calls++;throw Error('must not load')}})
  assert.equal(await h.resolve(query),null)
  assert.equal(calls,0)
  const g=fixture({discover:async()=>[{uploadUuid:'bad',bitrate:999999},{uploadUuid:'upload1',bitrate:320000}],
    match:(_track,candidate)=>candidate.uploadUuid==='bad'||candidate.uploadUuid==='upload1',
    load:async candidate=>{if(candidate.uploadUuid==='bad')throw Error('Encoding unavailable');return{bytes,sha256:sha,mime:'audio/mpeg'}}})
  assert.ok((await g.resolve(query)).url.startsWith('blob:'))
  assert.equal(g.created.length,1)
  g.dispose()
})

test('LRU eviction preserves both the playing and prepared sources; retain alone never revokes during handoff',async()=>{
  const h=fixture({cacheBytes:bytes.length*2})
  const first=await h.resolve(query),next=await h.resolve({...query,id:124})
  h.retain([first.url,next.url])
  await assert.rejects(h.resolve({...query,id:125}),/espacio/)
  assert.deepEqual(h.revoked,[])
  h.retain([first.url])
  assert.deepEqual(h.revoked,[],'clearPrepared must not revoke its locally captured source')
  h.retain([next.url])
  assert.deepEqual(h.revoked,[])
  await h.resolve({...query,id:125})
  assert.deepEqual(h.revoked,[first.url])
  assert.equal((await h.resolve({...query,id:124})).url,next.url)
  h.dispose()
  assert.equal(h.revoked.length,3)
})

test('cancel, dispose and the global deadline prevent a late provider from creating a Blob',async()=>{
  for(const kind of ['abort','dispose','timeout']) {
    const gate=deferred(),started=deferred(),controller=new AbortController()
    const h=fixture({timeout:kind==='timeout'?10:1000,load:async()=>{started.resolve();await gate.promise;return{bytes,sha256:sha,mime:'audio/mpeg'}}})
    const pending=h.resolve(query,controller.signal)
    const rejected=assert.rejects(pending,{name:kind==='timeout'?'TimeoutError':'AbortError'})
    await started.promise
    if(kind==='abort')controller.abort(new DOMException('Stop','AbortError'))
    if(kind==='dispose')h.dispose()
    await rejected
    gate.resolve()
    await new Promise(resolve=>setTimeout(resolve,0))
    assert.deepEqual(h.created,[],kind)
    h.dispose()
  }
})

test('at most two acquisitions run concurrently, with one shared URL for the same checked file',async()=>{
  const gate=deferred(),started=deferred();let count=0
  const h=fixture({load:async()=>{if(++count===2)started.resolve();await gate.promise;return{bytes,sha256:sha,mime:'audio/mpeg'}}})
  const one=h.resolve(query),two=h.resolve(query)
  await started.promise
  await assert.rejects(h.resolve({...query,id:125}),/otras grabaciones/)
  gate.resolve()
  assert.equal((await one).url,(await two).url)
  assert.equal(h.created.length,1)
  h.dispose()
})
