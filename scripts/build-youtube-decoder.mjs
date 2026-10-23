// Rebuild the committed, offline Rust asset using the locked npm dependencies.
import { rolldown } from 'rolldown'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function assertDecoderCompatibility(youtubeiVersion, meriyahVersion) {
  if (youtubeiVersion !== '18.1.0' || meriyahVersion !== '7.4.0') {
    throw new Error('Review decoder compatibility before changing youtubei.js 18.1.0 / Meriyah 7.4.0')
  }
}

const analyzerParse = `this.programAst = parseScript(code, {
            ranges: true,
            loc: false,
            module: false
        });`
const originalFinishNode = `    finishNode(node, start, end) {
        const { ranges } = this.options;
        if (ranges) {
            const endIndex = end ? end.index : this.startIndex;
            if (ranges.start)
                node.start = start.index;
            if (ranges.end)
                node.end = endIndex;
            if (ranges.range)
                node.range = [start.index, endIndex];
        }
        if (this.options.loc) {
            node.loc = {
                start: {
                    line: start.line,
                    column: start.column,
                },
                end: end ? { line: end.line, column: end.column } : { line: this.startLine, column: this.startColumn },
            };
            if (this.options.source) {
                node.loc.source = this.options.source;
            }
        }
        return node;
    }`

function expectOccurrences(code, text, count, description) {
  if (code.split(text).length !== count + 1) throw new Error(`Review ${description} compatibility`)
}

// Meriyah clones only Identifier/StringLiteral AST nodes here. QuickJS has no
// structuredClone web API; keep this substitute private to the parser module.
const cloneSyntaxNode = `function cloneSyntaxNode(value) {
  if (Array.isArray(value)) return value.map(cloneSyntaxNode);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, { value: cloneSyntaxNode(value[key]), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  }
  return value;
}\n`

// Only the private, loc:false parser uses this representation. One-based UTF-16
// offsets preserve truthiness at offset zero. currentLocation remains an object:
// tokenizer errors can carry line/column counters advanced beyond their index.
const compactPositions = `let decoderPositionSource = null;
function decoderPosition(position) {
  if (typeof position !== 'number') return position;
  const index = position - 1, source = decoderPositionSource;
  let line = 1, column = 0;
  for (let at = 0; at < index; at++) {
    const code = source.charCodeAt(at);
    if (code === 13) {
      if (source.charCodeAt(at + 1) === 10 && at + 1 < index) at++;
      line++; column = 0;
    } else if (code === 10 || code === 0x2028 || code === 0x2029) {
      line++; column = 0;
    } else column++;
  }
  return { index, line, column };
}
function parseSource(source, rawOptions = {}, context = 0) {
  const previous = decoderPositionSource;
  decoderPositionSource = source;
  try { return parseSourceWithOffsets(source, rawOptions, context); }
  finally { decoderPositionSource = previous; }
}
function parseSourceWithOffsets(source, rawOptions = {}, context = 0) {`

function specializePositions(source) {
  let code = source
  const replace = (from, to, description) => {
    expectOccurrences(code, from, 1, 'Meriyah ' + description)
    code = code.replace(from, to)
  }
  for (const [name, index, line, column] of [
    ['tokenStart', 'tokenIndex', 'tokenLine', 'tokenColumn'],
    ['startPosition', 'startIndex', 'startLine', 'startColumn'],
  ]) replace(`    get ${name}() {
        return {
            index: this.${index},
            line: this.${line},
            column: this.${column},
        };
    }`, `    get ${name}() { return this.${index} + 1; }`, name + ' snapshot')
  replace('parser.source.slice(start.index + 1, endIndex - 1)',
    'parser.source.slice(start, endIndex - 1)', 'directive offset')
  replace('const { index, line, column } = this.refs[name][0];',
    'const { index, line, column } = decoderPosition(this.refs[name][0]);', 'private identifier error')
  replace('    constructor(start, end, type, ...params) {\n',
    '    constructor(start, end, type, ...params) {\n        start = decoderPosition(start); end = decoderPosition(end);\n', 'error positions')
  replace('function parseSource(source, rawOptions = {}, context = 0) {', compactPositions, 'parse source lifetime')

  const fields = { tokenStart: 'tokenIndex', startPosition: 'startIndex' }
  const counts = { destructurings: 0, positions: 0, direct: 0 }
  // These exact read-only sites are pinned below and by the dependency hash.
  // No assignments, tokenizer counters or currentLocation accesses are changed.
  code = code.replace(/\b(const|let)\s+\{([^{}]*)\}\s*=\s*(parser|this);/g, (whole, kind, body, owner) => {
    if (!/\b(?:tokenStart|startPosition)\b/.test(body)) return whole
    counts.destructurings++
    const declarations = body.split(',').map(part => part.trim()).filter(Boolean).map(part => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(part)
      if (!match) throw new Error('Review Meriyah snapshot destructuring compatibility')
      const [, key, alias] = match
      if (fields[key]) counts.positions++
      return `${alias || key} = ${owner}.${fields[key] || key}${fields[key] ? ' + 1' : ''}`
    })
    return `${kind} ${declarations.join(', ')};`
  })
  code = code.replace(/\b(this\.parser|parser|this)\.(tokenStart|startPosition)\b/g, (_, owner, key) => {
    counts.direct++
    return `(${owner}.${fields[key]} + 1)`
  })
  if (counts.destructurings !== 65 || counts.positions !== 65 || counts.direct !== 121) {
    throw new Error('Review Meriyah snapshot consumer compatibility')
  }
  replace(`function parseIdentifier(parser, context, allowRegExp = 0) {
    const tokenValue = parser.tokenValue, tokenStart = parser.tokenIndex + 1;
    nextToken(parser, context | (allowRegExp ? 32 : 0));
    return parser.finishNode({
        type: 'Identifier',
        name: tokenValue,
    }, tokenStart);
}`, `function parseIdentifier(parser, context, allowRegExp = 0) {
    const tokenValue = parser.tokenValue, tokenIndex = parser.tokenIndex;
    nextToken(parser, context | (allowRegExp ? 32 : 0));
    return { type: 'Identifier', name: tokenValue, start: tokenIndex, end: parser.startIndex };
}`, 'identifier leaf')
  replace(`function parseLiteral(parser, context) {
    const tokenValue = parser.tokenValue, tokenRaw = parser.tokenRaw, tokenStart = parser.tokenIndex + 1;
    if (parser.token === 134283389) {
        return parseBigIntLiteral(parser, context);
    }
    const node = {
        type: 'Literal',
        value: tokenValue,
    };
    if (parser.options.raw) {
        node.raw = tokenRaw;
    }
    nextToken(parser, context);
    parser.assignable = 2;
    return parser.finishNode(node, tokenStart);
}`, `function parseLiteral(parser, context) {
    const tokenValue = parser.tokenValue, tokenRaw = parser.tokenRaw, tokenIndex = parser.tokenIndex;
    if (parser.token === 134283389) return parseBigIntLiteral(parser, context);
    const node = { type: 'Literal', value: tokenValue };
    if (parser.options.raw) node.raw = tokenRaw;
    nextToken(parser, context);
    parser.assignable = 2;
    node.start = tokenIndex;
    node.end = parser.startIndex;
    return node;
}`, 'literal leaf')
  return code
}

// These specializations belong only to this decoder's pinned parser call, not
// to Meriyah's general API. A dependency/options drift must stop generation.
export function transformDecoderDependency(source, id) {
  const file = id.replaceAll('\\', '/')
  const code = source.replaceAll('\r\n', '\n')
  if (file.endsWith('/youtubei.js/dist/src/utils/javascript/JsAnalyzer.js')) {
    expectOccurrences(code, 'parseScript(', 1, 'analyzer parser call')
    expectOccurrences(code, analyzerParse, 1, 'analyzer parser options')
    // The extractor accepts start/end; the redundant per-node range array is
    // unnecessary. finishNode below is specialized to exactly these options.
    return { code: code.replace(analyzerParse, analyzerParse.replace('ranges: true',
      'ranges: { start: true, end: true, range: false }')), map: null }
  }
  if (!file.endsWith('/meriyah/dist/meriyah.mjs')) return null
  // The snapshot consumers include disabled general-parser features. A changed
  // source needs review even when its version or the hot-site counts stay equal.
  if (crypto.createHash('sha256').update(code).digest('hex') !== '6f4a5b2e134d8dc9bf1d389f6febba483bba7f128b8e2d87d5764f5e06199c1c') {
    throw new Error('Review Meriyah source compatibility')
  }
  expectOccurrences(code, '    getToken() {\n        return this.token;\n    }', 1, 'Meriyah token getter')
  expectOccurrences(code, 'parser.getToken()', 502, 'Meriyah token call sites')
  expectOccurrences(code, originalFinishNode, 1, 'Meriyah node offsets')
  expectOccurrences(code, 'structuredClone(original)', 2, 'Meriyah AST clone')
  return { code: cloneSyntaxNode + specializePositions(code
    .replaceAll('structuredClone(original)', 'cloneSyntaxNode(original)')
    .replaceAll('parser.getToken()', 'parser.token')
    .replace(originalFinishNode, `    finishNode(node, start, end) {
        node.start = typeof start === 'number' ? start - 1 : start.index;
        node.end = end ? (typeof end === 'number' ? end - 1 : end.index) : this.startIndex;
        return node;
    }`)), map: null }
}

async function buildDecoder() {
  const [youtubeiPackage, meriyahPackage] = await Promise.all(['youtubei.js', 'meriyah'].map(async name =>
    JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')),
  ))
  assertDecoderCompatibility(youtubeiPackage.version, meriyahPackage.version)
  const licenses = await Promise.all(['youtubei.js/LICENSE', 'meriyah/LICENSE.md'].map(async name =>
    (await fs.readFile(path.join(root, 'node_modules', name), 'utf8')).replaceAll('\r\n', '\n').trim(),
  ))
  const bundle = await rolldown({
    cwd: root,
    input: 'src-tauri/src/youtube-decoder.js',
    platform: 'neutral',
    treeshake: true,
    plugins: [{
      name: 'bounded-decoder-parser',
      transform: transformDecoderDependency,
    }],
    onwarn(warning) { throw new Error(warning.message) },
  })
  try {
    const { output } = await bundle.generate({
      format: 'iife',
      minify: false,
      sourcemap: false,
      banner: '// Generated by scripts/build-youtube-decoder.mjs. youtubei.js 18.1.0 (MIT), Meriyah (ISC).\n// Contains parser/extractor code only; no downloaded player source or request data.\n/*\n' + licenses.join('\n\n') + '\n*/',
    })
    if (output.length !== 1 || output[0].type !== 'chunk' || output[0].imports.length || output[0].dynamicImports.length) {
      throw new Error('Decoder must be one self-contained JavaScript chunk')
    }
    const code = output[0].code.replaceAll('\r\n', '\n')
    const destination = path.join(root, 'src-tauri/src/youtube-decoder.bundle.js')
    if (process.argv.includes('--check')) {
      if (await fs.readFile(destination, 'utf8') !== code) throw new Error('Decoder bundle is stale; run npm run build:youtube-decoder')
    } else {
      await fs.writeFile(destination, code, 'utf8')
    }
    console.log(JSON.stringify({ bytes: Buffer.byteLength(code), sha256: crypto.createHash('sha256').update(code).digest('hex') }))
  } finally {
    await bundle.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDecoder()
