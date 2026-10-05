<script lang="ts">
  // Fila horizontal con desplazamiento y flechas (como las estanterías de Spotify).
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  let { title, children }: { title: string; children: Snippet } = $props()

  let row: HTMLElement | undefined = $state()
  let canLeft = $state(false)
  let canRight = $state(false)

  function update() {
    if (!row) return
    canLeft = row.scrollLeft > 4
    canRight = row.scrollLeft + row.clientWidth < row.scrollWidth - 4
  }

  function scroll(dir: 1 | -1) {
    row?.scrollBy({ left: dir * row.clientWidth * 0.85, behavior: 'smooth' })
  }

  $effect(() => {
    if (!row) return
    update()
    const observer = new ResizeObserver(update)
    observer.observe(row)
    return () => observer.disconnect()
  })
</script>

<section class="shelf">
  <header>
    <h2 class="section-title">{title}</h2>
    <div class="arrows">
      <button class="arrow" onclick={() => scroll(-1)} disabled={!canLeft} title="Anterior"><Icon name="back" size={18} /></button>
      <button class="arrow" onclick={() => scroll(1)} disabled={!canRight} title="Siguiente"><Icon name="forward" size={18} /></button>
    </div>
  </header>
  <div class="row" bind:this={row} onscroll={update}>
    {@render children()}
  </div>
</section>

<style>
  .shelf {
    position: relative;
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding-right: 12px;
  }
  .arrows {
    display: flex;
    gap: 6px;
    padding-bottom: 6px;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .shelf:hover .arrows {
    opacity: 1;
  }
  .arrow {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--elevated);
    color: var(--text);
  }
  .arrow:disabled {
    color: var(--faint);
    background: var(--panel-2);
    cursor: default;
  }
  .row {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: clamp(156px, 15vw, 200px);
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    /* Un poco de margen para que la sombra de las tarjetas no se corte. */
    padding-bottom: 6px;
  }
  .row::-webkit-scrollbar {
    display: none;
  }
  .row > :global(*) {
    scroll-snap-align: start;
  }
</style>
