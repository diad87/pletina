// El port usa únicamente el transporte directo del navegador.
export type Engine = 'ytdlp' | 'youtubei' | 'propio' | 'oficial'
export interface EngineStats { extractors: never[]; fast: number; fastFailed: number; replaced: number; official: number }
export const extractor = {
  engine: 'propio' as Engine,
  async start() {},
  async stats(): Promise<EngineStats> { return { extractors: [], fast: 0, fastFailed: 0, replaced: 0, official: 0 } },
  async set() { throw new Error('La versión web utiliza audio directo.') },
}
