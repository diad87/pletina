<script lang="ts">
  import { tick } from 'svelte'
  import { layout } from '../lib/layout.svelte'
  import { menu, type MenuItem } from '../lib/menu.svelte'
  import Cover from './Cover.svelte'
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
    // En el móvil sale desde abajo: no hay que colocarlo.
    if (layout.mobile) return
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

{#if menu.open && layout.mobile}
  <!-- Móvil: hoja desde abajo. Los submenús (p. ej. "Añadir a playlist") sustituyen la lista. -->
  <div class="scrim" aria-hidden="true"></div>
  <div class="sheet" role="menu" bind:this={root}>
    <span class="grip" aria-hidden="true"></span>
    {#if menu.open.header}
      <div class="sheet-head">
        {#if menu.open.header.cover !== undefined}<span class="sheet-art"><Cover src={menu.open.header.cover} /></span>{/if}
        <span class="sheet-text">
          <span class="sheet-title">{menu.open.header.title}</span>
          {#if menu.open.header.subtitle}<span class="sheet-sub">{menu.open.header.subtitle}</span>{/if}
        </span>
      </div>
    {/if}
    {#if sub !== null && menu.open.items[sub]?.children}
      {@const parent = menu.open.items[sub]}
      <button class="item back" role="menuitem" onclick={() => (sub = null)}>
        <Icon name="back" size={20} />
        <span class="label">{parent.label}</span>
      </button>
      {#each parent.children ?? [] as child, j (j)}
        {#if child.separated}<hr />{/if}
        <button class="item" role="menuitem" onclick={() => run(child)}>
          {#if child.icon}<Icon name={child.icon} size={20} />{:else}<span class="spacer"></span>{/if}
          <span class="label">{child.label}</span>
        </button>
      {/each}
    {:else}
      {#each menu.open.items as item, i (i)}
        {#if item.separated}<hr />{/if}
        <button
          class="item"
          class:danger={item.danger}
          role="menuitem"
          onclick={() => (item.children ? (sub = i) : run(item))}
        >
          {#if item.icon}<Icon name={item.icon} size={20} />{:else}<span class="spacer"></span>{/if}
          <span class="label">{item.label}</span>
          {#if item.children}<Icon name="forward" size={16} />{/if}
        </button>
      {/each}
    {/if}
  </div>
{:else if menu.open}
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

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 49;
    background: rgb(0 0 0 / 0.55);
    animation: fade-in 0.2s ease;
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    max-height: 75vh;
    overflow-y: auto;
    padding: 8px 8px calc(12px + var(--safe-bottom));
    border-radius: 16px 16px 0 0;
    background: var(--panel-2);
    box-shadow: 0 -12px 40px rgb(0 0 0 / 0.5);
    animation: sheet-up 0.25s var(--ease);
  }
  @keyframes sheet-up {
    from {
      transform: translateY(40%);
      opacity: 0;
    }
  }
  .grip {
    display: block;
    width: 36px;
    height: 4px;
    margin: 4px auto 10px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.25);
  }
  .sheet .item {
    gap: 16px;
    height: 52px;
    padding: 0 12px;
    font-size: 15px;
  }
  .sheet .item:hover {
    background: none;
  }
  .sheet .item:active {
    background: var(--press);
  }
  .sheet .back {
    color: var(--muted);
    font-weight: 700;
  }
  .sheet-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 12px 12px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--line);
  }
  .sheet-art {
    flex: none;
    width: 48px;
  }
  .sheet-art :global(.cover) {
    border-radius: 4px;
  }
  .sheet-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .sheet-title,
  .sheet-sub {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sheet-title {
    font-weight: 700;
  }
  .sheet-sub {
    font-size: 13px;
    color: var(--muted);
  }
</style>
