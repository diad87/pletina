<script lang="ts">
  import Card from '../components/Card.svelte'
  import Icon from '../components/Icon.svelte'
  import Shelf from '../components/Shelf.svelte'
  import { albumCardMenu, albumPlaying, playAlbum } from '../lib/actions'
  import { menu } from '../lib/menu.svelte'
  import { songs, year } from '../lib/format'
  import { local } from '../lib/local.svelte'
  import { nav } from '../lib/nav.svelte'
  import { theme } from '../lib/theme.svelte'

  theme.clear()
  theme.setColor('hsl(28 45% 26%)', 'Tu música')
  nav.ready()

  const data = $derived(local.data)
  let filter = $state('')
  const albums = $derived(
    (data?.albums ?? []).filter((a) => {
      const q = filter.trim().toLowerCase()
      return !q || a.title.toLowerCase().includes(q) || (a.artist?.name ?? '').toLowerCase().includes(q)
    }),
  )
  const progress = $derived(local.scan && local.scan.total ? Math.round((local.scan.done / local.scan.total) * 100) : null)
</script>

<section class="page top">
  <div class="head">
    <div>
      <h1 class="page-title">Tu música</h1>
      {#if data?.tracks}
        <p class="sub">{songs(data.tracks)} · {data.albums.length} discos · {data.artists.length} artistas</p>
      {/if}
    </div>
    {#if local.scan}
      <div class="scanning">
        <span class="spinner"></span>
        {#if local.scan.state === 'covers'}
          Buscando carátulas que faltan…
        {:else if progress !== null}
          Leyendo tu música… {progress} %
        {:else}
          Leyendo tu música…
        {/if}
      </div>
    {/if}
  </div>

  <div class="folders">
    {#each data?.folders ?? [] as folder (folder)}
      <span class="folder" title={folder}>
        <Icon name="folder" size={16} />
        <span class="path">{folder}</span>
        <button class="remove" onclick={() => local.removeFolder(folder)} title="Dejar de usar esta carpeta"
          ><Icon name="close" size={14} /></button
        >
      </span>
    {/each}
    <button class="add" onclick={() => local.addFolder()}><Icon name="plus" size={16} /> Añadir carpeta</button>
    {#if data?.folders.length}
      <button class="ghost" onclick={() => local.rescan()} disabled={!!local.scan}>Volver a buscar</button>
    {/if}
  </div>

  {#if !data}
    <!-- cargando -->
  {:else if !data.folders.length}
    <div class="empty-state">
      <Icon name="folder" size={40} />
      <strong>Trae aquí tu propia música</strong>
      <p>
        Elige una o varias carpetas con tus mp3, m4a, flac u ogg. Todo lo que haya dentro entra en tu biblioteca, con
        sus carátulas, y suena directamente desde el archivo.
      </p>
      <button class="pill" onclick={() => local.addFolder()}>Añadir carpeta</button>
    </div>
  {:else if !data.albums.length && !local.scan}
    <div class="empty-state">
      <Icon name="note" size={40} />
      <strong>No se ha encontrado música</strong>
      <p>En estas carpetas no hay archivos de audio que la app pueda reproducir (mp3, m4a, flac, ogg, opus, wav).</p>
    </div>
  {:else}
    {#if data.artists.length}
      <Shelf title="Artistas">
        {#each data.artists as artist (artist.id)}
          <Card
            image={artist.pictureMedium}
            title={artist.name}
            subtitle={artist.nbAlbum === 1 ? '1 disco' : `${artist.nbAlbum} discos`}
            round
            onclick={() => nav.go({ name: 'artist', id: artist.id })}
          />
        {/each}
      </Shelf>
    {/if}

    <div class="albums-head">
      <h2 class="section-title">Discos</h2>
      <label class="filter">
        <Icon name="search" size={16} />
        <input bind:value={filter} placeholder="Filtrar discos" spellcheck="false" />
      </label>
    </div>
    <div class="grid">
      {#each albums as album (album.id)}
        <Card
          image={album.coverMedium}
          title={album.title}
          subtitle={[album.artist?.name, year(album.releaseDate)].filter(Boolean).join(' · ')}
          playing={albumPlaying(album.id)}
          onclick={() => nav.go({ name: 'album', id: album.id })}
          onplay={() => playAlbum(album.id)}
          oncontext={(e) => menu.show(e, albumCardMenu(album.id))}
        />
      {/each}
    </div>
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }
  .head .page-title {
    margin-bottom: 4px;
  }
  .sub {
    margin: 0 12px 16px;
    color: rgb(255 255 255 / 0.75);
    font-weight: 500;
  }
  .scanning {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 12px 18px;
    padding: 8px 14px;
    border-radius: 18px;
    background: rgb(0 0 0 / 0.35);
    font-size: 13px;
    font-weight: 600;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgb(255 255 255 / 0.25);
    border-top-color: var(--text);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .folders {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0 12px 8px;
  }
  .folder {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 420px;
    height: 34px;
    padding: 0 6px 0 12px;
    border-radius: 17px;
    background: rgb(255 255 255 / 0.08);
    color: var(--muted);
  }
  .path {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text);
    font-size: 13px;
    direction: rtl;
    text-align: left;
  }
  .remove {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: var(--muted);
  }
  .remove:hover {
    background: rgb(255 255 255 / 0.12);
    color: var(--text);
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 14px;
    border-radius: 17px;
    background: var(--text);
    color: #000;
    font-weight: 700;
    font-size: 13px;
  }
  .ghost {
    height: 34px;
    padding: 0 10px;
    color: var(--muted);
    font-weight: 700;
    font-size: 13px;
  }
  .ghost:hover:not(:disabled) {
    color: var(--text);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .albums-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    padding-right: 12px;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    margin-bottom: 8px;
    padding: 0 12px;
    border-radius: 17px;
    background: rgb(255 255 255 / 0.08);
    color: var(--muted);
  }
  .filter input {
    width: 160px;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }
</style>
