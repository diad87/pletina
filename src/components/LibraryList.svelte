<script lang="ts">
  // Lo que hay en "Tu biblioteca": favoritas, historial, tu música, descargas, playlists, discos y artistas.
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
  <button class="item" class:active={route.name === 'youtube-tracks'} onclick={() => nav.go({ name: 'youtube-tracks' })}>
    <span class="art plain"><Icon name="note" size={20} /></span>
    <span class="text">
      <span class="title">Canciones de YouTube</span>
      <span class="sub">Añade tus enlaces</span>
    </span>
  </button>

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

  {#if layout.canImportLocal}
  <button class="item" class:active={route.name === 'local'} onclick={() => nav.go({ name: 'local' })}>
    <span class="art plain mine" class:busy={!!local.scan}><Icon name="folder" size={20} /></span>
    <span class="text">
      <span class="title">Tu música</span>
      <span class="sub">
        {#if local.scan}Leyendo tus carpetas…{:else if local.data?.tracks}{songs(local.data.tracks)} en tus carpetas{:else}Importa tus mp3{/if}
      </span>
    </span>
  </button>
  {/if}

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

  <section class="artists" aria-label="Artistas favoritos">
    <h2>Artistas favoritos</h2>
    {#each library.artists as artist (artist.id)}
      <div class="artist-row">
        <button
          class="item"
          class:active={route.name === 'artist' && route.id === artist.id}
          onclick={() => nav.go({ name: 'artist', id: artist.id })}
        >
          <span class="art artist"><Cover src={artist.picture} round /></span>
          <span class="text">
            <span class="title">{artist.name}</span>
            <span class="sub">Artista favorito</span>
          </span>
        </button>
        <button
          class="remove-artist"
          disabled={library.savingArtists.has(artist.id)}
          aria-busy={library.savingArtists.has(artist.id)}
          aria-label={`Quitar a ${artist.name} de artistas favoritos`}
          title={`Quitar a ${artist.name} de favoritos`}
          onclick={() => library.toggleArtist(artist)}
        >
          <Icon name="heartFilled" size={18} />
        </button>
      </div>
    {:else}
      <p class="empty-artists">Aún no tienes artistas favoritos. Abre un artista y pulsa «Añadir a favoritos».</p>
    {/each}
  </section>
</div>

<style>
  .artists { margin-top: 20px; }
  .artists h2 { margin: 0 8px 8px; color: var(--muted); font-size: 13px; font-weight: 700; }
  .artist-row { display: flex; align-items: center; gap: 2px; }
  .artist-row .item { min-width: 0; flex: 1; }
  .art.artist :global(.cover) { border-radius: 50%; }
  .remove-artist {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--accent);
  }
  .remove-artist:hover { background: var(--hover); }
  .remove-artist:disabled { opacity: 0.6; }
  .empty-artists { margin: 0 8px 12px; color: var(--faint); font-size: 12px; line-height: 1.6; }

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
