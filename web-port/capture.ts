import { recordAudioEvent } from './diagnostics'

const observed = new WeakSet<HTMLAudioElement>()
function observe(audio: HTMLAudioElement) {
  if (observed.has(audio)) return
  observed.add(audio)
  for (const type of ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'playing', 'pause', 'ended',
    'stalled', 'suspend', 'waiting', 'error', 'seeking', 'seeked', 'abort', 'emptied', 'timeupdate']) {
    audio.addEventListener(type, () => recordAudioEvent(type, audio))
  }
}

export function stopCapture() {}
export function setAudioSource(audio: HTMLAudioElement, url: string) {
  observe(audio)
  audio.src = url
  recordAudioEvent('source', audio)
  audio.load()
}
