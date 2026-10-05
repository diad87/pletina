<script lang="ts">
  import Card from '../components/Card.svelte'
  import Cover from '../components/Cover.svelte'
  import Status from '../components/Status.svelte'
  import * as api from '../lib/api'
  import { fans, recordType, year } from '../lib/format'
  import { nav } from '../lib/nav.svelte'
  import { recents } from '../lib/recents.svelte'
  import type { Album, ArtistPage } from '../lib/types'

  let { id }: { id: number } = $props()

  let data = $state<ArtistPage | null>(null)
  let error = $state<string | null>(null)
  let attempt = $state(0)

  $effect(() => {
    const current = id
    void attempt
    data = null
    error = null
    let alive = true
    api
      .artist(current)
      .then((page) => {
        if (!alive) return
        data = page
        nav.ready()
        recents.add({
          kind: 'artist',
          id: page.artist.id,
          title: page.artist.name,
          subtitle: 'Artista',
          image: page.artist.pictureMedium,
        })
      })
      .catch((e) => alive && (error = String(e)))
    return () => {
      alive = false
    }
  })

  const SECTIONS: { title: string; match: (type: string | null) => boolean }[] = [
    { title: 'Álbumes', match: (t) => t !== 'single' && t !== 'ep' && t !== 'compile' },
    { title: 'Sencillos y EP', match: (t) => t === 'single' || t === 'ep' },
    { title: 'Recopilatorios', match: (t) => t === 'compile' },
  ]

  const sections = $derived(
    data
      ? SECTIONS.map((s) => ({ title: s.title, albums: data!.albums.filter((a) => s.match(a.recordType)) })).filter(
          (s) => s.albums.length,
        )
      : [],
  )

  const subtitle = (album: Album) => [year(album.releaseDate), recordType(album.recordType)].filter(Boolean).join(' · ')
</script>

{#if error}
  <Status {error} retry={() => attempt++} />
{:else if !data}
  <Status />
{:else}
  <header class="hero">
    <div class="art"><Cover src={data.artist.pictureXl} round /></div>
    <div>
      <div class="kind">Artista</div>
      <h1>{data.artist.name}</h1>
      <div class="meta">{fans(data.artist.nbFan)} fans · {data.albums.length} lanzamientos</div>
    </div>
  </header>

  <section class="page">
    {#each sections as section (section.title)}
      <h2 class="section-title">{section.title}</h2>
      <div class="grid">
        {#each section.albums as album (album.id)}
          <Card
            image={album.coverMedium}
            title={album.title}
            subtitle={subtitle(album)}
            onclick={() => nav.go({ name: 'album', id: album.id })}
          />
        {/each}
      </div>
    {/each}
  </section>
{/if}
