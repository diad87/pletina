// Browser parser/storage integration and one real RSS; no application UI or audio playback.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
const require = createRequire(import.meta.url)
const puppeteer = require(process.argv[2] || 'puppeteer')
const directory = new URL('../../artifacts/pwa-podcasts/', import.meta.url)
await mkdir(directory, { recursive: true })
const report = { testedAt: new Date().toISOString(), scope: 'Isolated Chrome desktop real DOMParser, IndexedDB and public RSS; not a phone playback proof' }
let server,browser
try {
  server = await createServer({ root:fileURLToPath(new URL('../../',import.meta.url)),configFile:false,
    server:{host:'127.0.0.1',port:0},plugins:[{name:'podcast-parser-qa',configureServer(instance){
      instance.middlewares.use((request,response,next)=>{
        if(request.url!=='/__podcast_qa')return next()
        response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Podcast module QA</title><body>Parser QA</body>')
      })
    }}] })
  await server.listen()
  browser=await puppeteer.launch({headless:true,...(process.argv[3]?{executablePath:process.argv[3]}:{})})
  const page=await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__podcast_qa`)
  report.result=await page.evaluate(async()=>{
    const api=await import('/web-port/podcasts.ts')
    const storage=await import('/web-port/storage.ts')
    const xml=`<?xml version="1.0" encoding="UTF-8"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
      <title>Ciencia &amp; café</title><language>es-ES</language><itunes:author>María</itunes:author>
      <description><![CDATA[<p>Ideas &amp; ciencia.</p>]]></description><itunes:image href="/cover.jpg"/><itunes:explicit>yes</itunes:explicit>
      <item><title>Uno</title><guid>stable-guid</guid><pubDate>Wed, 07 Oct 2026 08:00:00 GMT</pubDate><itunes:duration>1:02:03</itunes:duration><itunes:explicit>no</itunes:explicit><enclosure url="https://audio.example/one.mp3?x=1&amp;y=2" type="audio/mpeg"/></item>
      <item><title>Duplicado</title><guid>stable-guid</guid><enclosure url="https://audio.example/one.mp3" type="audio/mpeg"/></item>
      <item><title>Vídeo</title><enclosure url="https://audio.example/video.mp4" type="video/mp4"/></item>
      <item><title>Dos</title><itunes:duration>95</itunes:duration><enclosure url="/two.m4a"/></item>
      <item><title>Inseguro</title><enclosure url="file:///private.mp3" type="audio/mpeg"/></item>
    </channel></rss>`
    const fixture=api.parseRSS(xml,'https://redirect.example/rss','https://original.example/feed')
    const rejected=[]
    for(const input of ['<rss><channel>', '<html/>', '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]><rss><channel><title>&x;</title></channel></rss>']) {
      try{api.parseRSS(input,'https://feed.example/rss');rejected.push(false)}catch{rejected.push(true)}
    }
    const saved=await storage.savePodcastDetail(fixture)
    const repeated=await storage.savePodcastDetail(fixture)
    const firstRead=await storage.readPodcastEpisode(saved.episodes[0].id)
    const fetched=await api.detail('https://fapi-top.prisasd.com/podcast/playser/nadie_sabe_nada/itunestfp/podcast.xml')
    const again=await api.detail(fetched.podcast.feedUrl)
    const search=await api.search('Nadie sabe nada','es')
    if(!search.podcasts.some(show=>show.title==='Nadie Sabe Nada'))throw new Error('Real aggregate search did not return the expected RSS show')
    if(!search.youtube.length)throw new Error('Real aggregate search did not return YouTube shows')
    const yt=await api.detail((search.youtube[1]||search.youtube[0]).feedUrl)
    const ytAgain=await storage.readPodcastDetail(yt.podcast.feedUrl)
    const lookup=await api.requestApple('lookup',{id:'665143133',entity:'podcastEpisode',country:'ES',limit:'5'})
    const apple=api.appleDetail(lookup,{appleId:665143133,feedUrl:fetched.podcast.feedUrl,title:fetched.podcast.title,author:fetched.podcast.author,image:fetched.podcast.image})
    const originalFirst=await storage.readPodcastEpisode(fetched.episodes[0].id)
    const controller=new AbortController();controller.abort()
    let abortName=''
    try{await api.requestFeed(fetched.podcast.feedUrl,{signal:controller.signal})}catch(error){abortName=error.name}
    return {
      fixture:{title:fixture.podcast.title,language:fixture.podcast.language,description:fixture.podcast.description,
        feedUrl:fixture.podcast.feedUrl,image:fixture.podcast.image,
        episodes:fixture.episodes.map(({guid,title,duration,audioUrl,explicit})=>({guid,title,duration,audioUrl,explicit}))},
      rejected,stableShowId:saved.podcast.id===repeated.podcast.id,stableEpisodeIds:saved.episodes.every((ep,index)=>ep.id===repeated.episodes[index].id),
      storedEpisode:{id:firstRead.id,guid:firstRead.guid,podcastId:firstRead.podcastId,feedUrl:firstRead.feedUrl},
      real:{title:fetched.podcast.title,language:fetched.podcast.language,showId:fetched.podcast.id,
        episodeCount:fetched.episodes.length,first:fetched.episodes.slice(0,2).map(({id,title,duration,audioUrl})=>({id,title,duration,audioHost:new URL(audioUrl).hostname})),
        allHTTPS:fetched.episodes.every(ep=>ep.audioUrl.startsWith('https://')),stableIds:again.episodes.every((ep,index)=>ep.id===fetched.episodes[index].id)},
      search:{rssCount:search.podcasts.length,youtubeCount:search.youtube.length,failedFeeds:search.failedFeeds,
        rss:search.podcasts.slice(0,5).map(({id,title,language})=>({id,title,language})),allRSSLanguagesMatch:search.podcasts.every(show=>show.language==='es')},
      youtube:{title:yt.podcast.title,showId:yt.podcast.id,episodes:yt.episodes.length,
        first:yt.episodes.slice(0,2).map(({id,title,audioUrl})=>({id,title,videoId:audioUrl.slice('youtube:'.length)})),
        allVideoIds:yt.episodes.every(ep=>/^youtube:[A-Za-z0-9_-]{11}$/.test(ep.audioUrl)),cachedIdsStable:ytAgain.episodes.every((ep,index)=>ep.id===yt.episodes[index].id)},
      appleFallback:{episodes:apple.episodes.length,language:apple.podcast.language,
        firstGUIDMatchesRSS:apple.episodes[0]?.guid===originalFirst.guid,
        audioHosts:[...new Set(apple.episodes.map(ep=>new URL(ep.audioUrl).hostname))]},
      abortName,remainingFrames:document.querySelectorAll('iframe').length,
    }
  })
  const result=report.result
  assert.equal(result.fixture.title,'Ciencia & café');assert.equal(result.fixture.language,'es')
  assert.equal(result.fixture.description,'Ideas & ciencia.');assert.equal(result.fixture.feedUrl,'https://original.example/feed')
  assert.equal(result.fixture.image,'https://redirect.example/cover.jpg');assert.equal(result.fixture.episodes.length,2)
  assert.equal(result.fixture.episodes[0].duration,3723);assert.equal(result.fixture.episodes[0].explicit,false)
  assert.equal(result.fixture.episodes[1].duration,95);assert.equal(result.fixture.episodes[1].explicit,true)
  assert.equal(result.fixture.episodes[1].audioUrl,'https://redirect.example/two.m4a')
  assert.ok(result.rejected.every(Boolean));assert.ok(result.stableShowId&&result.stableEpisodeIds)
  assert.ok(result.storedEpisode.id>=750_000_000_000_000)
  assert.equal(result.real.title,'Nadie Sabe Nada');assert.equal(result.real.language,'es')
  assert.equal(result.real.episodeCount,300);assert.ok(result.real.allHTTPS&&result.real.stableIds)
  assert.ok(result.search.rssCount>0&&result.search.youtubeCount>0&&result.search.allRSSLanguagesMatch)
  assert.ok(result.youtube.episodes>0&&result.youtube.allVideoIds&&result.youtube.cachedIdsStable)
  assert.equal(result.appleFallback.episodes,5);assert.equal(result.appleFallback.language,null)
  assert.ok(result.appleFallback.firstGUIDMatchesRSS)
  assert.equal(result.abortName,'AbortError');assert.equal(result.remainingFrames,0)
  report.passed=true;report.browser=await browser.version()
}catch(error){report.passed=false;report.error=String(error.message).replace(/https?:\/\/[^\s]+/g,'[URL]');process.exitCode=1}
finally{
  await writeFile(new URL('module-browser.json',directory),JSON.stringify(report,null,2)+'\n')
  await browser?.close();await server?.close()
}
console.log(JSON.stringify({passed:report.passed,error:report.error??null}))
