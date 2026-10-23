// Pure browser-compatible comparison, independent of provider names or song titles.
// Inputs are AudioBuffers decoded in RAM. Zero padding permits tiny signed offsets.
export function compareRecordingWaveform(candidateBuffer, referenceBuffer, negativeBuffer) {
  const sampleRate = 2205, paddingSeconds = 0.5
  const mono = buffer => {
    const step = buffer.sampleRate / sampleRate, result = new Float64Array(Math.floor(buffer.length / step))
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    for (let i = 0; i < result.length; i++) {
      let sum = 0, count = 0
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) for (const data of channels) { sum += data[j]; count++ }
      result[i] = sum / count
    }
    return result
  }
  const fft = (real, imag, inverse = false) => {
    const n = real.length
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]] }
    }
    for (let width = 2; width <= n; width <<= 1) {
      const angle = (inverse ? 2 : -2) * Math.PI / width, wr = Math.cos(angle), wi = Math.sin(angle)
      for (let start = 0; start < n; start += width) {
        let ur = 1, ui = 0
        for (let j = 0; j < width / 2; j++) {
          const even = start + j, odd = even + width / 2
          const vr = real[odd] * ur - imag[odd] * ui, vi = real[odd] * ui + imag[odd] * ur
          real[odd] = real[even] - vr; imag[odd] = imag[even] - vi
          real[even] += vr; imag[even] += vi
          const next = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = next
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n }
  }
  const correlate = (candidate, reference) => {
    const n = candidate.length, m = reference.length
    if (m > n || m < sampleRate) throw new Error('Invalid waveform reference window')
    const mean = reference.reduce((sum, sample) => sum + sample, 0) / m
    let referenceEnergy = 0, size = 1
    while (size < n + m - 1) size <<= 1
    const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size)
    ar.set(candidate)
    for (let i = 0; i < m; i++) { const value = reference[i] - mean; br[m - 1 - i] = value; referenceEnergy += value * value }
    if (referenceEnergy < 1e-9) throw new Error('Reference has insufficient non-silent energy')
    fft(ar, ai); fft(br, bi)
    for (let i = 0; i < size; i++) { const real = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = real }
    fft(ar, ai, true)
    let sum = 0, energy = 0
    for (let i = 0; i < m; i++) { sum += candidate[i]; energy += candidate[i] ** 2 }
    let best = { correlation: -Infinity, offsetSeconds: null }
    for (let offset = 0; offset <= n - m; offset++) {
      const variance = energy - sum * sum / m
      const correlation = variance > 1e-12 ? ar[offset + m - 1] / Math.sqrt(variance * referenceEnergy) : 0
      if (correlation > best.correlation) best = { correlation, offsetSeconds: offset / sampleRate - paddingSeconds }
      if (offset < n - m) { sum += candidate[offset + m] - candidate[offset]; energy += candidate[offset + m] ** 2 - candidate[offset] ** 2 }
    }
    return { ...best, referenceSeconds: m / sampleRate }
  }
  const rawCandidate = mono(candidateBuffer), candidate = new Float64Array(rawCandidate.length + sampleRate)
  candidate.set(rawCandidate, sampleRate * paddingSeconds)
  const reference = mono(referenceBuffer), full = correlate(candidate, reference), windows = []
  for (const start of [0, 10, 20]) {
    const end = Math.min(reference.length, (start + 8) * sampleRate)
    if (end - start * sampleRate < 5 * sampleRate) continue
    const comparison = correlate(candidate, reference.subarray(start * sampleRate, end))
    windows.push({ referenceStartSeconds: start, ...comparison, inferredPreviewStartInCandidateSeconds: comparison.offsetSeconds - start })
  }
  const selfStart = Math.min(40, Math.max(0, candidateBuffer.duration - 10)), self = correlate(candidate, rawCandidate.subarray(Math.floor(selfStart * sampleRate), Math.floor((selfStart + 8) * sampleRate)))
  const negative = negativeBuffer ? correlate(candidate, mono(negativeBuffer)) : null
  const alignmentSpreadSeconds = Math.max(...windows.map(window => window.inferredPreviewStartInCandidateSeconds)) - Math.min(...windows.map(window => window.inferredPreviewStartInCandidateSeconds))
  const matched = full.correlation >= 0.8 && windows.length >= 3 && windows.every(window => window.correlation >= 0.8) && alignmentSpreadSeconds <= 0.03 && self.correlation >= 0.99 && !!negative && negative.correlation < 0.4
  return { algorithm: 'Mean-removed normalized waveform cross-correlation, FFT, mono 2205 Hz, +/-500ms mathematical padding, 3 separated windows; no tempo/pitch transforms.', full, windows, alignmentSpreadSeconds, selfControl: self, negativeControl: negative, matched,
    thresholds: { full: 0.8, eachWindow: 0.8, maximumAlignmentSpreadSeconds: 0.03, selfControl: 0.99, maximumNegativeControl: 0.4 },
    coverageLimit: 'Only the official approximately 30-second excerpt and its separated windows are compared; not a proof of every second of the full recording.' }
}
