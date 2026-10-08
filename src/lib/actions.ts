// Menús de acciones de canciones y discos (clic derecho o botón "⋯").

import * as api from './api'
import { downloads } from './downloads.svelte'
import { toast } from './toast.svelte'
import type { AlbumDetail } from './types'
import { layout } from './layout.svelte'
import { library } from './library.svelte'
import { isLocal, isPodcast } from './media'
import type { MenuItem } from './menu.svelte'
import { nav } from './nav.svelte'
import { player, type QueueItem } from './player.svelte'
import { justCreated } from '../views/PlaylistView.svelte'

/** "Añadir a playlist ▸": nueva playlist + las que ya hay. */
export function addToPlaylistMenu(items: () => QueueItem[] | Promise<QueueItem[]>): MenuItem {
  return {
    label: 'Añadir a playlist',
    icon: 'plus',
    children: [
      {
        label: 'Nueva playlist',
        icon: 'plus',
        action: async () => {
          const created = await library.createPlaylist(await items())
          if (created) nav.go({ name: 'playlist', id: created.id })
        },
      },
      ...library.playlists.map((p, i) => ({
        label: p.name,
        separated: i === 0,
        action: async () => library.addToPlaylist(p, await items()),
      })),
    ],
  }
}

/** "Reproducir a continuación" y "Añadir a la cola" (para una canción o un disco entero). */
export function queueMenu(items: () => QueueItem[] | Promise<QueueItem[]>): MenuItem[] {
  return [
    { label: 'Reproducir a continuación', icon: 'next', action: async () => player.playNext(await items()) },
    { label: 'Añadir a la cola', icon: 'queue', action: async () => player.addToQueue(await items()) },
  ]
}

/** Clic derecho en la tarjeta de un disco. */
export function albumCardMenu(albumId: number): MenuItem[] {
  const tracks = async () => albumQueue(await api.album(albumId))
  return [
    { label: 'Reproducir', icon: 'play', action: () => playAlbum(albumId) },
    ...queueMenu(tracks),
    { ...addToPlaylistMenu(tracks), separated: true },
    { label: 'Ir al disco', icon: 'disc', action: () => nav.go({ name: 'album', id: albumId }) },
  ]
}

export function trackMenu(item: QueueItem, playlist?: { id: number; entryId: number }): MenuItem[] {
  const liked = library.liked.has(item.track.id)
  const items: MenuItem[] = [
    ...queueMenu(() => [item]),
    {
      label: liked ? 'Quitar de Canciones que te gustan' : 'Añadir a Canciones que te gustan',
      icon: liked ? 'heartFilled' : 'heart',
      separated: true,
      action: () => library.toggleLike(item),
    },
    addToPlaylistMenu(() => [item]),
  ]
  const id = item.track.id
  const podcast = isPodcast(id)
  if (isLocal(id)) {
    // Música local: ya está en el equipo y no viene de YouTube.
    items.push({ label: 'Mostrar en la carpeta', icon: 'folder', action: () => api.revealLocal(id).catch(() => {}) })
  } else if (downloads.done.has(id)) {
    items.push({ label: 'Quitar descarga', icon: 'trash', action: () => downloads.remove([id]) })
    // En el móvil las descargas están dentro de la app: no hay carpeta que enseñar.
    if (!layout.mobile) items.push({ label: 'Mostrar en la carpeta', icon: 'folder', action: () => api.revealDownload(id).catch(() => {}) })
  } else if (!podcast && !downloads.active.has(id) && layout.canDownload) {
    items.push({ label: 'Descargar', icon: 'download', action: () => downloads.start([item]) })
  }
  if (playlist) {
    items.push({
      label: 'Quitar de esta playlist',
      icon: 'trash',
      action: () => library.removeFromPlaylist(playlist.id, playlist.entryId),
    })
  }
  if (podcast) {
    items.push({ label: 'Ir al podcast', icon: 'disc', separated: true, action: () => nav.go({ name: 'podcast', id: item.albumId }) })
  } else {
    items.push(
      {
        label: 'Ir al artista',
        icon: 'user',
        separated: true,
        action: () => nav.go({ name: 'artist', id: item.track.artist.id }),
      },
      { label: 'Ir al disco', icon: 'disc', action: () => nav.go({ name: 'album', id: item.albumId }) },
    )
  }
  if (!isLocal(id) && !podcast) {
    items.push({ label: '¿No es esta canción?', icon: 'swap', separated: true, action: () => (player.picking = item) })
  }
  return items
}

/** Las canciones de un disco como cola de reproducción. */
export function albumQueue(album: AlbumDetail): QueueItem[] {
  return album.tracks.map((track) => ({
    track,
    albumId: album.id,
    albumTitle: album.title,
    artistId: album.artist.id,
    cover: album.coverBig,
  }))
}

/** ¿Está sonando ahora este disco? */
export const albumPlaying = (albumId: number) => player.current?.albumId === albumId && player.status === 'playing'

/** Reproduce un disco entero desde una tarjeta (o lo pausa si ya está sonando). */
export async function playAlbum(albumId: number) {
  if (player.current?.albumId === albumId && player.status !== 'idle') return player.toggle()
  try {
    const album = await api.album(albumId)
    player.playQueue(albumQueue(album), 0, album.title)
  } catch (e) {
    toast.show(`No se pudo abrir el disco: ${e}`)
  }
}

/** Crea una playlist vacía y la abre (con el nombre listo para cambiarlo). */
export async function newPlaylist() {
  const created = await library.createPlaylist()
  if (!created) return
  justCreated.add(created.id)
  nav.go({ name: 'playlist', id: created.id })
}
