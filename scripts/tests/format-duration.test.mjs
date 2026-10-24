import assert from 'node:assert/strict'
import test from 'node:test'
import { duration } from '../../src/lib/format.ts'

test('short audio keeps minutes and seconds without rounding into the next minute', () => {
  for (const [seconds, expected] of [[0, '0:00'], [5, '0:05'], [59.99, '0:59'], [60, '1:00'], [3599.99, '59:59']]) {
    assert.equal(duration(seconds), expected)
  }
})

test('podcast counters switch to hours exactly at one hour', () => {
  for (const [seconds, expected] of [[3600, '1:00:00'], [3601, '1:00:01'], [3930, '1:05:30'], [7263, '2:01:03']]) {
    assert.equal(duration(seconds), expected)
  }
})

test('long audio does not wrap the hour count at a day', () => {
  assert.equal(duration(24 * 3600 + 1), '24:00:01')
  assert.equal(duration(100 * 3600), '100:00:00')
})

test('unknown or invalid media time stays a valid zero counter', () => {
  for (const seconds of [-1, NaN, Infinity, -Infinity]) assert.equal(duration(seconds), '0:00')
})
