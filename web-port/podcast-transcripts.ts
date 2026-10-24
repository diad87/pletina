import type { TextCue, TextDocument } from '../src/lib/types'

// Podcasting 2.0: docs/tags/transcript.md and docs/examples/transcripts/transcripts.md.
const NAMESPACES = new Set(['https://podcastindex.org/namespace/1.0',
  'https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md'])
const MAX_BYTES = 4 * 1024 * 1024, MAX_TEXT = 2 * 1024 * 1024, MAX_CUES = 30_000
const TTL = 10 * 60_000
export interface TranscriptReference { url: string; mimeType: string; language: string | null }
const documents = new Map<string, { at: number; value: TextDocument }>()

export function transcriptType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const mime = value.split(';')[0].trim().toLowerCase()
  if (mime === 'text/vtt' || mime === 'text/plain') return mime
  if (['application/json', 'application/x-json'].includes(mime)) return 'application/json'
  if (['application/x-subrip', 'application/srt', 'text/srt'].includes(mime)) return 'application/x-subrip'
  return null
}
function webURL(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) return null
  try {
    const url = new URL(value.trim(), base)
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null
  } catch { return null }
}
/** Explicit allowlist also bounds data restored from IndexedDB. HTML is unsupported. */
export function normalizeTranscriptReferences(value: unknown, base?: string): TranscriptReference[] {
  if (!Array.isArray(value)) return []
  const result: TranscriptReference[] = [], seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>, mimeType = transcriptType(row.mimeType), url = webURL(row.url, base)
    if (!mimeType || !url || seen.has(url)) continue
    seen.add(url)
    result.push({ url, mimeType, language: typeof row.language === 'string' ? row.language.trim().slice(0, 80) || null : null })
    if (result.length >= 8) break
  }
  return result
}
export function transcriptReferences(item: Element, base: string): TranscriptReference[] {
  return normalizeTranscriptReferences([...item.children]
    .filter(node => node.localName === 'transcript' && NAMESPACES.has(node.namespaceURI || ''))
    .map(node => ({ url: node.getAttribute('url'), mimeType: node.getAttribute('type'), language: node.getAttribute('language') })), base)
}
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 7 * 86400
function timestamp(raw: string): number {
  const parts = raw.replace(',', '.').split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((part, index) => !/^\d+(?:\.\d+)?$/.test(part)
    || (index < parts.length - 1 && part.includes('.')) || (index > 0 && Number(part) >= 60))) throw new Error('La transcripción contiene una marca de tiempo no válida.')
  const value = parts.reduce((total, part) => total * 60 + Number(part), 0)
  if (!validTime(value)) throw new Error('La transcripción contiene una marca de tiempo no válida.')
  return value
}
/** Text only: never create DOM nodes, interpret CSS, or execute provider markup. */
export function captionText(value: string): string {
  return value.replace(/<([^<>]{0,1024})>/g, (_all, tag: string) => {
    const voice = /^v(?:\.[^\s]+)*\s+(.+)$/.exec(tag)
    return voice ? voice[1].trim() + ': ' : ''
  }).replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, (all, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '\u200e', rlm: '\u200f' }
    if (named[entity]) return named[entity]
    const code = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : entity.startsWith('#') ? Number(entity.slice(1)) : NaN
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all
  }).trim()
}
function captions(content: string, vtt: boolean): TextCue[] {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (vtt && !/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(normalized)) throw new Error('La transcripción WebVTT no contiene una cabecera válida.')
  const cues: TextCue[] = []
  for (const block of normalized.split(/\n[ \t]*\n/)) {
    const lines = block.trim().split('\n')
    if (/^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0] || '')) continue
    let index = 0
    while (index < lines.length) {
      if (!lines[index].includes('-->')) { index++; continue }
      const match = /^\s*(\S+)\s+-->\s+(\S+)(?:[ \t].*)?$/.exec(lines[index++])
      if (!match) throw new Error('La transcripción contiene una marca de tiempo no válida.')
      const start = timestamp(match[1]), end = timestamp(match[2]), beginning = index
      if (end < start) throw new Error('La transcripción contiene un final no válido.')
      while (index < lines.length && !lines[index].includes('-->')) index++
      const text = captionText(lines.slice(beginning, index).join('\n'))
      if (text) cues.push({ start, end, text })
      if (cues.length > MAX_CUES) throw new Error('La transcripción contiene demasiados segmentos.')
    }
  }
  return cues
}
function jsonCues(content: string): TextCue[] {
  let json: unknown
  try { json = JSON.parse(content) } catch { throw new Error('La transcripción JSON no es válida.') }
  const segments = (json as { segments?: unknown } | null)?.segments
  if (!Array.isArray(segments)) throw new Error('La transcripción JSON no contiene segmentos.')
  if (segments.length > MAX_CUES) throw new Error('La transcripción contiene demasiados segmentos.')
  const cues: TextCue[] = []; let previousSpeaker = ''
  for (const raw of segments) {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (typeof row.body !== 'string') throw new Error('Falta el texto de un segmento de la transcripción.')
    const body = row.body.trim()
    if (!body) continue
    if (!validTime(row.startTime) || (row.endTime != null && (!validTime(row.endTime) || row.endTime < row.startTime))) throw new Error('La transcripción contiene una marca de tiempo no válida.')
    const speaker = typeof row.speaker === 'string' ? row.speaker.trim() : ''
    cues.push({ start: row.startTime, end: row.endTime == null ? null : row.endTime as number,
      text: speaker && speaker !== previousSpeaker ? `${speaker}: ${body}` : body })
    previousSpeaker = speaker
  }
  return cues
}
export function parseTranscript(bytes: Uint8Array, mime: string, sourceUrl: string): TextDocument {
  if (bytes.length > MAX_BYTES) throw new Error('La transcripción supera el tamaño admitido.')
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') }
  catch { throw new Error('La codificación de la transcripción no es UTF-8.') }
  if (/^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(content)) throw new Error('El proveedor devolvió una página web en lugar de la transcripción.')
  const type = transcriptType(mime)
  if (!type) throw new Error('El formato de la transcripción no es compatible.')
  const cues = type === 'text/plain' ? [] : type === 'application/json' ? jsonCues(content) : captions(content, type === 'text/vtt')
  if (type !== 'text/plain' && !cues.length) throw new Error('La transcripción no contiene segmentos de texto válidos.')
  cues.sort((a, b) => a.start - b.start)
  const text = cues.length ? cues.map(cue => cue.text).join('\n') : content.replace(/\r\n?/g, '\n').trim()
  if (!text) throw new Error('La transcripción publicada está vacía.')
  if (new TextEncoder().encode(text).length > MAX_TEXT) throw new Error('La transcripción supera el texto admitido.')
  return { text, cues, source: 'Transcripción del podcast', sourceUrl, instrumental: false }
}
export async function fetchTranscript(reference: TranscriptReference, signal?: AbortSignal): Promise<TextDocument | null> {
  const normalized = normalizeTranscriptReferences([reference])[0]
  if (!normalized) throw new Error('El enlace de la transcripción no es válido.')
  const key = `${normalized.mimeType}\n${normalized.url}`, previous = documents.get(key)
  if (previous && Date.now() - previous.at < TTL) return structuredClone(previous.value)
  documents.delete(key)
  try {
    const response = await fetch(normalized.url, { credentials: 'omit', mode: 'cors', headers: { Accept: normalized.mimeType },
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(9000)]) })
    if ([404, 410].includes(response.status)) return null
    if (!response.ok) throw new Error(response.status === 429 ? 'El proveedor de la transcripción está recibiendo demasiadas consultas. Prueba dentro de un minuto.' : `El proveedor de la transcripción respondió con HTTP ${response.status}.`)
    if (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('El proveedor devolvió una página web en lugar de la transcripción.')
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('La transcripción supera el tamaño admitido.')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No se pudo leer la transcripción. Vuelve a intentarlo.')
    const chunks: Uint8Array[] = []; let length = 0
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.length
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('La transcripción supera el tamaño admitido.') }
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const sourceUrl = webURL(response.url || normalized.url)
    if (!sourceUrl) throw new Error('La transcripción redirigió a una dirección no válida.')
    const value = parseTranscript(bytes, normalized.mimeType, sourceUrl)
    documents.set(key, { at: Date.now(), value })
    while (documents.size > 8) documents.delete(documents.keys().next().value!)
    return structuredClone(value)
  } catch (error) {
    if ((error instanceof DOMException && error.name === 'TimeoutError') ||
      (signal?.reason instanceof DOMException && signal.reason.name === 'TimeoutError')) throw new Error('La transcripción tardó demasiado. Vuelve a intentarlo.')
    if (signal?.aborted) throw signal.reason
    if (error instanceof TypeError) throw new Error('No se pudo cargar la transcripción: comprueba la conexión. El proveedor debe permitir el acceso desde el navegador (CORS). Vuelve a intentarlo.')
    if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('La transcripción tardó demasiado. Vuelve a intentarlo.')
    throw error
  }
}
