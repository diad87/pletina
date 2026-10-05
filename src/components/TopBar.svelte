<script lang="ts">
  import { nav } from '../lib/nav.svelte'
  import Icon from './Icon.svelte'

  let input: HTMLInputElement | undefined = $state()
  let value = $state('')

  // Al volver atrás a una búsqueda, el cuadro muestra su texto; fuera de búsqueda, vacío.
  $effect(() => {
    const route = nav.route
    value = route.name === 'search' ? route.query : ''
  })

  nav.focusSearch = () => {
    input?.focus()
    input?.select()
  }

  function onInput() {
    const route = { name: 'search' as const, query: value }
    if (nav.route.name === 'search') nav.replace(route)
    else nav.go(route)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if (value) {
      value = ''
      onInput()
    } else {
      input?.blur()
    }
  }
</script>

<header class="topbar">
  <div class="arrows">
    <button class="round" onclick={() => nav.back()} disabled={!nav.canBack} title="Atrás (Alt+←)">
      <Icon name="back" />
    </button>
    <button class="round" onclick={() => nav.forward()} disabled={!nav.canForward} title="Adelante (Alt+→)">
      <Icon name="forward" />
    </button>
  </div>

  <label class="search">
    <Icon name="search" />
    <input
      bind:this={input}
      bind:value
      oninput={onInput}
      onkeydown={onKeydown}
      placeholder="¿Qué quieres escuchar?"
      spellcheck="false"
      autocomplete="off"
    />
    {#if value}
      <button
        class="clear"
        title="Borrar"
        onclick={() => {
          value = ''
          onInput()
          input?.focus()
        }}><Icon name="close" size={18} /></button
      >
    {/if}
  </label>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 64px;
    padding: 0 24px;
    flex: none;
  }
  .arrows {
    display: flex;
    gap: 8px;
  }
  .round {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.5);
    color: var(--text);
  }
  .round:disabled {
    color: var(--faint);
    cursor: default;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(420px, 100%);
    height: 44px;
    padding: 0 12px 0 14px;
    border-radius: 22px;
    background: var(--elevated);
    color: var(--muted);
    border: 2px solid transparent;
    transition: border-color 0.15s;
  }
  .search:focus-within {
    border-color: var(--text);
    color: var(--text);
  }
  input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text);
    font: inherit;
    font-size: 15px;
  }
  input::placeholder {
    color: var(--muted);
  }
  .clear {
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .clear:hover {
    color: var(--text);
  }
</style>
