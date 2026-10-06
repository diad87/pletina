<script lang="ts">
  // "Tu biblioteca" en el móvil (en escritorio es la barra lateral).
  import Icon from '../components/Icon.svelte'
  import LibraryList from '../components/LibraryList.svelte'
  import { newPlaylist } from '../lib/actions'
  import { theme } from '../lib/theme.svelte'

  theme.clear()
  theme.neutral()
</script>

<section class="page top">
  <div class="title-row">
    <h1 class="page-title">Tu biblioteca</h1>
    <button class="add" onclick={newPlaylist} title="Crear playlist"><Icon name="plus" size={26} /></button>
  </div>
  <LibraryList />
</section>

<style>
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .add {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--text);
  }
</style>
