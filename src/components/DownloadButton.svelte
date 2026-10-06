<script lang="ts">
  // Descargar un disco o una lista entera: descarga / progreso / descargado.
  import { downloads } from '../lib/downloads.svelte'
  import { layout } from '../lib/layout.svelte'
  import { isLocal } from '../lib/media'
  import { menu } from '../lib/menu.svelte'
  import type { QueueItem } from '../lib/player.svelte'
  import Icon from './Icon.svelte'

  let { items: all }: { items: QueueItem[] } = $props()
  // La música local ya está en el equipo.
  const items = $derived(all.filter((i) => !isLocal(i.track.id)))

  const done = $derived(items.filter((i) => downloads.done.has(i.track.id)).length)
  const busy = $derived(items.some((i) => downloads.active.has(i.track.id)))
  const complete = $derived(items.length > 0 && done === items.length)
  // Progreso global: canciones terminadas + lo que llevan las que están bajando.
  const progress = $derived(
    items.length
      ? (done + items.reduce((sum, i) => sum + (downloads.active.get(i.track.id) ?? 0), 0)) / items.length
      : 0,
  )

  const R = 13
  const C = 2 * Math.PI * R

  function onclick(e: MouseEvent) {
    if (busy) return
    if (complete) {
      const ids = items.map((i) => i.track.id)
      menu.show(e, [{ label: 'Quitar descargas', icon: 'trash', action: () => downloads.remove(ids) }])
    } else {
      downloads.start(items)
    }
  }

  const title = $derived(
    busy
      ? `Descargando: ${done} de ${items.length}`
      : complete
        ? 'Descargado · clic para quitar'
        : done
          ? `Descargar lo que falta (${items.length - done} de ${items.length})`
          : 'Descargar',
  )
</script>

{#if items.length && layout.canDownload}
  <button class="action" class:on={complete} {onclick} {title}>
    {#if busy}
      <svg class="ring" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r={R} class="track" />
        <circle cx="16" cy="16" r={R} class="fill" stroke-dasharray={C} stroke-dashoffset={C * (1 - progress)} />
      </svg>
    {:else}
      <Icon name={complete ? 'downloaded' : 'download'} size={30} />
    {/if}
  </button>
{/if}

<style>
  .ring {
    transform: rotate(-90deg);
  }
  circle {
    fill: none;
    stroke-width: 3;
  }
  .track {
    stroke: var(--elevated);
  }
  .fill {
    stroke: var(--accent);
    stroke-linecap: round;
    transition: stroke-dashoffset 0.3s;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
