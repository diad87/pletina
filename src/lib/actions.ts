// Menús de acciones de canciones y discos (clic derecho o botón "⋯").

import * as api from './api'
import { downloads } from './downloads.svelte'
import { toast } from './toast.svelte'
import type { AlbumDetail } from './types'
import { library } from './library.svelte'
import type { MenuItem } from './menu.svelte'
import { nav } from './nav.svelte'
import { player, type QueueItem } from './player.svelte'

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

export function trackMenu(item: QueueItem, playlist?: { id: number; entryId: number }): MenuItem[] {
  const liked = library.liked.has(item.track.id)
  const items: MenuItem[] = [
    {
      label: liked ? 'Quitar de Canciones que te gustan' : 'Añadir a Canciones que te gustan',
      icon: liked ? 'heartFilled' : 'heart',
      action: () => library.toggleLike(item),
    },
    addToPlaylistMenu(() => [item]),
  ]
  const id = item.track.id
  if (downloads.done.has(id)) {
    items.push(
      { label: 'Quitar descarga', icon: 'trash', action: () => downloads.remove([id]) },
      { label: 'Mostrar en la carpeta', icon: 'folder', action: () => api.revealDownload(id).catch(() => {}) },
    )
  } else if (!downloads.active.has(id)) {
    items.push({ label: 'Descargar', icon: 'download', action: () => downloads.start([item]) })
  }
  if (playlist) {
    items.push({
      label: 'Quitar de esta playlist',
      icon: 'trash',
      action: () => library.removeFromPlaylist(playlist.id, playlist.entryId),
    })
  }
  items.push(
    {
      label: 'Ir al artista',
      icon: 'user',
      separated: true,
      action: () => nav.go({ name: 'artist', id: item.track.artist.id }),
    },
    { label: 'Ir al disco', icon: 'disc', action: () => nav.go({ name: 'album', id: item.albumId }) },
    { label: '¿No es esta canción?', icon: 'swap', separated: true, action: () => (player.picking = item) },
  )
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
    player.playQueue(albumQueue(await api.album(albumId)), 0)
  } catch (e) {
    toast.show(`No se pudo abrir el disco: ${e}`)
  }
}
