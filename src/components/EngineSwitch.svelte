<script lang="ts">
  // Prototipo P1: elegir con qué se saca el audio de YouTube.
  import { extractor, type Engine, type EngineStats } from '../lib/extractor/engine.svelte'
  import { toast } from '../lib/toast.svelte'
  import { invoke } from '@tauri-apps/api/core'

  const ALL: { value: Engine; label: string }[] = [
    { value: 'ytdlp', label: 'yt-dlp' },
    { value: 'youtubei', label: 'youtubei.js (prueba)' },
    { value: 'propio', label: 'Propio' },
  ]
  // Los que hay en este sistema (en el móvil no hay yt-dlp).
  let available = $state<string[]>(['ytdlp', 'youtubei', 'propio'])
  invoke<string[]>('stream_engines').then((list) => (available = list)).catch(() => {})
  const options = $derived(ALL.filter((o) => available.includes(o.value)))

  let stats = $state<EngineStats | null>(null)
  $effect(() => {
    const load = () => extractor.stats().then((s) => (stats = s)).catch(() => {})
    load()
    // Con el motor propio, los números van cambiando; con los demás basta de vez en cuando.
    const timer = setInterval(load, extractor.engine === 'propio' ? 3000 : 30000)
    return () => clearInterval(timer)
  })

  const LABELS = { recipe: 'receta', capture: 'ventana oculta', youtubei: 'youtubei.js' }

  function choose(value: Engine) {
    extractor.set(value).catch((e) => toast.show(`No se pudo cambiar: ${e}`))
  }
</script>

<div class="engine">
  {#if options.length > 1}
    <span>Audio de YouTube con</span>
    {#each options as o (o.value)}
      <button class="chip" class:on={extractor.engine === o.value} onclick={() => choose(o.value)}>{o.label}</button>
    {/each}
  {:else}
    <span>Audio de YouTube con el motor propio</span>
  {/if}
  {#if extractor.engine === 'youtubei' && (extractor.served || extractor.failed)}
    <span class="count">{extractor.served} con youtubei.js · {extractor.failed} con yt-dlp de respaldo</span>
  {/if}
  {#if extractor.engine === 'propio' && stats && (stats.fast || stats.official)}
    <span class="count">
      {stats.fast} al momento · {stats.official} con el reproductor de YouTube · {stats.replaced} URLs cambiadas antes de fallar
    </span>
  {/if}
  {#if stats?.extractors}
    <span class="count versions" title="Los extractores se actualizan solos, sin reinstalar la app">
      Extractores: {stats.extractors.map((e) => `${LABELS[e.name]} v${e.version}${e.downloaded ? ' (actualizado)' : ''}`).join(' · ')}
    </span>
  {/if}
</div>

<style>
  .engine {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 48px 12px 0;
    font-size: 13px;
    color: var(--muted);
  }
  .chip {
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--elevated);
    color: var(--text);
  }
  .chip.on {
    background: var(--text);
    color: var(--bg);
  }
  .count {
    color: var(--faint);
  }
  .versions {
    flex-basis: 100%;
  }
</style>
