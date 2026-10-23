import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { JsAnalyzer, JsExtractor } from '../node_modules/youtubei.js/dist/src/utils/javascript/index.js'
import { nsigMatcher, timestampMatcher } from '../node_modules/youtubei.js/dist/src/utils/javascript/matchers.js'

const bundle = await fs.readFile(new URL('../src-tauri/src/youtube-decoder.bundle.js', import.meta.url), 'utf8')

// Deliberately synthetic: the structural matcher sees a tiny player-shaped
// program, not a copied YouTube player or any real signature/visitor data.
const syntheticPlayer = `(function(g) {
  var shorthand = 1, unused = { shorthand };
  var reverse = function(value) { return value.split('').reverse().join(''); };
  g.Url = function(value) { this.values = { n: value.split('n=')[1] }; };
  g.proto = g.Url.prototype;
  g.proto.set = function(key, value) { this.values[key] = value; };
  g.proto.get = function(key) { return this.values[key]; };
  var decipher = function(url, name = 'sig', value = '') {
    url = new g.Url(url);
    url.set('alr', 'yes');
    if (value) url.set(name, encodeURIComponent(reverse(value)));
    url.set('n', encodeURIComponent('transformed:' + decodeURIComponent(url.get('n'))));
    return url;
  };
  var timestamp = function() { return { signatureTimestamp: 20746 }; };
  globalThis.completePlayerExecuted = true;
  throw new Error('The full player must never run');
})({});`

function sandbox() {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } })
  vm.runInContext(bundle, context, { timeout: 1000 })
  // This mirrors native hardening after loading the bundle: only the private
  // compiler remains. There are no host functions, modules, DOM or I/O APIs.
  vm.runInContext(`
    Function.prototype.constructor = undefined;
    globalThis.Function = undefined;
    globalThis.eval = undefined;
  `, context)
  return context
}

function call(context, method, ...args) {
  // JSON literals preserve arbitrary input as data. The production host uses
  // QuickJS Function.call instead; neither path interpolates a cipher as code.
  return JSON.parse(vm.runInContext(
    `JSON.stringify(__musifyYouTubeDecoder.${method}(...${JSON.stringify(args)}))`,
    context, { timeout: 1000 },
  ))
}

test('extracts dependencies without executing the complete player and decodes both values', () => {
  const context = sandbox()
  const prepared = call(context, 'prepare', syntheticPlayer)
  assert.equal(prepared.signatureTimestamp, 20746)
  assert.equal(typeof prepared.script, 'string')
  assert.equal(context.completePlayerExecuted, undefined)
  assert.deepEqual(call(context, 'decode', prepared.script, 'abcd', 'token'), { sig: 'dcba', n: 'transformed:token' })
  assert.equal(context.completePlayerExecuted, undefined)
})

test('compact AST offsets preserve the exact script emitted by the unmodified analyzer', () => {
  const source = syntheticPlayer.replace('var shorthand', '/* Unicode offset: ñ😀 */ var shorthand')
  const analyzer = new JsAnalyzer(source, { extractions: [
    { friendlyName: 'nsigFunction', match: nsigMatcher },
    { friendlyName: 'signatureTimestampVar', match: timestampMatcher, collectDependencies: false },
  ] })
  const expected = new JsExtractor(analyzer).buildScript({
    disallowSideEffectInitializers: true, exportRawValues: true, rawValueOnly: ['signatureTimestampVar'],
  })
  const actual = call(sandbox(), 'prepare', source)
  assert.equal(actual.script, expected.output)
  assert.equal(actual.signatureTimestamp, Number(expected.exportedRawValues.signatureTimestampVar))
})

test('passes quotes, slashes and statement-like cipher inputs as data', () => {
  const context = sandbox()
  const { script } = call(context, 'prepare', syntheticPlayer)
  const value = '"\\\n);globalThis.injected=true;//=ñ'
  assert.deepEqual(call(context, 'decode', script, value, value), {
    sig: value.split('').reverse().join(''), n: `transformed:${value}`,
  })
  assert.equal(context.injected, undefined)
})

test('supports signature-only and n-only inputs without inventing absent fields', () => {
  const context = sandbox()
  const { script } = call(context, 'prepare', syntheticPlayer)
  assert.deepEqual(call(context, 'decode', script, 'abc'), { sig: 'cba' })
  assert.deepEqual(call(context, 'decode', script, null, 'n'), { n: 'transformed:n' })
  assert.deepEqual(call(context, 'decode', script), {})
})

test('rejects missing extraction, malformed source and nonliteral timestamp without executing source', () => {
  const context = sandbox()
  for (const source of [
    'globalThis.completePlayerExecuted = true;',
    'function (',
    syntheticPlayer.replace('signatureTimestamp: 20746', 'signatureTimestamp: (globalThis.timestampExecuted = true)'),
    syntheticPlayer.replace("url.set('alr', 'yes');", "url.set('different', 'yes');"),
  ]) assert.throws(() => call(context, 'prepare', source))
  assert.equal(context.completePlayerExecuted, undefined)
  assert.equal(context.timestampExecuted, undefined)
})

test('does not expose DOM, host modules, network or filesystem to extracted functions', () => {
  const context = sandbox()
  const source = syntheticPlayer.replace(
    "return value.split('').reverse().join('');",
    "return [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof Function, typeof eval].join(',');",
  )
  const { script } = call(context, 'prepare', source)
  assert.deepEqual(call(context, 'decode', script, 'test'), { sig: 'undefined,undefined,undefined,undefined,undefined,undefined' })
  assert.equal(vm.runInContext('typeof document + "/" + typeof window', context), 'undefined/undefined')
})

test('host can retain the decoder privately and remove its global before extraction executes', () => {
  const context = sandbox()
  const api = context.__musifyYouTubeDecoder
  assert.equal(vm.runInContext('delete globalThis.__musifyYouTubeDecoder', context), true)
  const source = syntheticPlayer.replace(
    "return value.split('').reverse().join('');",
    "return typeof __musifyYouTubeDecoder;",
  )
  const { script } = api.prepare(source)
  assert.equal(api.decode(script, 'test').sig, 'undefined')
  assert.equal(context.__musifyYouTubeDecoder, undefined)
})

test('extracted code cannot recover its trusted caller through arguments.callee', () => {
  const context = sandbox()
  const script = `
    class Url { constructor(value) { this.value = value } get() { return this.value } }
    const exportedVars = { nsigFunction: function() {
      try { return new Url(arguments.callee.caller ? 'exposed' : 'unguarded'); }
      catch (_) { return new Url('blocked'); }
    } };
  `
  assert.deepEqual(call(context, 'decode', script, 'input'), { sig: 'blocked' })
})

test('rejects invalid, unchanged and exception-marker results rather than returning an unusable n', () => {
  const context = sandbox()
  for (const expression of ['null', '42', "'enhanced_except_invalid'", "'same'"]) {
    const script = `class Url { get() { return ${expression} } }; const exportedVars = { nsigFunction: () => new Url() };`
    assert.throws(() => call(context, 'decode', script, null, 'same'), /DECODER_RESULT|URI/)
  }
})

test('bounds input sizes and lets the host interrupt an extracted infinite loop', () => {
  const context = sandbox()
  assert.throws(() => call(context, 'prepare', 'x'.repeat(5 * 1024 * 1024 + 1)), /DECODER_SOURCE_SIZE/)
  assert.throws(() => call(context, 'decode', 'x'.repeat(2 * 1024 * 1024 + 1), 'a'), /DECODER_SCRIPT_SIZE/)
  assert.throws(() => call(context, 'decode', 'const exportedVars={};', 'x'.repeat(4097)), /DECODER_INPUT/)
  context.loopScript = 'const exportedVars = { nsigFunction: () => { for (;;) {} } };'
  assert.throws(() => vm.runInContext('__musifyYouTubeDecoder.decode(loopScript,"s")', context, { timeout: 25 }), /timed out/)
})
