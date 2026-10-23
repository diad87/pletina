// Pure player analysis for the native extractor. Rust supplies the public player
// source and owns the isolated runtime, memory limits, deadline and URL handling.
// No complete player, DOM, network, filesystem or application API is executed.
import { JsAnalyzer } from '../../node_modules/youtubei.js/dist/src/utils/javascript/JsAnalyzer.js'
import { JsExtractor } from '../../node_modules/youtubei.js/dist/src/utils/javascript/JsExtractor.js'
import { nsigMatcher, timestampMatcher } from '../../node_modules/youtubei.js/dist/src/utils/javascript/matchers.js'

const compile = Function
const MAX_SOURCE = 5 * 1024 * 1024
const MAX_SCRIPT = 2 * 1024 * 1024
const MAX_VALUE = 4096

function prepare(source) {
  if (typeof source !== 'string' || !source.length || source.length > MAX_SOURCE) {
    throw new Error('DECODER_SOURCE_SIZE')
  }
  const analyzer = new JsAnalyzer(source, { extractions: [
    { friendlyName: 'nsigFunction', match: nsigMatcher },
    { friendlyName: 'signatureTimestampVar', match: timestampMatcher, collectDependencies: false },
  ] })
  const result = new JsExtractor(analyzer).buildScript({
    disallowSideEffectInitializers: true,
    exportRawValues: true,
    rawValueOnly: ['signatureTimestampVar'],
  })
  const timestamp = result.exportedRawValues?.signatureTimestampVar
  const signatureTimestamp = typeof timestamp === 'string' && /^\d+$/.test(timestamp)
    ? Number(timestamp) : NaN
  if (!result.exported.includes('nsigFunction') || !Number.isSafeInteger(signatureTimestamp) || signatureTimestamp <= 0) {
    throw new Error('DECODER_UNSUPPORTED_PLAYER')
  }
  if (!result.output.length || result.output.length > MAX_SCRIPT) throw new Error('DECODER_SCRIPT_SIZE')
  return { script: result.output, signatureTimestamp }
}

// Equivalent to youtubei.js 18.1.0 getNsigProcessorFn, with values passed as
// function arguments instead of interpolated into generated JavaScript. The
// fixed internal parameter name is independent of the URL's external `sp`.
function processValues(exportedVars, sig, n) {
  const url = exportedVars.nsigFunction(
    'https://ytjs.googlevideo.com/videoplayback?expire=1234567890&n=' + encodeURIComponent(n || ''),
    'sig', sig || '',
  )
  const proto = Object.getPrototypeOf(url)
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (!['constructor', 'clone', 'set', 'get'].includes(name) && typeof url[name] === 'function') url[name]()
  }
  const result = {}
  if (sig !== undefined && sig !== null) {
    const value = url.get('sig')
    result.sig = typeof value === 'string' && value ? decodeURIComponent(value) : undefined
  }
  if (n !== undefined && n !== null) {
    const value = url.get('n')
    result.n = typeof value === 'string' && value ? decodeURIComponent(value) : undefined
  }
  return result
}

const processorSource = processValues.toString()

function decode(script, sig, n) {
  if (typeof script !== 'string' || !script.length || script.length > MAX_SCRIPT) throw new Error('DECODER_SCRIPT_SIZE')
  for (const value of [sig, n]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value.length || value.length > MAX_VALUE)) {
      throw new Error('DECODER_INPUT')
    }
  }
  if (sig == null && n == null) return {}
  // Only extracted dependencies execute. The source player is never evaluated.
  // Rust may remove global eval/Function after loading this IIFE; `compile` is
  // private and the new function cannot see the surrounding lexical closure.
  // Strict mode also prevents arguments.callee/caller from recovering the
  // trusted calling function after the host has removed the global API.
  const result = compile('sig', 'n', `"use strict";\n${script}\nreturn (${processorSource})(exportedVars, sig, n);`)(sig, n)
  if (!result || typeof result !== 'object') throw new Error('DECODER_RESULT')
  const output = {}
  for (const [key, input] of [['sig', sig], ['n', n]]) {
    if (input == null) continue
    const value = result[key]
    if (typeof value !== 'string' || !value.length || value.length > MAX_VALUE ||
        value.startsWith('enhanced_except_') || (key === 'n' && value === input)) throw new Error('DECODER_RESULT')
    output[key] = value
  }
  return output
}

Object.defineProperty(globalThis, '__musifyYouTubeDecoder', {
  // The host retains the callable privately, then removes this global before
  // execution so extracted code cannot recursively invoke the compiler API.
  value: Object.freeze({ prepare, decode }), writable: false, configurable: true,
})
