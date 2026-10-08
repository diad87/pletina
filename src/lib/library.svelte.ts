import { SvelteSet } from 'svelte/reactivity'
import * as api from './api'
import type { QueueItem } from './player.svelte'
import { toast } from './toast.svelte'
import type { AlbumDetail, LibraryData, LibTrack, PlaylistSummary, Podcast, SavedAlbum, SavedArtist } from './types'

/** De canción en la cola a canción de biblioteca. */
export function toLib(item: QueueItem): LibTrack {
  return {
    id: item.track.id,
    title: item.track.title,
    duration: item.track.duration,
    explicit: item.track.explicitLyrics,
    artistId: item.track.artist.id,
    artistName: item.track.artist.name,
    albumId: item.albumId,
    albumTitle: item.albumTitle,
    albumArtistId: item.artistId,
    cover: item.cover,
  }
}

/** De canción de biblioteca a canción reproducible. */
export function fromLib(t: LibTrack): QueueItem {
  return {
    track: {
      id: t.id,
      title: t.title,
      titleVersion: null,
      duration: t.duration,
      trackPosition: 0,
      diskNumber: 0,
      explicitLyrics: t.explicit,
      isrc: null,
      artist: { id: t.artistId, name: t.artistName },
    },
    albumId: t.albumId,
    albumTitle: t.albumTitle,
    artistId: t.albumArtistId,
    cover: t.cover,
  }
}

export function albumToSaved(album: AlbumDetail): SavedAlbum {
  return {
    id: album.id,
    title: album.title,
    artistId: album.artist.id,
    artistName: album.artist.name,
    cover: album.coverBig,
    releaseDate: album.releaseDate,
    recordType: album.recordType,
  }
}

class Library {
  liked = new SvelteSet<number>()
  albums = $state<SavedAlbum[]>([])
  artists = $state<SavedArtist[]>([])
  savingArtists = new SvelteSet<number>()
  podcasts = $state<Podcast[]>([])
  savingPodcasts = new SvelteSet<number>()
  #podcastRevision = 0
  #podcastChanges = new Map<number, number>()
  playlists = $state<PlaylistSummary[]>([])
  /** Sube con cada cambio; las vistas de biblioteca lo leen para recargarse. */
  version = $state(0)
  /** Sube con cada escucha apuntada en el historial. */
  historyVersion = $state(0)

  async load(): Promise<LibraryData | null> {
    const podcastRevision = this.#podcastRevision
    try {
      const data = await api.library()
      this.liked.clear()
      for (const id of data.likedIds) this.liked.add(id)
      this.albums = data.albums
      this.artists = data.artists
      // Una lectura anterior no debe deshacer un guardado, ni adelantar su resultado.
      // Los demás programas sí se cargan, también durante el arranque de la app.
      const protectedPodcasts = new Set(this.savingPodcasts)
      for (const [id, revision] of this.#podcastChanges) {
        if (revision > podcastRevision) protectedPodcasts.add(id)
      }
      this.podcasts = [
        ...this.podcasts.filter((podcast) => protectedPodcasts.has(podcast.id)),
        ...data.podcasts.filter((podcast) => !protectedPodcasts.has(podcast.id)),
      ]
      this.playlists = data.playlists
      return data
    } catch (e) {
      toast.show(`No se pudo cargar la biblioteca: ${e}`)
      return null
    }
  }

  isSaved(albumId: number) {
    return this.albums.some((a) => a.id === albumId)
  }

  isArtistSaved(artistId: number) {
    return this.artists.some((artist) => artist.id === artistId)
  }

  isPodcastSaved(podcastId: number) {
    return this.podcasts.some((podcast) => podcast.id === podcastId)
  }

  async togglePodcast(podcast: Podcast) {
    if (this.savingPodcasts.has(podcast.id)) return
    const saved = !this.isPodcastSaved(podcast.id)
    this.savingPodcasts.add(podcast.id)
    try {
      await api.setPodcastSaved(podcast.id, saved)
      this.podcasts = this.podcasts.filter((item) => item.id !== podcast.id)
      if (saved) this.podcasts.unshift(podcast)
      this.#podcastChanges.set(podcast.id, ++this.#podcastRevision)
      this.version++
      toast.show(saved ? 'Programa añadido a Tus pódcasts' : 'Programa quitado de Tus pódcasts')
    } catch (e) {
      toast.show(`No se pudo guardar el pódcast: ${e}`)
    } finally {
      this.savingPodcasts.delete(podcast.id)
    }
  }

  async toggleArtist(artist: SavedArtist) {
    if (this.savingArtists.has(artist.id)) return
    const saved = !this.isArtistSaved(artist.id)
    this.savingArtists.add(artist.id)
    try {
      await api.setArtistSaved(artist, saved)
      this.artists = this.artists.filter((item) => item.id !== artist.id)
      if (saved) this.artists.unshift(artist)
      this.version++
      toast.show(saved ? 'Artista añadido a favoritos' : 'Artista quitado de favoritos')
    } catch (e) {
      toast.show(`No se pudo guardar el artista: ${e}`)
    } finally {
      this.savingArtists.delete(artist.id)
    }
  }

  async toggleLike(item: QueueItem) {
    const id = item.track.id
    const liked = !this.liked.has(id)
    // Al momento en pantalla; si falla, se deshace.
    if (liked) this.liked.add(id)
    else this.liked.delete(id)
    try {
      await api.setLiked(toLib(item), liked)
      this.version++
      toast.show(liked ? 'Añadida a Canciones que te gustan' : 'Quitada de Canciones que te gustan')
    } catch (e) {
      if (liked) this.liked.delete(id)
      else this.liked.add(id)
      toast.show(`No se pudo guardar: ${e}`)
    }
  }

  async toggleAlbum(album: AlbumDetail) {
    const saved = !this.isSaved(album.id)
    await this.#run(api.setAlbumSaved(albumToSaved(album), saved), saved ? 'Disco guardado en tu biblioteca' : 'Disco quitado de tu biblioteca')
  }

  /** Crea una playlist (opcionalmente con canciones) y la devuelve. */
  async createPlaylist(items: QueueItem[] = []): Promise<PlaylistSummary | null> {
    const name = `Mi playlist n.º ${this.playlists.length + 1}`
    try {
      const created = await api.createPlaylist(name, items.map(toLib))
      await this.#refresh()
      toast.show(items.length ? `Creada «${created.name}» con ${count(items.length)}` : `Creada «${created.name}»`)
      return created
    } catch (e) {
      toast.show(`No se pudo crear la playlist: ${e}`)
      return null
    }
  }

  async addToPlaylist(playlist: PlaylistSummary, items: QueueItem[]) {
    await this.#run(api.addToPlaylist(playlist.id, items.map(toLib)), `${capitalize(count(items.length))} añadida${items.length === 1 ? '' : 's'} a «${playlist.name}»`)
  }

  async removeFromPlaylist(playlistId: number, entryId: number) {
    await this.#run(api.removeFromPlaylist(playlistId, entryId), 'Quitada de la playlist')
  }

  async moveInPlaylist(playlistId: number, entryId: number, to: number) {
    await this.#run(api.moveInPlaylist(playlistId, entryId, to))
  }

  async renamePlaylist(id: number, name: string) {
    await this.#run(api.renamePlaylist(id, name))
  }

  async deletePlaylist(id: number) {
    const name = this.playlists.find((p) => p.id === id)?.name
    await this.#run(api.deletePlaylist(id), name ? `Eliminada «${name}»` : 'Playlist eliminada')
  }

  async clearHistory() {
    await this.#run(api.clearHistory(), 'Historial borrado')
    this.historyVersion++
  }

  async #run(op: Promise<unknown>, done?: string) {
    try {
      await op
      await this.#refresh()
      if (done) toast.show(done)
    } catch (e) {
      toast.show(`No se pudo guardar: ${e}`)
    }
  }

  async #refresh() {
    await this.load()
    this.version++
  }
}

const count = (n: number) => (n === 1 ? '1 canción' : `${n} canciones`)
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const library = new Library()
