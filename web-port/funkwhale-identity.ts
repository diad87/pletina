import type { TrackQuery } from '../src/lib/types'
import type { FunkwhaleCandidate } from './funkwhale'
import generatedIndex from './funkwhale-identity-index.json'

export interface VerifiedFunkwhaleEntry {
  catalog: { id: number; isrc: string; title: string; titleVersion: string; artist: string; album: string; duration: number; artistId: number; albumId: number }
  source: { provider: 'funkwhale'; pod: 'https://open.audio'; apiVersion: 'v2'; trackId: number; trackUuid: string; uploadUuid: string;
    contentLength: number; sha256: string; mime: string; extension: string; codec: string; bitrate: number | null; lossless: boolean; duration: number;
    isrc: string | null; recordingMbid: string | null; declaredLicense: string | null }
  file: { bytes: number; sha256: string; mime: string; durationSeconds: number }
  proof: { generatedAt: string; identityScope: 'official-excerpt-only'; fullMasterVerified: false; physicalBackgroundVerified: false;
    candidateAudio: { duration: number; sampleRate: number; channels: number };
    reference: { catalogId: number; isrc: string; sha256: string; bytes: number; duration: number };
    negative: { catalogId: number; isrc: string; title: string; artist: string; album: string; sha256: string; bytes: number; duration: number };
    comparison: { matched: boolean; full: { correlation: number }; windows: { correlation: number; referenceStartSeconds: number; inferredPreviewStartInCandidateSeconds: number }[];
      alignmentSpreadSeconds: number; selfControl: { correlation: number }; negativeControl: { correlation: number } } }
  downloadAllowed: false
}
export type FunkwhaleIdentityEntry = VerifiedFunkwhaleEntry
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const isrc = (value: unknown): string | null => typeof value === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value.trim().replaceAll('-', '').toUpperCase()) ? value.trim().replaceAll('-', '').toUpperCase() : null
const label = (value: unknown): value is string => typeof value === 'string' && value.length <= 500 && !!normalize(value)
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 250_000_000_000_000
const correlation = (value: unknown, min = .8) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= 1.0001
const validDuration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 900

function validEntry(value: unknown): value is VerifiedFunkwhaleEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as VerifiedFunkwhaleEntry, catalog = entry.catalog, source = entry.source, proof = entry.proof, comparison = proof?.comparison
  if (!catalog || !source || !proof || !id(catalog.id) || !id(catalog.artistId) || !id(catalog.albumId) || !isrc(catalog.isrc) ||
    !label(catalog.title) || !label(catalog.artist) || !label(catalog.album) || typeof catalog.titleVersion !== 'string' || catalog.titleVersion.length > 500 || !validDuration(catalog.duration) ||
    source.provider !== 'funkwhale' || source.pod !== 'https://open.audio' || source.apiVersion !== 'v2' || !id(source.trackId) || !UUID.test(source.trackUuid) || !UUID.test(source.uploadUuid) ||
    !Number.isSafeInteger(source.contentLength) || source.contentLength < 1 || source.contentLength > 32 * 1024 ** 2 || !HASH.test(source.sha256) ||
    !/^audio\/[a-z0-9.+-]+$/.test(source.mime) || !/^[a-z0-9]{2,5}$/.test(source.extension) || !label(source.codec) || typeof source.lossless !== 'boolean' ||
    !validDuration(source.duration) || Math.abs(source.duration - catalog.duration) > 3 || (source.isrc != null && isrc(source.isrc) !== isrc(catalog.isrc)) || source.recordingMbid != null ||
    !entry.file || entry.file.bytes !== source.contentLength || entry.file.sha256 !== source.sha256 || entry.file.mime !== source.mime || !validDuration(entry.file.durationSeconds) || Math.abs(entry.file.durationSeconds - catalog.duration) > 3 ||
    entry.downloadAllowed !== false || proof.identityScope !== 'official-excerpt-only' || proof.fullMasterVerified !== false || proof.physicalBackgroundVerified !== false ||
    !Number.isFinite(Date.parse(proof.generatedAt)) || !validDuration(proof.candidateAudio?.duration) || Math.abs(proof.candidateAudio.duration - catalog.duration) > 3 ||
    proof.reference?.catalogId !== catalog.id || isrc(proof.reference?.isrc) !== isrc(catalog.isrc) || !HASH.test(proof.reference?.sha256) ||
    !id(proof.negative?.catalogId) || proof.negative.catalogId === catalog.id || !isrc(proof.negative?.isrc) || isrc(proof.negative.isrc) === isrc(catalog.isrc) ||
    !label(proof.negative.artist) || !label(proof.negative.album) || !label(proof.negative.title) || normalize(proof.negative.artist) !== normalize(catalog.artist) || normalize(proof.negative.album) !== normalize(catalog.album) || !HASH.test(proof.negative?.sha256) ||
    comparison?.matched !== true || !correlation(comparison.full?.correlation) || !Array.isArray(comparison.windows) || comparison.windows.length !== 3 ||
    !comparison.windows.every((window, position) => window.referenceStartSeconds === position * 10 && correlation(window.correlation) && Number.isFinite(window.inferredPreviewStartInCandidateSeconds)) ||
    !Number.isFinite(comparison.alignmentSpreadSeconds) || comparison.alignmentSpreadSeconds < 0 || comparison.alignmentSpreadSeconds > .03 ||
    !correlation(comparison.selfControl?.correlation, .99) || !correlation(comparison.negativeControl?.correlation, 0) || comparison.negativeControl.correlation >= .4) return false
  const offsets = comparison.windows.map(window => window.inferredPreviewStartInCandidateSeconds)
  return Math.max(...offsets) - Math.min(...offsets) <= .03
}
const index = generatedIndex as unknown as { schemaVersion?: number; policy?: { identityScope?: string; fullMasterVerified?: boolean; downloadAllowed?: boolean; mediaPersisted?: boolean }; entries?: unknown[] }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
const entries: readonly VerifiedFunkwhaleEntry[] = index.schemaVersion === 1 && index.policy?.identityScope === 'official-excerpt-only' &&
  index.policy.fullMasterVerified === false && index.policy.downloadAllowed === false && index.policy.mediaPersisted === false && Array.isArray(index.entries)
  ? index.entries.filter(validEntry).map(freeze) : []

/** This preliminary lookup never consults a provider or relaxes recording identity. */
export function hasIndexedFunkwhaleCatalogId(catalogId: number): boolean { return id(catalogId) && entries.some(entry => entry.catalog.id === catalogId) }

/** Require hydrated catalog identity before exposing any approved provider locator. */
export function getVerifiedFunkwhaleEntries(track: TrackQuery): readonly VerifiedFunkwhaleEntry[] {
  if (!track || !id(track.id) || !isrc(track.isrc) || !label(track.title) || !label(track.artist) || !label(track.album) ||
    (track.titleVersion != null && typeof track.titleVersion !== 'string') || !validDuration(track.duration)) return []
  return entries.filter(entry => entry.catalog.id === track.id && isrc(entry.catalog.isrc) === isrc(track.isrc) &&
    normalize(entry.catalog.title) === normalize(track.title) && normalize(entry.catalog.titleVersion) === normalize(track.titleVersion ?? '') &&
    normalize(entry.catalog.artist) === normalize(track.artist) && normalize(entry.catalog.album) === normalize(track.album) && Math.abs(entry.catalog.duration - track.duration) <= 3)
}

/** Locator, encoding and metadata must all agree; callers must also hash the fetched whole file. */
export function matchVerifiedFunkwhaleCandidate(track: TrackQuery, candidate: FunkwhaleCandidate, entry: VerifiedFunkwhaleEntry): boolean
export function matchVerifiedFunkwhaleCandidate(track: TrackQuery, candidate: FunkwhaleCandidate): VerifiedFunkwhaleEntry | null
export function matchVerifiedFunkwhaleCandidate(track: TrackQuery, candidate: FunkwhaleCandidate, entry?: VerifiedFunkwhaleEntry): VerifiedFunkwhaleEntry | null | boolean {
  const approved = getVerifiedFunkwhaleEntries(track)
  if (!approved.length || !candidate || candidate.provider !== 'funkwhale' || candidate.pod !== 'https://open.audio' || candidate.apiVersion !== 'v2' ||
    !label(candidate.title) || !label(candidate.artist) || !label(candidate.album) || (candidate.titleVersion != null && typeof candidate.titleVersion !== 'string') ||
    (candidate.isrc != null && isrc(candidate.isrc) !== isrc(track.isrc)) || candidate.recordingMbid != null ||
    normalize(candidate.title) !== normalize(track.title) || normalize(candidate.titleVersion ?? '') !== normalize(track.titleVersion ?? '') ||
    normalize(candidate.artist) !== normalize(track.artist) || normalize(candidate.album) !== normalize(track.album) || !validDuration(candidate.duration)) return entry ? false : null
  const matched = approved.find(indexed => indexed.source.pod === candidate.pod && indexed.source.trackId === candidate.trackId &&
    indexed.source.trackUuid === candidate.trackUuid && indexed.source.uploadUuid === candidate.uploadUuid && indexed.source.contentLength === candidate.contentLength &&
    indexed.source.mime === candidate.mime && indexed.source.extension === candidate.extension && indexed.source.codec === candidate.codec && indexed.source.lossless === candidate.lossless &&
    indexed.source.bitrate === candidate.bitrate &&
    Math.abs(indexed.source.duration - candidate.duration) <= 3) ?? null
  return entry ? matched === entry : matched
}
