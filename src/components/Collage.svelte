<script lang="ts">
  // Portada de playlist: una carátula, o mosaico de 4 si hay discos suficientes.
  import Icon from './Icon.svelte'

  let { covers }: { covers: string[] } = $props()
</script>

<div class="collage">
  {#if covers.length >= 4}
    {#each covers.slice(0, 4) as src (src)}<img {src} alt="" loading="lazy" />{/each}
  {:else if covers.length}
    <img class="single" src={covers[0]} alt="" loading="lazy" />
  {:else}
    <Icon name="note" size={32} />
  {/if}
</div>

<style>
  .collage {
    aspect-ratio: 1;
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    place-items: center;
    overflow: hidden;
    border-radius: 6px;
    background: var(--elevated);
    color: var(--faint);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .single,
  .collage > :global(svg) {
    grid-column: 1 / -1;
    grid-row: 1 / -1;
  }
</style>
