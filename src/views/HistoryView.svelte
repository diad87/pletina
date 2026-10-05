<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import Status from '../components/Status.svelte'
  import TrackList from '../components/TrackList.svelte'
  import * as api from '../lib/api'
  import { relativeTime } from '../lib/format'
  import { fromLib, library } from '../lib/library.svelte'
  import { nav } from '../lib/nav.svelte'
  import type { Entry } from '../lib/types'

  let entries = $state<Entry[] | null>(null)
  let error = $state<string | null>(null)
  let confirmClear = $state(false)
  let first = true

  $effect(() => {
    void library.historyVersion
    let alive = true
    api
      .history(500)
      .then((list) => {
        if (!alive) return
        entries = list
        if (first) nav.ready()
        first = false
      })
      .catch((e) => alive && (error = String(e)))
    return () => {
      alive = false
    }
  })

  const items = $derived((entries ?? []).map((e) => fromLib(e.track)))
</script>

<section class="page">
  <div class="title-row">
    <h1 class="page-title">Historial</h1>
    {#if items.length && !confirmClear}
      <button class="ghost" onclick={() => (confirmClear = true)}><Icon name="trash" size={16} /> Borrar historial</button>
    {/if}
  </div>

  {#if confirmClear}
    <div class="confirm">
      <span>¿Borrar todo el historial de escuchas?</span>
      <button class="ghost" onclick={() => (confirmClear = false)}>Cancelar</button>
      <button
        class="pill danger"
        onclick={async () => {
          confirmClear = false
          await library.clearHistory()
        }}>Borrar</button
      >
    </div>
  {/if}

  {#if error}
    <Status {error} />
  {:else if !entries}
    <Status />
  {:else if items.length}
    <TrackList {items} variant="list" metaLabel="Escuchada" meta={(i) => relativeTime(entries![i].at)} />
  {:else}
    <div class="empty-state">
      <Icon name="clock" size={48} />
      <strong>Aún no has escuchado nada</strong>
      <p>Cada canción que suene más de 30 segundos aparecerá aquí.</p>
    </div>
  {/if}
</section>

<style>
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .ghost {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: 12px;
    color: var(--muted);
    font-weight: 700;
  }
  .ghost:hover {
    color: var(--text);
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 0 12px 16px;
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--elevated);
  }
  .confirm span {
    flex: 1;
  }
  .danger {
    background: #ff8a80;
  }
</style>
