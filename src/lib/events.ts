// `listen` de Tauri, pero que reintenta si se pide demasiado pronto: en Android, lo que se pide en
// los primeros instantes de arrancar la app se rechaza ("not allowed by ACL") porque Tauri aún no
// ha terminado de preparar los permisos de la ventana.
import { listen as tauriListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'
import { inPwa } from './api'

let webEventId = 0

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  if (inPwa) {
    const id = ++webEventId
    const receive = (value: Event) => {
      if (value instanceof CustomEvent) handler({ event, id, payload: value.detail as T })
    }
    window.addEventListener('pletina:' + event, receive)
    return () => window.removeEventListener('pletina:' + event, receive)
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await tauriListen<T>(event, handler)
    } catch (e) {
      if (attempt >= 20 || !String(e).includes('not allowed')) throw e
      await new Promise((r) => setTimeout(r, 150))
    }
  }
}
