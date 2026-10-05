<script lang="ts">
  import Cover from './Cover.svelte'

  let {
    image,
    title,
    subtitle,
    round = false,
    onclick,
  }: { image: string | null; title: string; subtitle: string; round?: boolean; onclick: () => void } = $props()
</script>

<button class="card" class:round {onclick} {title}>
  <Cover src={image} {round} />
  <span class="title">{title}</span>
  <span class="subtitle">{subtitle}</span>
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 12px;
    border-radius: 8px;
    text-align: left;
    transition: background 0.15s;
  }
  .card:hover,
  .card:focus-visible {
    background: var(--hover);
  }
  .title {
    margin-top: 8px;
    font-weight: 600;
    color: var(--text);
  }
  .subtitle {
    font-size: 13px;
    color: var(--muted);
  }
  .title,
  .subtitle {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .round .title,
  .round .subtitle {
    text-align: center;
  }
</style>
