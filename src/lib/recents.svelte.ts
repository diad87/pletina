export interface Recent {
  kind: 'artist' | 'album'
  id: number
  title: string
  subtitle: string
  image: string | null
}

const KEY = 'musify:recents'
const MAX = 12

function load(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

class Recents {
  items = $state<Recent[]>(load())

  add(item: Recent) {
    this.items = [item, ...this.items.filter((i) => !(i.kind === item.kind && i.id === item.id))].slice(0, MAX)
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items))
    } catch {
      // Sin almacenamiento disponible: la lista dura lo que la sesión.
    }
  }
}

export const recents = new Recents()
