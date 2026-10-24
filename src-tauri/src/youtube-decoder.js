// Pure player analysis for the native extractor. Rust supplies the public player
// source and owns the isolated runtime, memory limits, deadline and URL handling.
// No complete player, DOM, network, filesystem or application API is executed.
import { JsAnalyzer } from '../../node_modules/youtube-decoder-upstream/dist/src/utils/javascript/JsAnalyzer.js'
import { JsExtractor } from '../../node_modules/youtube-decoder-upstream/dist/src/utils/javascript/JsExtractor.js'
import { nsigMatcher, timestampMatcher } from '../../node_modules/youtube-decoder-upstream/dist/src/utils/javascript/matchers.js'

import { decode } from './youtube-decoder-values.js'

const MAX_SOURCE = 5 * 1024 * 1024
const MAX_SCRIPT = 2 * 1024 * 1024

// These private adapters are specific to the pinned analyzer and the two
// matchers below. Resolve only dependencies needed by the selected closure,
// preserving the declarations visible when the original analysis requested it.
class DeclarationHistory extends Map {
  constructor() {
    super()
    this.history = new Map()
    this.version = 0
  }
  set(name, metadata) {
    const entries = this.history.get(name) || []
    entries.push([++this.version, metadata])
    this.history.set(name, entries)
    return super.set(name, metadata)
  }
  getAt(name, version) {
    const entries = this.history.get(name)
    if (!entries) return undefined
    let from = 0, to = entries.length
    while (from < to) {
      const middle = (from + to) >>> 1
      if (entries[middle][0] <= version) from = middle + 1
      else to = middle
    }
    return from ? entries[from - 1][1] : undefined
  }
}

class DeferredDependencies extends Set {
  constructor(produce) {
    super()
    this.produce = produce
    this.pending = []
    this.resolved = null
  }
  materialize() {
    if (!this.resolved) {
      const values = this.produce()
      // The analyzer appends a member's base after its original dependencies.
      for (const value of this.pending) values.add(value)
      this.resolved = values
      this.pending = null
      this.produce = null
    }
    return this.resolved
  }
  add(value) {
    if (this.resolved) this.resolved.add(value)
    else this.pending.push(value)
    return this
  }
  get size() { return this.materialize().size }
  has(value) { return this.materialize().has(value) }
  [Symbol.iterator]() { return this.materialize()[Symbol.iterator]() }
  values() { return this.materialize().values() }
  keys() { return this.materialize().keys() }
  entries() { return this.materialize().entries() }
  forEach(callback, self) {
    return this.materialize().forEach(value => callback.call(self, value, value, this))
  }
  delete(value) { return this.materialize().delete(value) }
  clear() { return this.materialize().clear() }
}

class SelectiveAnalyzer extends JsAnalyzer {
  analyzeAst() {
    this.declaredVariables = new DeclarationHistory()
    return super.analyzeAst()
  }
  findDependencies(root, identifier) {
    const declarations = this.declaredVariables, version = declarations.version
    const source = this.source, iifeParamName = this.iifeParamName
    return new DeferredDependencies(() => {
      // In 18.1.0 this method only tests a declaration's presence and writes its
      // dependents. Readiness and emission do not read that reverse bookkeeping.
      // Isolate it so deferred work cannot mutate the live analyzer's state.
      const witness = { dependents: new Set() }
      const view = {
        source, iifeParamName,
        declaredVariables: { get: name => declarations.getAt(name, version) ? witness : undefined },
        dependentsTracker: new Map(),
      }
      return JsAnalyzer.prototype.findDependencies.call(view, root, identifier)
    })
  }
}

function filteredTimestampMatcher(source, node) {
  const init = node.type === 'VariableDeclarator' ? node.init : null
  if (init?.type === 'FunctionExpression' && Number.isSafeInteger(init.start) &&
      Number.isSafeInteger(init.end) && init.start >= 0 && init.end > init.start && init.end <= source.length) {
    const raw = source.slice(init.start, init.end)
    // ECMA-262 12.7: an IdentifierName can spell this StringValue literally or
    // with a Unicode escape (\uXXXX / \u{...}); it is not Unicode-normalized.
    // Full parsing already succeeded. This only rules out an impossible match;
    // positives, escapes and invalid ranges still use the original AST matcher.
    if (!raw.includes('signatureTimestamp') && !raw.includes('\\u')) return false
  }
  return timestampMatcher(node)
}

function prepare(source) {
  if (typeof source !== 'string' || !source.length || source.length > MAX_SOURCE) {
    throw new Error('DECODER_SOURCE_SIZE')
  }
  const analyzer = new SelectiveAnalyzer(source, { extractions: [
    { friendlyName: 'nsigFunction', match: nsigMatcher },
    { friendlyName: 'signatureTimestampVar', match: node => filteredTimestampMatcher(source, node), collectDependencies: false },
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

Object.defineProperty(globalThis, '__musifyYouTubeDecoder', {
  // The host retains the callable privately, then removes this global before
  // execution so extracted code cannot recursively invoke the compiler API.
  value: Object.freeze({ prepare, decode }), writable: false, configurable: true,
})
