// Pure decoding shared by both generated assets. Capture Function privately
// before the host hardens the disposable runtime; never evaluate a whole player.
const compile = Function
const MAX_SCRIPT = 2 * 1024 * 1024
const MAX_VALUE = 4096

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

export function decode(script, sig, n) {
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

