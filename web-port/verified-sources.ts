/**
 * Curated source data, not a title-based search result.
 * The product must independently opt in, check the catalog identity and verify
 * the whole fetched file against bytes/SHA-256 before trusting this source.
 * Public web access does not establish permission for offline downloads.
 */
export const IRITSI_ALEA_CANDIDATE = Object.freeze({
  enabled: true,
  provider: 'alea' as const,
  id: 'kantari-iritsi-da-eguna-2016',
  url: 'https://alea.tok-md.com/iritsidaeguna.mp3',
  article: 'https://alea.eus/araba/1473099329086-iritsi-da-eguna-pirritx-eta-porrotx',
  identity: Object.freeze({
    catalogId: 3250715431,
    isrc: 'QM6N21424821',
    title: 'Iritsi da Eguna',
    artist: 'Pirritx eta Porrotx',
    album: 'Eskerrik Asko!',
    catalogDurationSeconds: 169,
  }),
  file: Object.freeze({
    bytes: 4_633_634,
    sha256: '35d6526ad255d903c0a2bfced09a7b3854f5ab6ff3404d37f19be4786564724f',
    mime: 'audio/mpeg',
    durationSeconds: 187.1684126984127,
    sampleRate: 44100,
    channels: 2,
    firstNonzeroSample: 405_552,
    lastNonzeroSample: 7_953_358,
    // This starts inside a proven exactly-zero prefix, >=250 ms before sound.
    proposedStartOffsetSeconds: 8.94,
    trimEnd: false,
  }),
  download: Object.freeze({ allowed: false, reason: 'No explicit music download permission verified.' }),
  verification: Object.freeze({
    status: 'independent-reference-excerpts-match' as const,
    report: 'artifacts/pwa-port/iritsi-recording-identity-2026-10-22-final.json',
    checkedAt: '2026-10-22T21:33:25.768Z',
    algorithm: 'Normalized mono waveform cross-correlation at 2205 Hz, separated 8 s windows, distinct musical and self controls.',
    deezer: Object.freeze({ id: 3250715431, isrc: 'QM6N21424821', referenceSeconds: 29.98857142857143, correlation: 0.9703016013081601, candidateOffsetSeconds: 8.766893424036281 }),
    apple: Object.freeze({ id: 1804714528, isrcExposed: false, referenceSeconds: 29.952290249433105, correlation: 0.8840807583776862, candidateOffsetSeconds: 8.791836734693877 }),
    negativeControl: Object.freeze({ catalogId: 3250715411, title: 'Bi Izar', correlation: 0.01899094418603424 }),
    completeMasterVerified: false,
    referenceCoverage: 'Both official previews cover nearly the same approximately 30-second interval. Offset is relative to the preview; the remaining recording is not independently compared.',
    physicalBackgroundVerified: false,
  }),
})
