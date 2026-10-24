import type { TextCue } from './types'

/** Última entrada que ha empezado, sin mantenerla encendida después de su final. */
export function activeCue(cues: TextCue[], seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return -1
  let low = 0
  let high = cues.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (cues[middle].start <= seconds) low = middle + 1
    else high = middle
  }
  const index = low - 1
  const cue = cues[index]
  return cue && (cue.end === null || seconds < cue.end) ? index : -1
}

/** El enlace de procedencia también debe ser una URL web válida. */
export function textSourceUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
