<script lang="ts">
  // Prototipo P1: elegir con qué se saca el audio de YouTube.
  import { extractor, type Engine, type EngineStats } from '../lib/extractor/engine.svelte'
  import { toast } from '../lib/toast.svelte'

  const options: { value: Engine; label: string }[] = [
    { value: 'ytdlp', label: 'yt-dlp' },
    { value: 'youtubei', label: 'youtubei.js (prueba)' },
    { value: 'propio', label: 'Propio' },
  ]

  let stats = $state<EngineStats | null>(null)
  $effect(() => {
    if (extractor.engine !== 'propio') return
    const load = () => extractor.stats().then((s) => (stats = s)).catch(() => {})
    load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  })

  function choose(value: Engine) {
    extractor.set(value).catch((e) => toast.show(`No se pudo cambiar: ${e}`))
  }
</script>

<div class="engine">
  <span>Audio de YouTube con</span>
  {#each options as o (o.value)}
    <button class="chip" class:on={extractor.engine === o.value} onclick={() => choose(o.value)}>{o.label}</button>
  {/each}
  {#if extractor.engine === 'youtubei' && (extractor.served || extractor.failed)}
    <span class="count">{extractor.served} con youtubei.js · {extractor.failed} con yt-dlp de respaldo</span>
  {/if}
  {#if extractor.engine === 'propio' && stats && (stats.fast || stats.official)}
    <span class="count">
      {stats.fast} al momento · {stats.official} con el reproductor de YouTube · {stats.replaced} URLs cambiadas antes de fallar ·
      receta v{stats.recipe}
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
</style>
