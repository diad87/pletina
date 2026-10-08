<script lang="ts">
  import Cover from '../components/Cover.svelte'
  import Icon from '../components/Icon.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Status from '../components/Status.svelte'
  import * as api from '../lib/api'
  import { trackMenu } from '../lib/actions'
  import { menu } from '../lib/menu.svelte'
  import { longDuration } from '../lib/format'
  import { nav } from '../lib/nav.svelte'
  import { player } from '../lib/player.svelte'
  import { episodeQueue, podcastLanguage } from '../lib/podcasts'
  import { theme } from '../lib/theme.svelte'
  import type { PodcastDetail } from '../lib/types'

  let { id, feedUrl }: { id: number; feedUrl?: string } = $props()
  let data = $state<PodcastDetail | null>(null)
  let error = $state<string | null>(null)
  let attempt = $state(0)

  theme.clear()

  $effect(() => {
    const currentId = id
    const currentFeed = feedUrl
    void attempt
    data = null
    error = null
    theme.clear()
    let alive = true

    async function fetchPodcast() {
      try {
        const feed = currentFeed || await api.podcastFeedUrl(currentId)
        if (!alive) return
        const response = await api.podcastDetail(feed)
        if (!alive) return
        data = response
        theme.set(response.podcast.image, response.podcast.title)
        nav.ready()
      } catch (cause) {
        if (alive) error = String(cause) || 'No se pudo cargar este pódcast. Vuelve a intentarlo.'
      }
    }
    void fetchPodcast()
    return () => { alive = false }
  })

  const queue = $derived(data ? episodeQueue(data) : [])
  const isThisPodcast = $derived(queue.length > 0 && player.current?.albumId === queue[0].albumId)
  const playing = $derived(isThisPodcast && player.status !== 'paused' && player.status !== 'idle')

  function playPodcast() {
    if (!queue.length) return
    if (isThisPodcast) player.toggle()
    else player.playQueue(queue, 0, data?.podcast.title)
  }

  function playEpisode(index: number) {
    if (player.current?.track.id === queue[index]?.track.id) player.toggle()
    else player.playQueue(queue, index, data?.podcast.title)
  }

  $effect(() => {
    theme.play = data && queue.length ? { playing, toggle: playPodcast } : null
  })

  function publishedDate(value: string | null): string {
    if (!value) return ''
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return ''
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(date)
  }
</script>

{#if error}
  <Status {error} retry={() => attempt++} />
{:else if !data}
  <div aria-busy="true" aria-label="Cargando pódcast"><Skeleton /></div>
{:else}
  <header class="hero">
    <div class="art"><Cover src={data.podcast.image} /></div>
    <div class="info">
      <div class="kind">Pódcast</div>
      <h1>{data.podcast.title}</h1>
      <div class="meta">
        {#if data.podcast.author}<span class="strong">{data.podcast.author}</span>{/if}
        <span class:dot={!!data.podcast.author}>{podcastLanguage(data.podcast.language)}</span>
        <span class="dot">{data.episodes.length} {data.episodes.length === 1 ? 'episodio' : 'episodios'}</span>
      </div>
    </div>
  </header>

  <section class="page">
    {#if data.episodes.length}
      <div class="actions">
        <button class="big-play" onclick={playPodcast} title={playing ? 'Pausar pódcast' : 'Reproducir pódcast'} aria-label={playing ? 'Pausar pódcast' : 'Reproducir pódcast'}>
          <Icon name={playing ? 'pause' : 'play'} size={26} />
        </button>
        <span class="play-hint">{isThisPodcast ? 'Continúa escuchando' : 'Reproducir episodios'}</span>
      </div>
    {/if}

    {#if data.podcast.description}
      <details class="about">
        <summary>Acerca de este pódcast</summary>
        <p>{data.podcast.description}</p>
      </details>
    {/if}

    <h2 class="section-title">Episodios</h2>
    {#if !data.episodes.length}
      <div class="empty-state">
        <Icon name="podcast" size={40} />
        <strong>Todavía no hay episodios disponibles</strong>
        <p>Vuelve a intentarlo más adelante.</p>
        <button class="pill" onclick={() => attempt++}>Actualizar</button>
      </div>
    {:else}
      <ol class="episodes" aria-label="Episodios del pódcast">
        {#each data.episodes as episode, index (episode.id)}
          {@const current = player.current?.track.id === queue[index]?.track.id}
          {@const active = current && player.status !== 'paused' && player.status !== 'idle'}
          {@const date = publishedDate(episode.publishedAt)}
          <li class="episode" class:current>
            <div class="episode-art"><Cover src={episode.image ?? data.podcast.image} /></div>
            <div class="episode-info">
              <h3>{episode.title}</h3>
              <div class="episode-meta">
                {#if date}<span>{date}</span>{/if}
                {#if episode.duration > 0}<span>{longDuration(episode.duration)}</span>{/if}
                {#if episode.explicit}<span class="explicit" aria-label="Contenido explícito" title="Contenido explícito">E</span>{/if}
                {#if current}<span class="current-label">{player.status === 'loading' ? 'Cargando…' : active ? 'Sonando' : 'En pausa'}</span>{/if}
              </div>
              {#if episode.description}
                <details class="description">
                  <summary>Descripción del episodio</summary>
                  <p>{episode.description}</p>
                </details>
              {/if}
            </div>
            <div class="episode-actions">
              <button class="episode-play" class:active onclick={() => playEpisode(index)} aria-label={`${active ? 'Pausar' : 'Reproducir'} ${episode.title}`} title={active ? 'Pausar' : 'Reproducir'}>
                <Icon name={active ? 'pause' : 'play'} size={22} />
              </button>
              <button class="add-queue" onclick={() => player.addToQueue([queue[index]])} aria-label={`Añadir ${episode.title} a la cola`} title="Añadir a la cola">
                <Icon name="plus" size={24} />
              </button>
              <button class="add-queue" onclick={(event) => menu.show(event, trackMenu(queue[index]))} aria-label={`Más opciones de ${episode.title}`} title="Más opciones">
                <Icon name="more" size={24} />
              </button>
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}

<style>
  .play-hint { color: var(--muted); }
  .about {
    margin: 12px 12px 24px;
    max-width: 860px;
    color: var(--muted);
  }
  summary { cursor: pointer; }
  .about summary { color: var(--text); font-weight: 700; }
  .about p, .description p {
    margin: 12px 0 0;
    line-height: 1.65;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .episodes {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .episode {
    display: flex;
    gap: 20px;
    align-items: flex-start;
    padding: 24px 12px;
    border-bottom: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .episode:hover, .episode:focus-within { background: var(--hover); }
  .episode-art { width: 88px; flex: none; }
  .episode-info { min-width: 0; flex: 1; }
  h3 {
    margin: 0 0 8px;
    font-size: 17px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .current h3, .current-label { color: var(--accent); }
  .episode-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
  }
  .explicit {
    padding: 0 4px;
    border-radius: 2px;
    background: var(--muted);
    color: var(--panel);
    font-size: 10px;
    font-weight: 800;
  }
  .description { margin-top: 12px; color: var(--muted); font-size: 13px; }
  .description summary { width: fit-content; min-height: 24px; }
  .episode-actions { display: flex; align-items: center; gap: 8px; flex: none; }
  .episode-play, .add-queue {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
  }
  .episode-play { background: var(--text); color: var(--panel); }
  .episode-play.active { background: var(--accent); }
  .add-queue { color: var(--muted); }
  .add-queue:hover { color: var(--text); background: var(--press); }
  @media (max-width: 720px) {
    .about { margin-left: 4px; margin-right: 4px; }
    .episode { gap: 12px; padding: 20px 4px; flex-wrap: wrap; }
    .episode-art { width: 64px; }
    .episode-info { flex-basis: calc(100% - 76px); }
    .episode-actions { width: 100%; padding-left: 76px; justify-content: flex-end; }
    h3 { font-size: 15px; }
  }
</style>
