<script lang="ts">
  // Esqueleto mientras carga: cabecera, filas de canciones o rejilla de tarjetas.
  let { kind = 'page', round = false }: { kind?: 'page' | 'grid' | 'rows'; round?: boolean } = $props()
</script>

{#if kind === 'page'}
  <div class="hero">
    <div class="art shimmer" class:round></div>
    <div class="info">
      <div class="line shimmer" style:width="80px"></div>
      <div class="line big shimmer" style:width="min(520px, 70%)"></div>
      <div class="line shimmer" style:width="220px"></div>
    </div>
  </div>
  <div class="page">
    {@render rows()}
  </div>
{:else if kind === 'grid'}
  <div class="grid">
    {#each Array(10) as _, i (i)}
      <div class="card">
        <div class="thumb shimmer" class:round></div>
        <div class="line shimmer" style:width="80%"></div>
        <div class="line small shimmer" style:width="55%"></div>
      </div>
    {/each}
  </div>
{:else}
  {@render rows()}
{/if}

{#snippet rows()}
  <div class="rows">
    {#each Array(8) as _, i (i)}
      <div class="row">
        <div class="line small shimmer" style:width="16px"></div>
        <div class="col">
          <div class="line shimmer" style:width="{40 + ((i * 37) % 35)}%"></div>
          <div class="line small shimmer" style:width="{20 + ((i * 23) % 20)}%"></div>
        </div>
        <div class="line small shimmer" style:width="36px"></div>
      </div>
    {/each}
  </div>
{/snippet}

<style>
  .art {
    width: clamp(168px, 18vw, 240px);
    aspect-ratio: 1;
    border-radius: var(--radius-s);
  }
  .round {
    border-radius: 50%;
  }
  .info {
    display: flex;
    flex-direction: column;
    gap: 14px;
    flex: 1;
  }
  .line {
    height: 12px;
    border-radius: 6px;
  }
  .line.big {
    height: 56px;
    border-radius: 10px;
  }
  .line.small {
    height: 10px;
  }
  .rows {
    padding-top: 92px;
  }
  .page .rows {
    padding-top: 24px;
  }
  .row {
    display: grid;
    grid-template-columns: 32px 1fr 48px;
    align-items: center;
    gap: 16px;
    height: 56px;
    padding: 0 16px;
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .grid {
    padding: 92px 24px 0;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
  }
  .thumb {
    aspect-ratio: 1;
    border-radius: var(--radius-s);
  }
</style>
