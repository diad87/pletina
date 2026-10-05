<script lang="ts">
  import Icon from './Icon.svelte'

  let { src, round = false }: { src: string | null; round?: boolean } = $props()

  let failed = $state(false)
  $effect(() => {
    void src
    failed = false
  })
</script>

<div class="cover" class:round>
  {#if src && !failed}
    <img {src} alt="" loading="lazy" decoding="async" onerror={() => (failed = true)} />
  {:else}
    <Icon name="note" size={32} />
  {/if}
</div>

<style>
  .cover {
    aspect-ratio: 1;
    width: 100%;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: 6px;
    background: var(--elevated);
    color: var(--faint);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
  }
  .round {
    border-radius: 50%;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
