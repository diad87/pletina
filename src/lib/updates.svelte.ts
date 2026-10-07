import { getVersion } from '@tauri-apps/api/app'
import { listen } from './events'
import { isAndroid } from './player-android.svelte'
import { version } from '../../package.json'
import * as api from './api'
import { toast } from './toast.svelte'

/** Estado de las actualizaciones automáticas (eventos "update" del backend). */
class Updates {
  /** Versión instalada. */
  current = $state('')
  state = $state<'idle' | 'downloading' | 'ready'>('idle')
  /** Versión nueva que se está descargando o que ya está lista. */
  version = $state('')
  /** Móvil: versión publicada más nueva que la instalada (se instala con Obtainium o a mano). */
  available = $state('')

  async init() {
    if (!api.inTauri) {
      this.current = version
      return
    }
    this.current = await getVersion().catch(() => '')
    if (isAndroid) {
      this.available = (await api.newerVersion().catch(() => null)) ?? ''
      if (this.available) toast.show(`Hay una versión nueva de Musify: ${this.available}`)
      return
    }
    await listen<{ state: 'downloading' | 'ready'; version: string }>('update', (e) => {
      this.state = e.payload.state
      this.version = e.payload.version
    })
  }

  /** Instala ya la versión descargada y reinicia la app. */
  async install() {
    try {
      await api.installUpdate()
    } catch (e) {
      toast.show(`No se pudo actualizar: ${e}`)
    }
  }
}

export const updates = new Updates()
