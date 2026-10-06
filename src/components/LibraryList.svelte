<script lang="ts">
  // Lo que hay en "Tu biblioteca": favoritas, historial, tu música, descargas, playlists y discos.
  // Va en la barra lateral (escritorio) y en su propia página (móvil).
  import { downloads } from '../lib/downloads.svelte'
  import { layout } from '../lib/layout.svelte'
  import { songs } from '../lib/format'
  import { library } from '../lib/library.svelte'
  import { local } from '../lib/local.svelte'
  import { nav } from '../lib/nav.svelte'
  import Collage from './Collage.svelte'
  import Cover from './Cover.svelte'
  import Icon from './Icon.svelte'

  const route = $derived(nav.route)
</script>

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

  <button class="item" class:active={route.name === 'local'} onclick={() => nav.go({ name: 'local' })}>
    <span class="art plain mine" class:busy={!!local.scan}><Icon name="folder" size={20} /></span>
    <span class="text">
      <span class="title">Tu música</span>
      <span class="sub">
        {#if local.scan}Leyendo tus carpetas…{:else if local.data?.tracks}{songs(local.data.tracks)} en tus carpetas{:else}Importa tus mp3{/if}
      </span>
    </span>
  </button>

  {#if layout.canDownload}
  <button class="item" class:active={route.name === 'downloads'} onclick={() => nav.go({ name: 'downloads' })}>
    <span class="art plain" class:busy={downloads.active.size > 0}><Icon name="download" size={20} /></span>
    <span class="text">
      <span class="title">Descargas</span>
      <span class="sub">
        {#if downloads.active.size}Descargando {downloads.active.size}…{:else}{songs(downloads.done.size)} sin conexión{/if}
      </span>
    </span>
  </button>
  {/if}

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

<style>
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
  .plain.mine {
    background: linear-gradient(135deg, #7a4a1f, #d9a066);
    color: #fff;
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
