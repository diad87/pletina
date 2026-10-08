import { listen } from './events'
import * as api from './api'
import { toast } from './toast.svelte'
import type { LocalLibrary } from './types'

/** Música local: carpetas, discos y artistas importados, y el progreso del escaneo. */
class Local {
  data = $state<LocalLibrary | null>(null)
  /** Escaneo en curso: qué está haciendo y cuánto lleva. */
  scan = $state<{ state: 'scanning' | 'covers'; done: number; total: number } | null>(null)
  /** Sube cada vez que cambia la música local; las vistas lo leen para recargarse. */
  version = $state(0)

  async init() {
    await this.load()
    if (!api.inTauri) return
    await listen('local-changed', () => {
      this.version++
      this.load()
    })
    await listen<{ state: 'scanning' | 'covers' | 'done'; done: number; total: number; added: number; removed: number }>(
      'local-scan',
      (e) => {
        const p = e.payload
        if (p.state === 'done') {
          this.scan = null
          if (p.added || p.removed) {
            const parts = [p.added && `${p.added} canciones nuevas`, p.removed && `${p.removed} quitadas`].filter(Boolean)
            toast.show(`Tu música al día: ${parts.join(', ')}`)
          }
        } else {
          this.scan = { state: p.state, done: p.done, total: p.total }
        }
      },
    )
  }

  async load() {
    try {
      this.data = await api.localLibrary()
      if (this.data.scanning && !this.scan) this.scan = { state: 'scanning', done: 0, total: 0 }
    } catch (e) {
      toast.show(`No se pudo cargar tu música: ${e}`)
    }
  }

  async addFolder() {
    try {
      const before = this.data?.folders.length ?? 0
      const folders = await api.addLocalFolder()
      if (this.data) this.data.folders = folders
      if (folders.length > before) {
        this.scan = { state: 'scanning', done: 0, total: 0 }
        toast.show('Buscando música en la carpeta…')
      }
    } catch (e) {
      toast.show(`No se pudo añadir la carpeta: ${e}`)
    }
  }

  async removeFolder(path: string) {
    try {
      const folders = await api.removeLocalFolder(path)
      if (this.data) this.data.folders = folders
      this.scan = { state: 'scanning', done: 0, total: 0 }
    } catch (e) {
      toast.show(`No se pudo quitar la carpeta: ${e}`)
    }
  }

  rescan() {
    this.scan = { state: 'scanning', done: 0, total: 0 }
    api.scanLocal()
  }
}

export const local = new Local()
