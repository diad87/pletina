<script lang="ts">
  import { newPlaylist } from '../lib/actions'
  import { extractor, type Engine, type EngineStats } from '../lib/extractor/engine.svelte'
  import { menu } from '../lib/menu.svelte'
  import { nav } from '../lib/nav.svelte'
  import { toast } from '../lib/toast.svelte'
  import { updates } from '../lib/updates.svelte'
  import Icon from './Icon.svelte'
  import LibraryList from './LibraryList.svelte'

  const route = $derived(nav.route)

  function openSearch() {
    if (nav.route.name !== 'search') nav.go({ name: 'search', query: '' })
    nav.focusSearch()
  }

  // De dónde sale el audio de YouTube: se elige en el menú del número de versión, para que la
  // interfaz quede limpia (ver src/lib/extractor/engine.svelte.ts).
  const ENGINES: { value: Engine; label: string }[] = [
    { value: 'ytdlp', label: 'yt-dlp' },
    { value: 'youtubei', label: 'youtubei.js (prueba)' },
    { value: 'propio', label: 'Motor propio' },
  ]
  const EXTRACTORS = { recipe: 'receta', capture: 'ventana oculta', youtubei: 'youtubei.js' }
  let stats = $state<EngineStats | null>(null)

  function engineMenu(e: MouseEvent) {
    const versions = (stats?.extractors ?? []).map((x) => ({
      label: `${EXTRACTORS[x.name]} v${x.version}${x.downloaded ? ' (actualizado)' : ''}`,
    }))
    menu.show(e, [
      ...ENGINES.map((o) => ({
        label: `Audio de YouTube: ${o.label}`,
        icon: extractor.engine === o.value ? ('check' as const) : undefined,
        action: () => extractor.set(o.value).catch((err) => toast.show(`No se pudo cambiar: ${err}`)),
      })),
      ...(versions.length ? [{ label: 'Versiones de los extractores', separated: true, children: versions }] : []),
    ])
  }

</script>

<aside class="sidebar">
  <div class="top">
    <div class="brand">
      <span class="logo"><Icon name="note" size={18} /></span> Musify
      {#if updates.current}
        <button
          class="version"
          title="Versión instalada · de dónde sale el audio"
          onpointerenter={() => extractor.stats().then((s) => (stats = s)).catch(() => {})}
          onclick={engineMenu}>{updates.current}</button
        >
      {/if}
    </div>
    <nav>
      <button class:active={route.name === 'home'} onclick={() => nav.go({ name: 'home' })}>
        <Icon name="home" size={24} /> Inicio
      </button>
      <button class:active={route.name === 'search'} onclick={openSearch}>
        <Icon name="search" size={24} /> Buscar
      </button>
    </nav>
  </div>

  <section class="library">
    <header>
      <span class="heading"><Icon name="library" size={24} /> Tu biblioteca</span>
      <button class="add" onclick={newPlaylist} title="Crear playlist"><Icon name="plus" size={20} /></button>
    </header>

    <LibraryList />
  </section>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .top,
  .library {
    border-radius: var(--radius);
    background: linear-gradient(180deg, #17171d 0%, var(--panel) 140px);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04);
  }
  .top {
    padding: 20px 12px 8px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px 14px;
    font-size: 21px;
    font-weight: 900;
    letter-spacing: -0.03em;
  }
  .version {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
    color: var(--faint);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0;
    transition:
      background 0.15s,
      color 0.15s;
  }
  .version:hover {
    background: rgb(255 255 255 / 0.12);
    color: var(--muted);
  }
  .logo {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 9px;
    background: var(--accent-grad);
    color: #10002b;
    box-shadow:
      0 6px 16px color-mix(in srgb, var(--accent-strong) 40%, transparent),
      inset 0 1px 0 rgb(255 255 255 / 0.4);
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  nav button {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 44px;
    padding: 0 12px;
    border-radius: 6px;
    font-weight: 700;
    color: var(--muted);
    transition: color 0.15s;
  }
  nav button:hover {
    color: var(--text);
  }
  nav button.active {
    color: var(--text);
    background: rgb(255 255 255 / 0.06);
  }

  .library {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 12px 8px 8px;
  }
  .library header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px 12px 12px;
  }
  .heading {
    display: flex;
    align-items: center;
    gap: 12px;
    font-weight: 700;
    color: var(--muted);
  }
  .add {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--muted);
  }
  .add:hover {
    background: var(--elevated);
    color: var(--text);
  }
</style>
