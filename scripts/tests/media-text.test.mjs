import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const exports = {}
const source = ts.transpileModule(readFileSync(new URL('../../src/lib/media-text.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
vm.runInNewContext(source, { exports, URL })
const { activeCue, textSourceUrl } = exports

test('timed text follows seeks in both directions, gaps, duplicate starts, and exact cue ends', () => {
  const cues = [
    { start: 2, end: 5, text: 'A' },
    { start: 7, end: null, text: 'B' },
    { start: 10, end: 15, text: 'C' },
    { start: 10, end: 15, text: 'D' },
    { start: 20, end: null, text: 'E' },
  ]
  for (const [seconds, index] of [[0, -1], [2, 0], [4.9, 0], [5, -1], [6, -1], [7, 1], [10, 3], [15, -1], [21, 4], [3, 0]]) {
    assert.equal(activeCue(cues, seconds), index, String(seconds))
  }
  for (const invalid of [-1, NaN, Infinity]) assert.equal(activeCue(cues, invalid), -1)
  assert.equal(activeCue([], 30), -1)
})

test('source attribution only links valid web URLs without credentials', () => {
  assert.equal(textSourceUrl('https://lrclib.net/tracks/42'), 'https://lrclib.net/tracks/42')
  assert.equal(textSourceUrl('http://example.org/transcript.txt'), 'http://example.org/transcript.txt')
  for (const invalid of ['javascript:alert(1)', 'file:///secret', 'data:text/html,test', '/transcript', 'https://user:secret@example.org/t', '']) {
    assert.equal(textSourceUrl(invalid), null, invalid)
  }
})
