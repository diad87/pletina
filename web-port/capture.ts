export function stopCapture() {}
export function setAudioSource(audio: HTMLAudioElement, url: string) {
  audio.src = url
  audio.load()
}
