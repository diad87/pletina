<script lang="ts">
  // Móvil: barra de abajo con las secciones. Recuerda en cuál estabas al abrir un disco o un
  // artista, y tocar la sección en la que ya estás vuelve a su principio.
  import { nav, type Route } from '../lib/nav.svelte'
  import Icon, { type IconName } from './Icon.svelte'

  type Tab = 'home' | 'search' | 'podcasts' | 'library'
  const TABS: { tab: Tab; label: string; icon: IconName; route: Route }[] = [
    { tab: 'home', label: 'Inicio', icon: 'home', route: { name: 'home' } },
    { tab: 'search', label: 'Buscar', icon: 'search', route: { name: 'search', query: '' } },
    { tab: 'podcasts', label: 'Podcasts', icon: 'podcast', route: { name: 'podcasts', query: '' } },
    { tab: 'library', label: 'Tu biblioteca', icon: 'library', route: { name: 'library' } },
  ]
  const LIBRARY = ['library', 'liked', 'history', 'local', 'downloads', 'playlist', 'import-playlist', 'youtube-tracks']

  let active = $state<Tab>('home')
  $effect(() => {
    const name = nav.route.name
    if (name === 'home' || name === 'search') active = name
    else if (name === 'podcasts' || name === 'podcast') active = 'podcasts'
    else if (LIBRARY.includes(name)) active = 'library'
  })

  function open(t: (typeof TABS)[number]) {
    if (t.tab === 'search' && nav.route.name === 'search') return nav.focusSearch()
    if (nav.route.name === t.route.name) return nav.scroller?.scrollTo({ top: 0, behavior: 'smooth' })
    nav.go(t.route)
    if (t.tab === 'search') requestAnimationFrame(() => nav.focusSearch())
  }
</script>

<nav class="bottom-nav">
  {#each TABS as t (t.tab)}
    <button class:active={active === t.tab} onclick={() => open(t)}>
      <Icon name={t.icon} size={24} />
      <span>{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .bottom-nav {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    padding: 6px 8px calc(6px + var(--safe-bottom));
  }
  button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 4px 0;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    transition: color 0.15s;
  }
  button.active {
    color: var(--text);
  }
</style>
