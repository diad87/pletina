package dev.musify.desktop

import android.content.ComponentName
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.net.ConnectivityManager
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Isolated .autotest only: real HTTP faults, Rust JNI and ExoPlayer; muted PCM fixtures. */
@OptIn(UnstableApi::class)
@RunWith(AndroidJUnit4::class)
class PlaybackRecoveryHttpTest {
  private val ins = InstrumentationRegistry.getInstrumentation()
  private val context get() = ins.targetContext
  private val reports get() = File(context.filesDir, "audit").also { it.mkdirs() }
  private val events = Collections.synchronizedList(mutableListOf<JSONObject>())
  private val errors = AtomicInteger()
  private var auditActivity: android.app.Activity? = null
  private fun <T> main(block: () -> T): T = FutureTask(Callable { block() }).also { ins.runOnMainSync(it) }.get(20, TimeUnit.SECONDS)
  private fun init() {
    assertTrue("Use isolated package only", context.packageName == "dev.musify.desktop.autotest")
    MusifyCore.init(context.dataDir.absolutePath)
    val root = JSONObject(MusifyCore.browse("root"))
    assertFalse(root.toString(), root.has("error"))
    auditActivity = ins.startActivitySync(Intent(context, PlaybackTestActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    ins.waitForIdleSync()
    SystemClock.sleep(300)
  }
  companion object { private var fixtureConnection: SQLiteDatabase? = null }
  // Keep Android's WAL handle alive alongside Rust's connection: closing the last Android
  // handle between fixtures may unlink/recreate WAL while the other SQLite implementation is open.
  private fun db(): SQLiteDatabase = fixtureConnection ?: SQLiteDatabase.openDatabase(File(context.dataDir,"musify.db").absolutePath, null,
    SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING).also { fixtureConnection=it }
  private fun note(name: String, extra: JSONObject = JSONObject()) {
    extra.put("event",name).put("at",SystemClock.elapsedRealtime())
    events.add(extra); Log.i("StabilityAudit",extra.toString())
  }
  private fun report(name: String, server: AudioServer? = null) {
    val obj=JSONObject().put("events",JSONArray(events.toList())).put("http",JSONArray(server?.requests?.toList() ?: emptyList<JSONObject>()))
    File(reports,"$name.json").writeText(obj.toString(2))
  }
  private fun connect(): MediaBrowser {
    val c=main { MediaBrowser.Builder(context,SessionToken(context,ComponentName(context,PlaybackService::class.java))).buildAsync() }.get(20,TimeUnit.SECONDS)
    main { c.addListener(object:Player.Listener {
      override fun onPlayerError(error:PlaybackException) {
        errors.incrementAndGet(); note("error",JSONObject().put("code",error.errorCode).put("name",error.errorCodeName).put("message",error.message))
      }
      override fun onEvents(player:Player, e:Player.Events) {
        note("state",JSONObject().put("index",player.currentMediaItemIndex).put("position",player.currentPosition)
          .put("state",player.playbackState).put("playing",player.isPlaying).put("playWhenReady",player.playWhenReady))
      }
    }); c.volume=0f }
    return c
  }
  private fun close(c:MediaBrowser?) {
    if(c!=null) main { c.pause(); c.stop(); c.clearMediaItems(); c.release() }
    main { context.stopService(Intent(context,PlaybackService::class.java)) }
    main { auditActivity?.finish() }
    ins.waitForIdleSync()
  }
  private fun await(message:String, timeoutMs:Long=20000, block:()->Boolean) {
    val deadline=SystemClock.elapsedRealtime()+timeoutMs
    while(SystemClock.elapsedRealtime()<deadline) { if(block())return; SystemClock.sleep(50) }
    fail("Timeout: $message; events="+events.takeLast(12))
  }
  private fun query(id:Long,title:String)=JSONObject().put("id",id).put("title",title).put("artist","Audit")
    .put("album","Audit fixture").put("duration",180)
  private fun entry(id:Long,title:String,uid:String=id.toString()):MediaItem {
    val q=query(id,title)
    val track=JSONObject().put("id",id).put("title",title).put("duration",180).put("explicit",false)
      .put("artist",JSONObject().put("id",1).put("name","Audit"))
    val lib=JSONObject().put("id",id).put("title",title).put("duration",180).put("explicit",false)
      .put("artistId",1).put("artistName","Audit").put("albumId",id).put("albumTitle","Audit fixture").put("albumArtistId",1)
    return PlaybackService.itemFromEntry(JSONObject().put("uid",uid).put("query",q).put("lib",lib)
      .put("item",JSONObject().put("track",track).put("albumId",id).put("albumTitle","Audit fixture"))
      .put("user",false).put("key",0).put("ctx",0).put("context","Audit fixture"))
  }
  private fun seedRss(url:String,suffix:String):Long {
    val show=700000L
    val episode=700000L+suffix.hashCode().toLong().and(0xffff)
    db().let { d ->
      d.execSQL("INSERT OR IGNORE INTO podcast_shows(id,feed_url,title,author,description) VALUES (?,?,'Audit RSS','Audit','')",arrayOf<Any>(show,"https://example.invalid/audit.xml"))
      d.execSQL("INSERT OR REPLACE INTO podcast_episodes(id,show_id,guid,audio_url) VALUES(?,?,?,?)",arrayOf<Any>(episode,show,suffix,url))
    }
    val publicId=750_000_000_000_000L+episode
    val resolved=JSONObject(MusifyCore.resolve(query(publicId,"Fixture probe").toString(),false))
    assertEquals("Fixture write must be visible to real Rust before playback: $resolved",url,resolved.optString("url"))
    return publicId
  }
  private fun start(c:MediaBrowser, items:List<MediaItem>) {
    main { c.setMediaItems(items,0,0); c.prepare(); c.play() }
    await("playing",30000) { main { c.isPlaying && c.currentPosition>500 } }
  }

  @Test fun pendingHttpRetryMustRespectPause() {
    init(); val server=AudioServer(true); var c:MediaBrowser?=null
    try {
      val id=seedRss(server.url,"pause-retry"); c=connect(); val controller=c
      start(controller,listOf(entry(id,"Pause retry fixture")))
      server.cut(); await("real HTTP playback error",30000) {errors.get()>0}
      main {controller.pause()}; note("explicit-pause")
      server.restore(); SystemClock.sleep(2500)
      val actual=main {controller.playWhenReady}; note("after-retry",JSONObject().put("playWhenReady",actual))
      assertFalse("BUG: delayed retry overrode explicit pause after real HTTP error",actual)
    } finally { close(c); report("retry-pause-real-http",server); server.close() }
  }

  @Test fun fourSeparatedHttpFailuresMustNotSkipRecoveredTrack() {
    init(); val server=AudioServer(true); var c:MediaBrowser?=null
    try {
      val a=seedRss(server.url,"cut-A"); val b=seedRss(server.url,"cut-B")
      c=connect(); val controller=c; start(controller,listOf(entry(a,"Fixture A"),entry(b,"Fixture B")))
      repeat(3) { n ->
        val before=errors.get(); server.cut(); await("error ${n+1}",30000) {errors.get()>before}
        server.restore(); await("recover ${n+1}",15000) {main {controller.isPlaying}}
        val pos=main {controller.currentPosition}; SystemClock.sleep(3000)
        assertTrue(main {controller.isPlaying && controller.currentPosition>pos+1500 && controller.currentMediaItemIndex==0})
        note("successful-recovery",JSONObject().put("cycle",n+1).put("stableMs",3000).put("position",main {controller.currentPosition}))
      }
      val before=errors.get(); server.cut(); await("fourth error",30000) {errors.get()>before}
      server.restore(); SystemClock.sleep(1500)
      val index=main {controller.currentMediaItemIndex}; note("after-fourth-cut",JSONObject().put("index",index))
      assertEquals("BUG: previous successful recoveries still consumed retry budget",0,index)
      await("fourth recovery advances", 15000) { main { controller.isPlaying && controller.currentMediaItemIndex == 0 } }
      val recovered = main { controller.currentPosition }; SystemClock.sleep(1500)
      assertTrue(main { controller.isPlaying && controller.currentPosition > recovered + 1000 })
      note("fourth-recovery-advanced", JSONObject().put("from", recovered).put("to", main { controller.currentPosition }))
    } finally { close(c); report("four-cuts-real-http",server); server.close() }
  }

  @Test fun retryFromPreviousTrackMustNotResumeNewPausedTrack() {
    init(); val server=AudioServer(true); var c:MediaBrowser?=null
    try {
      val a=seedRss(server.url,"race-A"); val b=seedRss(server.url,"race-B")
      c=connect(); val controller=c; start(controller,listOf(entry(a,"Race A"),entry(b,"Race B")))
      server.cut(); await("real error",30000) {errors.get()>0}
      main {controller.seekTo(1,20000); controller.pause()}; note("changed-to-B-and-paused")
      server.restore(); SystemClock.sleep(2500)
      note("after-old-retry",JSONObject().put("index",main {controller.currentMediaItemIndex}).put("playWhenReady",main {controller.playWhenReady}))
      assertFalse("BUG: A retry resumed B after explicit pause",main {controller.playWhenReady})
    } finally { close(c); report("retry-changed-track-real-http",server); server.close() }
  }

  @Test fun stopDuringHttpRetryStaysStopped() {
    init(); val server = AudioServer(true); var c: MediaBrowser? = null
    try {
      val id = seedRss(server.url, "stop-retry"); c = connect(); val controller = c
      start(controller, listOf(entry(id, "Stop fixture")))
      server.cut(); await("HTTP error") { errors.get() > 0 }
      main { controller.stop() }; note("explicit-stop")
      server.restore(); SystemClock.sleep(2500)
      assertEquals(Player.STATE_IDLE, main { controller.playbackState })
      assertFalse(main { controller.isPlaying })
    } finally { close(c); report("retry-stop-real-http", server); server.close() }
  }

  @Test fun retryCancellationRaces20Times() {
    init(); val server = AudioServer(true); var c: MediaBrowser? = null
    try {
      val a = seedRss(server.url, "repeat-A"); val b = seedRss(server.url, "repeat-B")
      c = connect(); val controller = c
      repeat(20) { iteration ->
        main { controller.stop(); controller.clearMediaItems() }
        server.restore()
        start(controller, listOf(entry(a, "Repeated A", "A-$iteration"), entry(b, "Repeated B", "B-$iteration")))
        val before = errors.get(); server.cut(); await("HTTP error $iteration") { errors.get() > before }
        // Vary the command's distance from the 1 s callback, without relying on exact timing.
        SystemClock.sleep((iteration % 4) * 150L)
        when (iteration % 4) {
          0 -> main { controller.pause() }
          1 -> main { controller.stop() }
          2 -> main { controller.seekTo(1, 20000); controller.pause() }
          else -> main { controller.pause(); controller.setMediaItems(listOf(entry(b, "New queue", "new-$iteration"))); controller.prepare() }
        }
        server.restore(); SystemClock.sleep(1800)
        if (iteration % 4 == 1) assertEquals("stop $iteration", Player.STATE_IDLE, main { controller.playbackState })
        else assertFalse("pause $iteration", main { controller.playWhenReady })
        assertFalse("unexpected playback $iteration", main { controller.isPlaying })
        note("race-passed", JSONObject().put("iteration", iteration + 1).put("variant", iteration % 4))
      }
    } finally { close(c); report("retry-races-20-real-http", server); server.close() }
  }

  @Test fun validatedNetworkReturnResumesSameTrack() = networkReturn(paused = false)
  @Test fun validatedNetworkReturnPreservesPause() = networkReturn(paused = true)

  private fun networkReturn(paused: Boolean) {
    org.junit.Assume.assumeTrue("Radio toggles require a dedicated emulator",
      android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))
    init(); val server = AudioServer(true); var c: MediaBrowser? = null
    val cm = context.getSystemService(ConnectivityManager::class.java)
    fun validated() = PlaybackService.validated(cm.getNetworkCapabilities(cm.activeNetwork))
    fun shell(command: String) {
      ins.uiAutomation.executeShellCommand(command).use { descriptor ->
        java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
      }
    }
    try {
      await("initial validated network", 30000) { validated() }
      val id = seedRss(server.url, "network-$paused"); c = connect(); val controller = c
      start(controller, listOf(entry(id, "Network fixture")))
      shell("svc wifi disable"); shell("svc data disable")
      await("network loses validation", 15000) { !validated() }
      SystemClock.sleep(300) // let the service process its network callback
      server.cut(); await("real HTTP error offline") { errors.get() > 0 }
      if (paused) main { controller.pause() }
      server.restore(); shell("svc wifi enable"); shell("svc data enable")
      await("network validated again", 30000) { validated() }
      if (paused) {
        SystemClock.sleep(2500)
        assertFalse(main { controller.playWhenReady }); assertFalse(main { controller.isPlaying })
      } else {
        await("resume after validation", 15000) { main { controller.isPlaying } }
        val resumed = main { controller.currentPosition }; SystemClock.sleep(1500)
        assertTrue(main { controller.isPlaying && controller.currentPosition > resumed + 1000 })
      }
      assertEquals(0, main { controller.currentMediaItemIndex })
      note("network-return-passed", JSONObject().put("paused", paused))
    } finally {
      shell("svc wifi enable"); shell("svc data enable")
      close(c); report("network-return-$paused", server); server.close()
    }
  }

  private class AudioServer(private val throttle:Boolean) {
    private val socket=ServerSocket(0,20,java.net.InetAddress.getByName("127.0.0.1"))
    private val running=AtomicBoolean(true)
    private val failing=AtomicBoolean(false)
    private val pool=Executors.newCachedThreadPool()
    private val clients=Collections.synchronizedList(mutableListOf<Socket>())
    val requests=Collections.synchronizedList(mutableListOf<JSONObject>())
    val url="http://127.0.0.1:${socket.localPort}/fixture.wav"
    private val audio=wav()
    init { pool.execute { while(running.get()) { try { val client=socket.accept(); clients.add(client); pool.execute {serve(client)} } catch(_:Exception){} } } }
    fun cut(){ failing.set(true); clients.toList().forEach {runCatching {it.close()}} }
    fun restore(){failing.set(false)}
    fun close(){running.set(false); runCatching {socket.close()}; clients.toList().forEach {runCatching {it.close()}}; pool.shutdownNow()}
    private fun serve(client:Socket) {
      try { client.use { s ->
        s.soTimeout=5000
        val input=s.getInputStream().bufferedReader(); val request=input.readLine() ?: return
        val headers=mutableMapOf<String,String>()
        while(true) {val line=input.readLine() ?: break; if(line.isEmpty())break; val split=line.indexOf(':'); if(split>0)headers[line.substring(0,split).lowercase()]=line.substring(split+1).trim()}
        val range=headers["range"].orEmpty(); val output=s.getOutputStream()
        if(failing.get()) {requests.add(JSONObject().put("at",SystemClock.elapsedRealtime()).put("status",503).put("range",range)); output.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()); return}
        val start=Regex("bytes=(\\d+)-").find(range)?.groupValues?.get(1)?.toInt() ?: 0
        val end=audio.size-1; val size=audio.size-start; val partial=range.isNotEmpty()
        requests.add(JSONObject().put("at",SystemClock.elapsedRealtime()).put("status",if(partial)206 else 200).put("range",range).put("start",start))
        if(start>=audio.size){output.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray());return}
        val header="HTTP/1.1 ${if(partial)"206 Partial Content" else "200 OK"}\r\nContent-Type: audio/wav\r\nContent-Length: $size\r\nAccept-Ranges: bytes\r\n"+(if(partial)"Content-Range: bytes $start-$end/${audio.size}\r\n" else "")+"Connection: close\r\n\r\n"
        output.write(header.toByteArray())
        if(request.startsWith("HEAD"))return
        var at=start
        while(at<audio.size && running.get() && !failing.get()) {
          val count=minOf(4096,audio.size-at); output.write(audio,at,count);output.flush(); at+=count
          if(throttle)Thread.sleep(200)
        }
      }}catch(_:Exception){}finally{clients.remove(client)}
    }
    private fun wav():ByteArray {
      val size=8000*180*2
      return ByteBuffer.allocate(size+44).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("RIFF".toByteArray());putInt(size+36);put("WAVEfmt ".toByteArray());putInt(16);putShort(1);putShort(1);putInt(8000);putInt(16000);putShort(2);putShort(16);put("data".toByteArray());putInt(size)
      }.array()
    }
  }
}
