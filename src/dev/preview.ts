// Vista previa en el navegador (solo desarrollo): abre una pantalla concreta desde la dirección,
// para sacar capturas. Ejemplos:
//   ?view=album&id=14879699   ?view=artist   ?view=search&q=radiohead   ?view=playlist&id=1
//   &play=1 (empieza a sonar el primer disco)   &np=1 (además abre "Sonando ahora")

import { albumQueue } from '../lib/actions'
import * as api from '../lib/api'
import { nav } from '../lib/nav.svelte'
import { player } from '../lib/player.svelte'
import { theme } from '../lib/theme.svelte'

export async function apply() {
  const p = new URLSearchParams(location.search)
  const view = p.get('view')
  const id = Number(p.get('id'))
  if (view === 'album') nav.go({ name: 'album', id })
  else if (view === 'artist') nav.go({ name: 'artist', id: id || 399 })
  else if (view === 'search') nav.go({ name: 'search', query: p.get('q') ?? 'radiohead' })
  else if (view === 'playlist') nav.go({ name: 'playlist', id: id || 1 })
  else if (view === 'liked') nav.go({ name: 'liked' })

  if (p.has('play') || p.has('np')) {
    const album = await api.album(Number(p.get('playId')) || 0)
    const queue = albumQueue(album)
    const index = Number(p.get('track')) || 0
    player.playQueue(queue, index)
    if (p.has('np')) theme.nowPlaying = true
    // En un navegador sin sonido (capturas) el audio no arranca: se simula una canción a mitad.
    // Se repite unos segundos porque el audio de prueba (30 s de silencio) pisa la duración al cargar.
    const track = queue[index].track
    const fake = setInterval(() => {
      player.status = 'playing'
      player.duration = track.duration
      player.time = Math.round(track.duration * 0.38)
    }, 250)
    setTimeout(() => clearInterval(fake), 8000)
  }
}
