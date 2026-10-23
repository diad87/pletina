// The decoding VM needs no parser or analyzer. The implementation is shared
// with the preparation asset so its inputs, compilation and validation agree.
import { decode } from './youtube-decoder-values.js'

Object.defineProperty(globalThis, '__musifyYouTubeDecoder', {
  value: Object.freeze({ decode }), writable: false, configurable: true,
})
