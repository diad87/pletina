<script lang="ts">
  import { tick } from 'svelte'
  import { menu, type MenuItem } from '../lib/menu.svelte'
  import Icon from './Icon.svelte'

  let root: HTMLElement | undefined = $state()
  let pos = $state({ x: 0, y: 0 })
  /** Submenú abierto (índice del elemento padre). */
  let sub = $state<number | null>(null)
  let subLeft = $state(false)

  // Al abrirse, se recoloca para no salirse de la ventana.
  $effect(() => {
    const open = menu.open
    sub = null
    if (!open) return
    pos = { x: open.x, y: open.y }
    tick().then(() => {
      if (!root) return
      const r = root.getBoundingClientRect()
      pos = {
        x: Math.max(8, Math.min(open.x, innerWidth - r.width - 8)),
        y: Math.max(8, Math.min(open.y, innerHeight - r.height - 8)),
      }
      subLeft = pos.x + r.width + 240 > innerWidth
    })
  })

  function run(item: MenuItem) {
    if (item.children) return
    menu.close()
    item.action?.()
  }

  function onWindowDown(e: MouseEvent) {
    if (menu.open && root && !root.contains(e.target as Node)) menu.close()
  }
</script>

<svelte:window
  onmousedown={onWindowDown}
  onkeydown={(e) => e.key === 'Escape' && menu.close()}
  onresize={() => menu.close()}
  onblur={() => menu.close()}
  onwheel={(e) => root && !root.contains(e.target as Node) && menu.close()}
/>

{#if menu.open}
  <div class="menu" role="menu" bind:this={root} style:left="{pos.x}px" style:top="{pos.y}px">
    {#each menu.open.items as item, i (i)}
      {#if item.separated}<hr />{/if}
      <div class="entry" role="none" onmouseenter={() => (sub = item.children ? i : null)}>
        <button class="item" class:danger={item.danger} role="menuitem" onclick={() => run(item)}>
          {#if item.icon}<Icon name={item.icon} size={16} />{:else}<span class="spacer"></span>{/if}
          <span class="label">{item.label}</span>
          {#if item.children}<Icon name="forward" size={14} />{/if}
        </button>
        {#if item.children && sub === i}
          <div class="menu submenu" class:left={subLeft} role="menu">
            {#each item.children as child, j (j)}
              {#if child.separated}<hr />{/if}
              <button class="item" role="menuitem" onclick={() => run(child)}>
                {#if child.icon}<Icon name={child.icon} size={16} />{:else}<span class="spacer"></span>{/if}
                <span class="label">{child.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 50;
    min-width: 220px;
    max-width: 320px;
    padding: 4px;
    border-radius: 6px;
    background: var(--elevated);
    box-shadow: 0 16px 32px rgb(0 0 0 / 0.5);
  }
  .submenu {
    position: absolute;
    top: -4px;
    left: 100%;
    max-height: 60vh;
    overflow-y: auto;
  }
  .submenu.left {
    left: auto;
    right: 100%;
  }
  .entry {
    position: relative;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border-radius: 3px;
    text-align: left;
    color: var(--text);
  }
  .item:hover,
  .item:focus-visible {
    background: rgb(255 255 255 / 0.1);
  }
  .danger {
    color: #ff8a80;
  }
  .label {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .spacer {
    width: 16px;
  }
  hr {
    margin: 4px 0;
    border: 0;
    border-top: 1px solid rgb(255 255 255 / 0.1);
  }
</style>
