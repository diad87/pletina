<script lang="ts">
  import { downloads } from '../lib/downloads.svelte'
  import { songs } from '../lib/format'
  import { library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import { justCreated } from '../views/PlaylistView.svelte'
  import Collage from './Collage.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'

  const route = $derived(nav.route)

  function openSearch() {
    if (nav.route.name !== 'search') nav.go({ name: 'search', query: '' })
    nav.focusSearch()
  }

  async function newPlaylist() {
    const created = await library.createPlaylist()
    if (!created) return
    justCreated.add(created.id)
    nav.go({ name: 'playlist', id: created.id })
  }
</script>

<aside class="sidebar">
  <div class="top">
    <div class="brand"><span class="logo"><Icon name="note" size={18} /></span> Musify</div>
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

    <div class="items">
      <button class="item" class:active={route.name === 'liked'} onclick={() => nav.go({ name: 'liked' })}>
        <span class="art liked"><Icon name="heartFilled" size={20} /></span>
        <span class="text">
          <span class="title">Canciones que te gustan</span>
          <span class="sub">Playlist · {songs(library.liked.size)}</span>
        </span>
      </button>

      <button class="item" class:active={route.name === 'history'} onclick={() => nav.go({ name: 'history' })}>
        <span class="art plain"><Icon name="clock" size={20} /></span>
        <span class="text">
          <span class="title">Historial</span>
          <span class="sub">Lo que has escuchado</span>
        </span>
      </button>

      <button class="item" class:active={route.name === 'downloads'} onclick={() => nav.go({ name: 'downloads' })}>
        <span class="art plain" class:busy={downloads.active.size > 0}><Icon name="download" size={20} /></span>
        <span class="text">
          <span class="title">Descargas</span>
          <span class="sub">
            {#if downloads.active.size}Descargando {downloads.active.size}…{:else}{songs(downloads.done.size)} sin conexión{/if}
          </span>
        </span>
      </button>

      {#each library.playlists as p (p.id)}
        <button
          class="item"
          class:active={route.name === 'playlist' && route.id === p.id}
          onclick={() => nav.go({ name: 'playlist', id: p.id })}
        >
          <span class="art"><Collage covers={p.covers} /></span>
          <span class="text">
            <span class="title">{p.name}</span>
            <span class="sub">Playlist · {songs(p.count)}</span>
          </span>
        </button>
      {/each}

      {#each library.albums as a (a.id)}
        <button
          class="item"
          class:active={route.name === 'album' && route.id === a.id}
          onclick={() => nav.go({ name: 'album', id: a.id })}
        >
          <span class="art"><Cover src={a.cover} /></span>
          <span class="text">
            <span class="title">{a.title}</span>
            <span class="sub">Disco · {a.artistName}</span>
          </span>
        </button>
      {/each}
    </div>
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
  .items {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    text-align: left;
  }
  .item:hover {
    background: var(--hover);
  }
  .item {
    transition: background 0.15s;
  }
  .item.active {
    background: rgb(255 255 255 / 0.09);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .art {
    flex: none;
    width: 44px;
  }
  .art :global(.cover),
  .art :global(.collage) {
    border-radius: 6px;
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
  }
  .liked,
  .plain {
    display: grid;
    place-items: center;
    height: 44px;
    border-radius: 6px;
  }
  .liked {
    background: linear-gradient(135deg, #4b2fc9 0%, #8f6cff 55%, #e2d6ff 100%);
    color: #fff;
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
  }
  .plain {
    background: var(--elevated);
    color: var(--muted);
  }
  .plain.busy {
    color: var(--accent);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title,
  .sub {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .title {
    color: var(--text);
  }
  .active .title {
    color: var(--accent);
  }
  .sub {
    font-size: 13px;
    color: var(--muted);
  }
</style>
