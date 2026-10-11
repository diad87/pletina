import { toast } from './toast.svelte'

export interface Pin {
  kind: 'album' | 'playlist'
  id: number
  title: string
  image?: string | null
  covers?: string[]
}

const KEY = 'musify:pins'

function valid(value: unknown): value is Pin {
  if (!value || typeof value !== 'object') return false
  const pin = value as Partial<Pin>
  return (pin.kind === 'album' || pin.kind === 'playlist')
    && typeof pin.id === 'number' && Number.isSafeInteger(pin.id) && pin.id > 0
    && typeof pin.title === 'string' && pin.title.trim().length > 0
    && (pin.image === undefined || pin.image === null || typeof pin.image === 'string')
    && (pin.covers === undefined || (Array.isArray(pin.covers) && pin.covers.every((cover) => typeof cover === 'string')))
}

function copy(pin: Pin): Pin {
  return { kind: pin.kind, id: pin.id, title: pin.title, image: pin.image, covers: pin.covers?.slice() }
}

function load(): Pin[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(stored)) return []
    const seen = new Set<string>()
    return stored.filter(valid).filter((pin) => {
      const key = `${pin.kind}:${pin.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map(copy)
  } catch {
    return []
  }
}

class Pins {
  items = $state<Pin[]>(load())

  has(kind: Pin['kind'], id: number) {
    return this.items.some((pin) => pin.kind === kind && pin.id === id)
  }

  toggle(pin: Pin) {
    if (!valid(pin)) return
    const pinned = this.has(pin.kind, pin.id)
    if (pinned) this.remove(pin.kind, pin.id)
    else {
      this.items = [...this.items, copy(pin)]
      this.#save()
    }
    toast.show(pinned ? `«${pin.title}» desfijado de Inicio` : `«${pin.title}» fijado en Inicio`)
  }

  remove(kind: Pin['kind'], id: number) {
    const next = this.items.filter((pin) => pin.kind !== kind || pin.id !== id)
    if (next.length === this.items.length) return
    this.items = next
    this.#save()
  }

  /** Llamar solo cuando se haya cargado la biblioteca correctamente. */
  prunePlaylists(ids: Iterable<number>) {
    const existing = new Set(ids)
    const next = this.items.filter((pin) => pin.kind !== 'playlist' || existing.has(pin.id))
    if (next.length === this.items.length) return
    this.items = next
    this.#save()
  }

  #save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items))
    } catch {
      // Sin almacenamiento disponible, los accesos se conservan durante esta sesión.
    }
  }
}

export const pins = new Pins()
