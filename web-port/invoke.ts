import type { InvokeArgs } from '@tauri-apps/api/core'
import type { ImportTrack, LibraryData, LibTrack, TrackQuery } from '../src/lib/types'
import * as catalog from './catalog'
import * as audio from './audio'
import { openOfficialYouTube } from './official-youtube.svelte'
import * as podcasts from './podcasts'
import { readPlaylistCsv, readSpotifyPlaylist } from './imports'
import { shareWebLog } from './diagnostics'
import { listDownloads, enqueueDownloads, cancelDownloads, removeDownloads } from './downloads'
import { configureDownloadMetadata } from './download-store'
import { handlesStorage, readStoredTrack, storageInvoke } from './storage'

// Read the current editor metadata without coupling the download/audio modules to the library.
configureDownloadMetadata(readStoredTrack)

const unavailable = (feature: string): never => { throw new Error(`${feature} todavía no está disponible en la versión web.`) }
let searchController: AbortController | undefined

export async function webInvoke<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
  if (args && (Array.isArray(args) || ArrayBuffer.isView(args) || args instanceof ArrayBuffer)) throw new Error('Petición web no válida.')
  const values = (args ?? {}) as Record<string, unknown>
  if (command === 'library') {
    const [library, entries] = await Promise.all([storageInvoke(command, values) as Promise<LibraryData>, listDownloads()])
    return { ...library, downloadedIds: entries.map((entry) => entry.track.id) } as T
  }
  if (handlesStorage(command)) return await storageInvoke(command, values) as T
  let result: unknown
  switch (command) {
    case 'search': {
      searchController?.abort()
      const controller = new AbortController()
      searchController = controller
      try { result = await catalog.search(String(values.query ?? ''), { signal: controller.signal }) }
      finally { if (searchController === controller) searchController = undefined }
      break
    }
    case 'discovery': result = await catalog.discovery(); break
    case 'artist': result = await catalog.artist(Number(values.id)); break
    case 'album': result = await catalog.album(Number(values.id)); break
    case 'related_artists': result = await catalog.relatedArtists(Number(values.id)); break
    case 'artist_albums': result = await catalog.artistAlbums(Number(values.id)); break
    case 'resolve': result = await audio.resolveTrack(values.track as TrackQuery, values.refresh === true); break
    case 'alternatives': result = await audio.alternatives(values.track as TrackQuery); break
    case 'choose_source': result = await audio.chooseSource(values.track as TrackQuery, String(values.videoId ?? '')); break
    case 'open_youtube_player': {
      result = await openOfficialYouTube(values.track as TrackQuery)
      break
    }
    case 'preview_youtube_track': result = await audio.previewYouTube(String(values.url ?? '')); break
    case 'match_import_track': result = await catalog.matchImportTrack(values.track as ImportTrack); break
    case 'local_library': result = { folders: [], albums: [], artists: [], tracks: 0, scanning: false }; break
    case 'downloads_list': result = await listDownloads(); break
    case 'download': result = await enqueueDownloads(values.tracks as LibTrack[]); break
    case 'cancel_downloads': result = await cancelDownloads(); break
    case 'remove_downloads': result = await removeDownloads(values.trackIds as number[]); break
    case 'newer_version': result = null; break
    case 'install_update': {
      const { applyWebUpdate } = await import('./updates.svelte')
      result = await applyWebUpdate(); break
    }
    case 'read_spotify_playlist': result = await readSpotifyPlaylist(String(values.url ?? '')); break
    case 'read_playlist_csv': result = readPlaylistCsv(String(values.content ?? ''), String(values.name ?? '')); break
    case 'podcast_search': result = await podcasts.search(String(values.query ?? ''), String(values.language ?? 'all')); break
    case 'podcast_detail': result = await podcasts.detail(String(values.feedUrl ?? '')); break
    case 'podcast_feed_url': result = await podcasts.feedUrl(Number(values.id)); break
    case 'player_native': {
      if (values.cmd !== 'shareLog') throw new Error('Esta acción del sistema no está disponible en el navegador.')
      result = await shareWebLog(); break
    }
    case 'add_local_folder': case 'scan_local': case 'remove_local_folder': unavailable('La importación de carpetas'); break
    default: throw new Error('Esta acción necesita una adaptación para la versión web.')
  }
  return result as T
}
