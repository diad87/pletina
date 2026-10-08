<script lang="ts">
  import Card from '../components/Card.svelte'
  import Icon from '../components/Icon.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Status from '../components/Status.svelte'
  import * as api from '../lib/api'
  import { nav } from '../lib/nav.svelte'
  import { PODCAST_LANGUAGES, podcastLanguage } from '../lib/podcasts'
  import { load, save } from '../lib/queue'
  import { theme } from '../lib/theme.svelte'
  import type { PodcastSearchResults } from '../lib/types'

  let { query }: { query: string } = $props()

  let language = $state(load('musify:podcastLanguage', 'es', (value) =>
    typeof value === 'string' && PODCAST_LANGUAGES.some((option) => option.code === value),
  ))
  let results = $state<PodcastSearchResults | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let attempt = $state(0)

  theme.clear()
  theme.neutral()

  $effect(() => save('musify:podcastLanguage', language))

  $effect(() => {
    const q = query.trim()
    const selectedLanguage = language
    void attempt
    results = null
    error = null
    loading = true

    let alive = true
    const timer = setTimeout(() => {
      api.podcastSearch(q, selectedLanguage)
        .then((response) => {
          if (!alive) return
          results = response
          loading = false
          nav.ready()
        })
        .catch((cause) => {
          if (!alive) return
          error = String(cause) || 'No se pudieron buscar los pódcasts. Vuelve a intentarlo.'
          loading = false
        })
    }, 500)

    return () => {
      alive = false
      clearTimeout(timer)
    }
  })

  const resultStatus = $derived(
    loading ? 'Buscando pódcasts…' : error ? error : results
      ? `${results.podcasts.length + results.youtube.length} ${results.podcasts.length + results.youtube.length === 1 ? 'pódcast encontrado' : 'pódcasts encontrados'}`
      : '',
  )
</script>

<section class="page top">
  <div class="heading">
    <div>
      <h1 class="page-title">Pódcasts</h1>
      <p class="hint">Encuentra tu próxima conversación. Busca un nombre o un tema en la barra de arriba.</p>
    </div>
    <label class="language-filter">
      <span>Idioma</span>
      <select bind:value={language} aria-label="Idioma de los pódcasts">
        {#each PODCAST_LANGUAGES as option (option.code)}
          <option value={option.code}>{option.label}</option>
        {/each}
      </select>
    </label>
  </div>

  <p class="result-status" role="status" aria-live="polite" aria-atomic="true">{resultStatus}</p>

  {#if error}
    <Status {error} retry={() => attempt++} />
  {:else if loading || !results}
    <div aria-busy="true" aria-label="Resultados de pódcasts"><Skeleton kind="grid" /></div>
  {:else}
    {#if results.failedFeeds > 0}
      <p class="partial" role="note">Algunos pódcasts no están disponibles ahora. Puedes volver a buscar para intentarlo de nuevo.</p>
    {/if}
    {#if results.podcasts.length}
      <div class="grid" aria-label="Resultados de pódcasts">
        {#each results.podcasts as podcast (podcast.id)}
          <Card
            image={podcast.image}
            title={podcast.title}
            subtitle={[podcast.author, podcastLanguage(podcast.language)].filter(Boolean).join(' · ')}
            onclick={() => nav.go({ name: 'podcast', id: podcast.id, feedUrl: podcast.feedUrl })}
          />
        {/each}
      </div>
    {/if}
    {#if results.youtube.length}
      <!-- YouTube Music no dice el idioma: van aparte y sin filtrar. Cada temporada suele ser un programa. -->
      <h2 class="section-title youtube">En YouTube</h2>
      <div class="grid" aria-label="Pódcasts de YouTube">
        {#each results.youtube as podcast (podcast.id)}
          <Card
            image={podcast.image}
            title={podcast.title}
            subtitle={podcast.author}
            onclick={() => nav.go({ name: 'podcast', id: podcast.id, feedUrl: podcast.feedUrl })}
          />
        {/each}
      </div>
    {/if}
    {#if !results.podcasts.length && !results.youtube.length}
      <div class="empty-state">
        <Icon name="search" size={40} />
        <strong>{query.trim() ? `No hay resultados para «${query.trim()}»` : 'No hay coincidencias en este idioma'}</strong>
        <p>{language === 'all' ? 'Prueba buscando un nombre o un tema.' : 'Prueba buscando un nombre o un tema, o busca en todos los idiomas.'}</p>
        {#if language !== 'all'}
          <button class="pill" onclick={() => language = 'all'}>Ver todos los idiomas</button>
        {/if}
        {#if results.failedFeeds > 0}
          <button class="retry" onclick={() => attempt++}>Volver a intentar</button>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 24px;
  }
  .page-title { margin-bottom: 4px; }
  .hint {
    margin: 0 12px;
    color: var(--muted);
  }
  .language-filter {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 12px;
    color: var(--muted);
    font-weight: 600;
  }
  select {
    min-height: 44px;
    max-width: 100%;
    padding: 8px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .result-status, .partial {
    margin: 0 12px 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .result-status:empty { margin: 0; }
  .partial {
    padding: 12px 16px;
    border-radius: var(--radius);
    background: var(--panel-2);
  }
  .retry {
    min-height: 44px;
    padding: 8px 16px;
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  @media (max-width: 720px) {
    .heading { gap: 18px; }
    .hint, .language-filter, .result-status, .partial { margin-left: 4px; margin-right: 4px; }
  }

  .section-title.youtube {
    margin-top: 32px;
  }
</style>
