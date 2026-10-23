import { stream } from './youtube'
import { p1Recipe } from './p1-recipe.generated'

const songs = {
  epoitaitaye: { id: 'DJzjkMBMook', title: 'Epoitaitaye' },
  maite: { id: 'WtTRMAoN2Fw', title: 'Maite Zaitut!' },
  iritsi: { id: 'fV-IUsecSsU', title: 'Iritsi da Eguna' },
}
const audio = document.querySelector('audio')!, status = document.querySelector<HTMLOutputElement>('#status')!
let active: AbortController | null = null
let current: keyof typeof songs | null = null
const log: { at: string; event: string; time?: number; state?: string }[] = []
function record(event: string, state?: string) {
  log.push({ at: new Date().toISOString(), event, time: Number.isFinite(audio.currentTime) ? audio.currentTime : 0, ...(state ? { state } : {}) })
  if (log.length > 128) log.shift()
}
function reset() { audio.pause(); audio.removeAttribute('src'); audio.load() }
async function play(name: keyof typeof songs) {
  active?.abort(); const controller = new AbortController(); active = controller; current = name; reset()
  const song = songs[name]; status.textContent = `Preparando «${song.title}»…`; record('select', name)
  try {
    const info = await stream(song.id, false, controller.signal)
    if (controller.signal.aborted || active !== controller) return
    document.body.dataset.transport = info.transport ?? 'visionos'
    document.body.dataset.videoId = info.videoId
    record('resolved', info.transport ?? 'visionos')
    audio.src = info.url
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: 'Prueba Pletina P1' })
      try { navigator.mediaSession.setActionHandler('play', () => { void audio.play().catch(() => {}) }); navigator.mediaSession.setActionHandler('pause', () => audio.pause()) } catch { /* optional */ }
    }
    await audio.play()
    if (active === controller) status.textContent = `Suena «${song.title}». Ya puedes pulsar Inicio o bloquear la pantalla.`
  } catch (error) {
    if (controller.signal.aborted || active !== controller) return
    if (error instanceof DOMException && error.name === 'NotAllowedError' && audio.src) status.textContent = 'El navegador pide otro toque: pulsa ▶ en los controles de audio.'
    else status.textContent = 'No ha podido empezar. Pulsa otra canción o vuelve a intentarlo.'
    record('failed', error instanceof Error ? error.name : 'Error')
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-song]')) button.addEventListener('click', () => {
  const name = button.dataset.song as keyof typeof songs
  if (Object.hasOwn(songs, name)) void play(name)
})
document.querySelector('#stop')!.addEventListener('click', () => { active?.abort(); active = null; reset(); status.textContent = 'Parada.'; record('stop') })
for (const event of ['playing', 'pause', 'ended', 'error', 'waiting', 'seeked']) audio.addEventListener(event, () => {
  record(event)
  if (event === 'playing' && current) status.textContent = `Suena «${songs[current].title}». Sin vídeo.`
  if (event === 'error' && active) status.textContent = 'El audio se ha cortado. Guarda el resultado y vuelve a intentarlo.'
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
})
document.addEventListener('visibilitychange', () => record('visibility', document.visibilityState))
const contextHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ context: p1Recipe.context, playbackContext: p1Recipe.playbackContext }))))].map(byte => byte.toString(16).padStart(2, '0')).join('')
document.body.dataset.recipe = contextHash
document.querySelector('#version')!.textContent = `Configuración: ${contextHash.slice(0, 12)} · Preparada: ${new Date(p1Recipe.createdAt).toLocaleString()}`
try {
  const response = await fetch('../sw.js', { cache: 'no-store' }), source = await response.text()
  document.body.dataset.build = source.match(/const VERSION = "([a-f0-9]{16})"/)?.[1] ?? ''
} catch { /* Diagnostic remains usable when the cached application is offline. */ }
document.querySelector('#export')!.addEventListener('click', () => {
  const result = { format: 'pletina-p1-check', date: new Date().toISOString(), build: document.body.dataset.build,
    publicContextSha256: contextHash, contextPreparedAt: p1Recipe.createdAt, videoId: document.body.dataset.videoId,
    transport: document.body.dataset.transport, duration: Number.isFinite(audio.duration) ? audio.duration : null,
    mediaError: audio.error?.code ?? null, log }
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'pletina-prueba-p1.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
})
