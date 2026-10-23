import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { parseScript } from 'meriyah'
import { assertDecoderCompatibility, transformDecoderDependency } from '../scripts/build-youtube-decoder.mjs'
import { JsAnalyzer, JsExtractor } from '../node_modules/youtubei.js/dist/src/utils/javascript/index.js'
import { nsigMatcher, timestampMatcher } from '../node_modules/youtubei.js/dist/src/utils/javascript/matchers.js'

const bundle = await fs.readFile(new URL('../src-tauri/src/youtube-decoder.bundle.js', import.meta.url), 'utf8')
const analyzerPath = '../node_modules/youtubei.js/dist/src/utils/javascript/JsAnalyzer.js'
const meriyahPath = '../node_modules/meriyah/dist/meriyah.mjs'
const analyzerSource = await fs.readFile(new URL(analyzerPath, import.meta.url), 'utf8')
const meriyahSource = await fs.readFile(new URL(meriyahPath, import.meta.url), 'utf8')
const specializedParser = await import('data:text/javascript;base64,' + Buffer.from(
  transformDecoderDependency(meriyahSource, meriyahPath).code,
).toString('base64'))

test('generator accepts only the reviewed dependency versions and exact private parser options', () => {
  assert.doesNotThrow(() => assertDecoderCompatibility('18.1.0', '7.4.0'))
  for (const versions of [['18.1.1', '7.4.0'], ['18.1.0', '7.4.1'], ['18.1.0', undefined]]) {
    assert.throws(() => assertDecoderCompatibility(...versions), /compatibility/)
  }
  assert.ok(transformDecoderDependency(analyzerSource, analyzerPath))
  for (const changed of [
    analyzerSource.replace('loc: false', 'loc: true'),
    analyzerSource.replace('module: false', 'module: true'),
    analyzerSource.replace('ranges: true', 'ranges: false'),
    analyzerSource.replace('module: false', 'module: false, onToken: []'),
    analyzerSource.replace('module: false', 'module: false, onComment: []'),
    analyzerSource + '\nparseScript(otherSource);',
  ]) assert.throws(() => transformDecoderDependency(changed, analyzerPath), /parser .*compatibility/)
})

test('generator rejects changed token getter and node offset semantics', () => {
  for (const changed of [
    meriyahSource.replace('return this.token;', 'return this.token + 1;'),
    meriyahSource.replace('node.start = start.index;', 'node.start = start.index + 1;'),
    meriyahSource.replace('parser.getToken()', 'parser.peekToken()'),
    meriyahSource.replace('index: this.tokenIndex,', 'index: this.tokenIndex + 1,'),
    meriyahSource.replace('index: this.startIndex,', 'index: this.startIndex + 1,'),
    meriyahSource.replace('index: this.index, line: this.line', 'index: this.index + 1, line: this.line'),
    meriyahSource.replace('this.refs[name][0]', 'this.refs[name][1]'),
    meriyahSource.replace('const { tokenValue, tokenStart } = parser;', 'const { tokenStart, tokenValue } = parser;'),
  ]) assert.throws(() => transformDecoderDependency(changed, meriyahPath), /Meriyah .*compatibility/)
})

const syntaxCases = [
  ['ASCII strings', 'var ascii = "plain text", another = \'single quote\';'],
  ['Unicode identifiers', 'var ñandú = "áé😀", 𐐀 = 1;'],
  ['escaped identifier', String.raw`var \u0061bc = 'ok', str = "escaped \\";`],
  ['string escapes', String.raw`var s = "a\"b\\c\n\r\t\u2028\u{1F600}";`],
  ['continued lines', 'var s = "continued\\\nline"; var t = "continued\\\r\nline";'],
  ['literal line separators', 'var s = "\u2028\u2029";'],
  ['NUL and unpaired surrogate', 'var s = "\0\x01\uD800";'],
  ['legacy octal escape', String.raw`var legacy = '\123\8\9';`],
  ['strict octal rejected', String.raw`"use strict"; var legacy = '\123';`],
  ['escaped directive is not strict', String.raw`"use\x20strict"; var legacy = '\123';`],
  ['unterminated string', 'var s = "unterminated'],
  ['newline in string', 'var s = "line\nbreak";'],
  ['carriage return in string', 'var s = "line\rbreak";'],
  ['invalid Unicode escape', String.raw`var s = '\u{}';`],
  ['invalid hex escape', String.raw`var s = '\xq0';`],
  ['empty string', 'var s = "";'],
  ['end of input', '"last"'],
  ['long string', 'var value = "' + 'long'.repeat(10000) + '";'],
  ['regular expression', String.raw`var r = /[a"']+\//giu; var s = "// not a comment";`],
  ['invalid regular expression class', 'var bad = /[/;'],
  ['duplicate regular expression flags', 'var bad = /a/gg;'],
  ['invalid regular expression group', 'var bad = /(/;'],
  ['automatic semicolon insertion', 'function sample(){return\n"value";} /* quote " */'],
  ['nested templates', '`prefix ${"inside"} suffix ${`nested ${1}`}`;'],
  ['reserved keyword binding', 'var \u0069f = 1;'],
  ['default parameter', 'var important = 0; function ordinary(a = "foo"){return a;}'],
  ['computed properties', 'const o = {"key": "value", plain: \'field\', ["computed"]: 1};'],
  ['astral identifier and BigInt', 'var \u{10400} = 1; var x = 10n;'],
]

function syntaxResult(parse, source) {
  try {
    const ast = parse(source, { ranges: { start: true, end: true, range: false }, loc: false, module: false })
    return { ok: true, ast: JSON.stringify(ast, (_, value) => typeof value === 'bigint' ? { bigintValue: String(value) } : value) }
  } catch (error) {
    return { ok: false, name: error.name, message: error.message,
      start: error.start, end: error.end, range: error.range && Array.from(error.range) }
  }
}

for (const [name, source] of syntaxCases) {
  test(`specialized parser preserves stock AST or syntax error: ${name}`, () => {
    assert.deepEqual(syntaxResult(specializedParser.parseScript, source), syntaxResult(parseScript, source))
  })
}

test('compact snapshots preserve tokenizer error locations and private-name validation', () => {
  const prefixes = ['', '\ufeff', '#!/usr/bin/js\n', '/*😀*/', '//a\r\n', '//a\r', '//a\n', '//a\u2028', '//a\u2029', '/*\r\n\u2028*/']
  const invalid = [
    'const x = ;', 'let a = "unterminated', 'const y=`a\n${)}`;', '/[/;', '/a/gg;',
    '0xg;', '1_0_;', '"use strict"; 017;', 'function f(a,a){"use strict";}',
    'const f=async(a=await 1)=>a;', 'function f(){return "x\\\r\ny"; } )',
  ]
  const extra = [
    'class X { read() {\r\nreturn this.#𐐀; } }',
    'var s="a\u2028b"; const x = ;',
    'var a=1;\r\r\nconst b = ;',
    'var s="\ud800"; function f(',
    '"use\\\r\nstrict"; const x = ;',
    'a: a: while(true){}',
    'const f=(a,...b,)=>a;',
    'class X { read(){ return this.#missing; } }',
  ]
  for (const source of [...prefixes.flatMap(prefix => invalid.map(suffix => prefix + suffix)), ...extra]) {
    assert.deepEqual(syntaxResult(specializedParser.parseScript, source), syntaxResult(parseScript, source), source)
  }
  // A failed parse must restore the private source used to reconstruct offsets.
  assert.deepEqual(syntaxResult(specializedParser.parseScript, 'var later="valid";'), syntaxResult(parseScript, 'var later="valid";'))
})

test('identifier and literal leaves preserve UTF-16 offsets, raw values and BigInt branching', () => {
  for (const source of [
    String.raw`var \u0061bc = 1, 𐐀 = 0x20n;`,
    String.raw`var x = 1_234n, y = 0b101n, z = '\u{1F600}';`,
    'var ñ="😀";\r\nvar end = 3.5e2;',
    'const o={key:1, "quoted":2, [name]:3, 100:4, big:0n};',
    'function f(a="x"){return a/2;} const r=/[a-z]+/giu;',
  ]) {
    const options = { ranges: { start: true, end: true, range: false }, loc: false, module: false, raw: true }
    const serialize = ast => JSON.stringify(ast, (_, value) => typeof value === 'bigint' ? { bigintValue: String(value) } : value)
    assert.equal(serialize(specializedParser.parseScript(source, options)), serialize(parseScript(source, options)), source)
  }
})

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

function stockPreparation(source) {
  const analyzer = new JsAnalyzer(source, { extractions: [
    { friendlyName: 'nsigFunction', match: nsigMatcher },
    { friendlyName: 'signatureTimestampVar', match: timestampMatcher, collectDependencies: false },
  ] })
  const result = new JsExtractor(analyzer).buildScript({
    disallowSideEffectInitializers: true, exportRawValues: true, rawValueOnly: ['signatureTimestampVar'],
  })
  return { script: result.output, signatureTimestamp: Number(result.exportedRawValues.signatureTimestampVar) }
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
  const expected = stockPreparation(source)
  const actual = call(sandbox(), 'prepare', source)
  assert.deepEqual(actual, expected)
})

test('timestamp prefilter preserves escaped identifiers and reassigned function ranges', () => {
  const context = sandbox()
  for (const source of [
    syntheticPlayer.replace('var timestamp = function()', 'var timestamp; timestamp = function()'),
    syntheticPlayer.replace('signatureTimestamp: 20746', String.raw`signature\u0054imestamp: 20746`),
    syntheticPlayer.replace('signatureTimestamp: 20746', String.raw`\u{73}ignatureTimestamp: 20746`),
    syntheticPlayer.replace('var timestamp = ', '/* signatureTimestamp */ var unrelated=function(){return "signatureTimestamp"}; var timestamp = '),
    syntheticPlayer.replace('return { signatureTimestamp: 20746 };', 'return function(){return { signatureTimestamp: 20746 };};'),
    syntheticPlayer.replace('return { signatureTimestamp: 20746 };', 'return `nested ${{signatureTimestamp:20746}}`;'),
  ]) {
    assert.deepEqual(call(context, 'prepare', source), stockPreparation(source))
    assert.equal(context.completePlayerExecuted, undefined)
  }
})

test('timestamp prefilter only rejects impossible AST matches and falls back for invalid ranges', () => {
  // The hook exists only in this test VM; production keeps both matchers private.
  const marker = '\tObject.defineProperty(globalThis, "__musifyYouTubeDecoder", {'
  assert.equal(bundle.split(marker).length, 2)
  const context = vm.createContext(Object.create(null))
  vm.runInContext(bundle.replace(marker,
    'globalThis.__timestampTest = (source, node) => [timestampMatcher(node), filteredTimestampMatcher(source, node)];\n' + marker), context)
  const same = (source, node) => {
    const [expected, actual] = context.__timestampTest(source, node)
    assert.deepEqual(actual, expected)
  }
  for (const body of [
    'return { signatureTimestamp: 20746 };',
    String.raw`return { signatureTime\u{73}tamp: 20746 };`,
    'return { [signatureTimestamp]: 20746 };',
    'return { "signatureTimestamp": 20746 };',
    String.raw`return { "\u0073ignatureTimestamp": 20746 };`,
    'return { signatureTimestamp };',
    'return { get signatureTimestamp(){ return 20746; } };',
    'return { set signatureTimestamp(value){} };',
    '/* signatureTimestamp */ return { different:1 };',
    'return { different:"signatureTimestamp" };',
    String.raw`return { different:/signatureTimestamp\u0073/ };`,
    'return { signatureTimeſtamp: 20746 };',
    'return { ｓignatureTimestamp: 20746 };',
    String.raw`var ñ="😀"; return { different:"\n\t\\" };`,
    'return { different:20746n };',
  ]) {
    const source = `var t=function(){${body}};`
    const node = parseScript(source, { ranges: { start: true, end: true, range: false } }).body[0].declarations[0]
    same(source, node)
  }
  const source = 'var t=function(){return {signatureTimestamp:20746}};'
  for (const value of [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    for (const field of ['start', 'end']) {
      const node = parseScript(source, { ranges: { start: true, end: true, range: false } }).body[0].declarations[0]
      node.init[field] = value
      same(source, node)
    }
  }
})

const orderedHelpers = [
  ['predeclared assignment', 'var reverse; reverse = function(value){return value;};'],
  ['member defined after consumer', 'var reverse=function(value){return later.part+value;}; var later={}; later.part="v";'],
  ['base before consumer, member later', 'var later={}; var reverse=function(value){return later.part+value;}; later.part="v";'],
  ['member already visible', 'var later={}; later.part="v"; var reverse=function(value){return later.part+value;};'],
  ['shadowed object', 'var reverse=function(value){var later={part:value}; return later.part;}; var later={part:"outer"};'],
  ['nested function declaration', 'var other=function(value){return value;}; var reverse=function(value){function other(value){return value;} return other(value);};'],
  ['catch binding', 'var reverse=function(value){try{throw value;}catch(error){return error;}};'],
  ['destructuring bindings', 'var reverse=function(value){var [a,...rest]=[value]; const {part:b}={part:a}; return b;};'],
  ['loop scope', 'var reverse=function(value){for(let i=0;i<1;i++){value+=i;}return value;};'],
  ['class method scope', 'var reverse=function(value){class Local{run(){return value;}}return new Local().run();};'],
  ['reassignment retains original resolution order', 'var reverse=function(value){return later.part+value;}; var later={}; later.part="v"; reverse=function(value){return later.part+value;};'],
  ['prototype alias group', 'g.Other=function(value){this.value=value;};g.alias=g.Other.prototype;g.alias.read=function(){return this.value;};var reverse=function(value){return new g.Other(value).read();};'],
]

for (const [name, helper] of orderedHelpers) {
  test(`selected closure matches stock analyzer: ${name}`, () => {
    const source = syntheticPlayer.replace("var reverse = function(value) { return value.split('').reverse().join(''); };", helper)
    const context = sandbox()
    assert.deepEqual(call(context, 'prepare', source), stockPreparation(source))
    assert.equal(context.completePlayerExecuted, undefined)
  })
}

test('preparing different players in one runtime preserves each closure and does not execute unused code', () => {
  const context = sandbox()
  const first = syntheticPlayer
  const second = syntheticPlayer.replace('signatureTimestamp: 20746', 'signatureTimestamp: 20747')
    .replace("return value.split('').reverse().join('');", "return 'next:' + value;")
  const withLateCode = first.replace('globalThis.completePlayerExecuted = true;',
    'var late=function(){ return notDeclared.member; }; globalThis.completePlayerExecuted = true;')
  const expectedFirst = stockPreparation(first)
  for (const source of [first, second, withLateCode, second, first]) {
    assert.deepEqual(call(context, 'prepare', source), stockPreparation(source))
    assert.equal(context.completePlayerExecuted, undefined)
  }
  assert.deepEqual(call(context, 'prepare', withLateCode), expectedFirst)
  assert.deepEqual(call(context, 'decode', expectedFirst.script, 'abcd', 'token'), { sig: 'dcba', n: 'transformed:token' })
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
