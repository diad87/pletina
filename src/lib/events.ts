// `listen` de Tauri, pero que reintenta si se pide demasiado pronto: en Android, lo que se pide en
// los primeros instantes de arrancar la app se rechaza ("not allowed by ACL") porque Tauri aún no
// ha terminado de preparar los permisos de la ventana.
import { listen as tauriListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tauriListen<T>(event, handler)
    } catch (e) {
      if (attempt >= 20 || !String(e).includes('not allowed')) throw e
      await new Promise((r) => setTimeout(r, 150))
    }
  }
}
