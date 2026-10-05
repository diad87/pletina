<script lang="ts">
  import Icon from './Icon.svelte'

  let { src, round = false }: { src: string | null; round?: boolean } = $props()

  let failed = $state(false)
  let loaded = $state(false)
  $effect(() => {
    void src
    failed = false
    loaded = false
  })
</script>

<div class="cover" class:round>
  {#if src && !failed}
    <img
      {src}
      alt=""
      loading="lazy"
      decoding="async"
      class:loaded
      onload={() => (loaded = true)}
      onerror={() => (failed = true)}
    />
  {:else}
    <Icon name="note" size={32} />
  {/if}
</div>

<style>
  .cover {
    position: relative;
    aspect-ratio: 1;
    width: 100%;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: var(--radius-s);
    background: linear-gradient(135deg, var(--elevated), var(--panel-2));
    color: var(--faint);
    box-shadow: var(--shadow-1);
  }
  /* Borde interior muy fino: separa carátulas oscuras del fondo. */
  .cover::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.06);
    pointer-events: none;
  }
  .round {
    border-radius: 50%;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transform: scale(1.02);
    transition:
      opacity 0.4s var(--ease),
      transform 0.6s var(--ease);
  }
  img.loaded {
    opacity: 1;
    transform: none;
  }
</style>
