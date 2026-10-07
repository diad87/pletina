<script lang="ts">
  import { layout } from '../lib/layout.svelte'
  import { nav } from '../lib/nav.svelte'
  import { theme } from '../lib/theme.svelte'
  import { updates } from '../lib/updates.svelte'
  import Icon from './Icon.svelte'

  let { scrollY = 0 }: { scrollY?: number } = $props()

  let input: HTMLInputElement | undefined = $state()
  let value = $state('')

  // Se va volviendo opaca al bajar; pasada la cabecera, aparecen el título y el botón de reproducir.
  const solid = $derived(Math.min(1, Math.max(0, (scrollY - 40) / 180)))
  const compact = $derived(scrollY > 300 && !!theme.title)
  // Móvil: las tres secciones de la barra de abajo no llevan "atrás"; el buscador solo en Buscar.
  const root = $derived(['home', 'search', 'library'].includes(nav.route.name))
  const showSearch = $derived(!layout.mobile || nav.route.name === 'search')

  // Al volver atrás a una búsqueda, el cuadro muestra su texto; fuera de búsqueda, vacío.
  $effect(() => {
    const route = nav.route
    value = route.name === 'search' ? route.query : ''
  })

  nav.focusSearch = () => {
    input?.focus()
    input?.select()
  }

  function onInput() {
    const route = { name: 'search' as const, query: value }
    if (nav.route.name === 'search') nav.replace(route)
    else nav.go(route)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if (value) {
      value = ''
      onInput()
    } else {
      input?.blur()
    }
  }
</script>

<header class="topbar" class:mobile={layout.mobile} style:--solid={solid}>
  {#if layout.mobile}
    {#if !root && nav.canBack}
      <button class="round" onclick={() => nav.back()} title="Atrás"><Icon name="back" /></button>
    {/if}
  {:else}
    <div class="arrows">
      <button class="round" onclick={() => nav.back()} disabled={!nav.canBack} title="Atrás (Alt+←)">
        <Icon name="back" />
      </button>
      <button class="round" onclick={() => nav.forward()} disabled={!nav.canForward} title="Adelante (Alt+→)">
        <Icon name="forward" />
      </button>
    </div>
  {/if}

  {#if compact}
    <div class="compact">
      {#if theme.play}
        <button class="mini-play" onclick={() => theme.play?.toggle()} title={theme.play.playing ? 'Pausa' : 'Reproducir'}>
          <Icon name={theme.play.playing ? 'pause' : 'play'} size={18} />
        </button>
      {/if}
      <span class="title">{theme.title}</span>
    </div>
  {/if}

  {#if showSearch}
  <label class="search" class:shrink={compact}>
    <Icon name="search" />
    <input
      bind:this={input}
      bind:value
      oninput={onInput}
      onkeydown={onKeydown}
      placeholder="¿Qué quieres escuchar?"
      spellcheck="false"
      autocomplete="off"
    />
    {#if value}
      <button
        class="clear"
        title="Borrar"
        onclick={() => {
          value = ''
          onInput()
          input?.focus()
        }}><Icon name="close" size={18} /></button
      >
    {/if}
  </label>
  {/if}
  {#if updates.state === 'ready' && !layout.mobile}
    <button class="update" onclick={() => updates.install()} title="Se instalará sola al cerrar Pletina; pulsa para instalarla ya">
      <span class="dot"></span> Versión {updates.version} lista · <strong>Reiniciar</strong>
    </button>
  {/if}
</header>

<style>
  .topbar {
    position: absolute;
    inset: 0 0 auto;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 16px;
    height: 64px;
    padding: 0 24px;
  }
  /* Fondo con el color de la página, que aparece al hacer scroll. */
  .topbar::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: color-mix(in srgb, var(--page-color) 70%, #000);
    opacity: var(--solid);
    box-shadow: 0 6px 20px rgb(0 0 0 / calc(var(--solid) * 0.35));
  }
  .arrows {
    display: flex;
    gap: 8px;
  }
  .round {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.45);
    color: var(--text);
    transition:
      background 0.15s,
      transform 0.15s var(--ease);
  }
  .round:hover:not(:disabled) {
    background: rgb(0 0 0 / 0.7);
    transform: scale(1.06);
  }
  .round:disabled {
    color: var(--faint);
    cursor: default;
  }

  .compact {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    animation: rise 0.25s var(--ease);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .mini-play {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--accent-grad);
    color: #10002b;
    box-shadow: var(--shadow-1);
    transition: transform 0.15s var(--ease);
  }
  .mini-play:hover {
    transform: scale(1.06);
  }
  .compact .title {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(440px, 100%);
    height: 46px;
    margin-left: auto;
    margin-right: auto;
    padding: 0 12px 0 16px;
    border-radius: 23px;
    background: rgb(255 255 255 / 0.1);
    backdrop-filter: blur(12px);
    color: var(--muted);
    border: 1px solid rgb(255 255 255 / 0.08);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04);
    transition:
      border-color 0.15s,
      background 0.15s,
      width 0.25s var(--ease);
  }
  .search.shrink {
    width: min(300px, 40%);
    margin-right: 0;
  }
  .search:hover {
    background: rgb(255 255 255 / 0.14);
  }
  .search:focus-within {
    border-color: rgb(255 255 255 / 0.85);
    background: rgb(255 255 255 / 0.14);
    color: var(--text);
  }
  input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text);
    font: inherit;
    font-size: 15px;
    font-weight: 500;
  }
  input::placeholder {
    color: var(--muted);
  }
  .update {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    height: 34px;
    padding: 0 14px;
    border-radius: 17px;
    background: rgb(0 0 0 / 0.45);
    border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
    font-size: 13px;
    font-weight: 500;
    animation: rise 0.3s var(--ease);
    transition: background 0.15s;
  }
  .update:hover {
    background: rgb(0 0 0 / 0.7);
  }
  .update strong {
    color: var(--accent);
  }
  .update .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
  }
  .clear {
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .clear:hover {
    color: var(--text);
  }

  /* Móvil: más baja, por debajo de la barra de estado. */
  .topbar.mobile {
    height: calc(56px + var(--safe-top));
    padding: var(--safe-top) 12px 0;
    gap: 12px;
  }
  .mobile .search {
    width: 100%;
    height: 42px;
    margin: 0;
  }
  .mobile .compact .title {
    font-size: 17px;
  }
</style>
