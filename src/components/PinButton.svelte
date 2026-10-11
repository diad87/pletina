<script lang="ts">
  import { pins, type Pin } from '../lib/pins.svelte'
  import Icon from './Icon.svelte'

  let { item, size = 28 }: { item: Pin; size?: number } = $props()
  const pinned = $derived(pins.has(item.kind, item.id))
  const label = $derived(pinned ? 'Desfijar de Inicio' : 'Fijar en Inicio')
</script>

<button
  class="action"
  class:on={pinned}
  title={label}
  aria-label={label}
  aria-pressed={pinned}
  onclick={() => pins.toggle(item)}
>
  <Icon name="pin" {size} />
</button>
