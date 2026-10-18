import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVideoId, validAudioUrl } from '../../pwa/player/resolver.mjs'
import { parseQueue } from '../../pwa/player/entry.mjs'

test('acepta IDs y enlaces habituales sin confundir dominios parecidos', () => {
  for (const value of [
    ' aqz-KE-bpKQ ', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=x',
    'https://youtu.be/aqz-KE-bpKQ?t=10', 'https://m.youtube.com/shorts/aqz-KE-bpKQ',
    'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ', 'https://youtube.com/live/aqz-KE-bpKQ',
  ]) assert.equal(parseVideoId(value), 'aqz-KE-bpKQ')
  for (const value of [
    '', 'abcdefghij', 'https://youtube.com.evil.invalid/watch?v=aqz-KE-bpKQ',
    'https://notyoutube.com/watch?v=aqz-KE-bpKQ', 'javascript:aqz-KE-bpKQ',
    'https://name:password@youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtu.be/invalid',
  ]) assert.throws(() => parseVideoId(value))
})

test('solo acepta audio HTTPS del dominio de Google Video sin credenciales ni puertos ajenos', () => {
  assert.equal(validAudioUrl('https://rr1---example.googlevideo.com/videoplayback?example=1'), 'https://rr1---example.googlevideo.com/videoplayback?example=1')
  for (const value of [
    'http://rr1.googlevideo.com/audio', 'https://googlevideo.com.evil.invalid/audio',
    'https://notgooglevideo.com/audio', 'https://name:password@googlevideo.com/audio',
    'https://googlevideo.com:444/audio', 'data:audio/mp4;base64,AAAA', 'invalid',
  ]) assert.throws(() => validAudioUrl(value))
})

test('la cola conserva el orden y las repeticiones, e identifica la línea incorrecta', () => {
  assert.deepEqual(parseQueue('aqz-KE-bpKQ\n\nhttps://youtu.be/aqz-KE-bpKQ\n').map((item) => item.id), ['aqz-KE-bpKQ', 'aqz-KE-bpKQ'])
  assert.throws(() => parseQueue(''), /Añade al menos/)
  assert.throws(() => parseQueue('aqz-KE-bpKQ\nno válido'), /línea 2/)
  assert.throws(() => parseQueue('aqz-KE-bpKQ\n\nno válido'), /línea 3/)
  assert.throws(() => parseQueue(Array(101).fill('aqz-KE-bpKQ').join('\n')), /100 canciones/)
})
