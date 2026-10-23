/** The journal is a whole FIFO snapshot: exactly one context may own it.
 * The lock callback stays pending for this context's lifetime. In particular,
 * pagehide/BFCache never releases it while an old download could still resume.
 * Browser context termination releases Web Locks without an unsafe time lease.
 */
export const DOWNLOAD_OWNER_LOCK = 'pletina-download-owner:v1'
export class DownloadOwnershipError extends Error {
  constructor(readonly code: 'queue-busy' | 'queue-ownership-unavailable' | 'queue-ownership-released') {
    super(code === 'queue-busy' ? 'Hay otra ventana de Pletina gestionando las descargas. Ciérrala y pulsa Reintentar.'
      : code === 'queue-ownership-unavailable' ? 'Este navegador no permite proteger la cola de descargas. Usa un navegador actualizado compatible.'
        : 'Esta ventana ya no gestiona las descargas. Vuelve a abrir Pletina.')
    this.name = 'DownloadOwnershipError'
  }
}
export interface DownloadOwnership { acquire(): Promise<void>; assertOwned(): void }
export function createDownloadOwnership(options: { locks?: Pick<LockManager, 'request'> | null } = {}) {
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks
  let owned = false, disposed = false, acquiring: Promise<void> | undefined, release: (() => void) | undefined
  function assertOwned(): void {
    if (disposed) throw new DownloadOwnershipError('queue-ownership-released')
    if (!owned) throw new DownloadOwnershipError('queue-busy')
  }
  function acquire(): Promise<void> {
    if (disposed) return Promise.reject(new DownloadOwnershipError('queue-ownership-released'))
    if (!locks || typeof locks.request !== 'function') return Promise.reject(new DownloadOwnershipError('queue-ownership-unavailable'))
    if (owned) return Promise.resolve()
    if (acquiring) return acquiring
    let granted: () => void, denied: (error: unknown) => void
    const admission = new Promise<void>((resolve, reject) => { granted = resolve; denied = reject })
    const lifetime = new Promise<void>(resolve => { release = resolve })
    try {
      void locks.request(DOWNLOAD_OWNER_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (disposed) { denied(new DownloadOwnershipError('queue-ownership-released')); return }
        if (!lock) { denied(new DownloadOwnershipError('queue-busy')); return }
        owned = true; granted()
        await lifetime
        owned = false
      }).catch(() => { owned = false; denied(new DownloadOwnershipError('queue-ownership-unavailable')) })
    } catch { denied!(new DownloadOwnershipError('queue-ownership-unavailable')) }
    acquiring = admission.finally(() => { acquiring = undefined })
    return acquiring
  }
  // Used by isolated tests to model context destruction. Production keeps the
  // singleton alive: do not wire this to pagehide, visibilitychange or BFCache.
  function dispose(): void { disposed = true; owned = false; release?.() }
  return { acquire, assertOwned, dispose }
}
let ownership: DownloadOwnership | undefined
export const defaultDownloadOwnership = (): DownloadOwnership => ownership ??= createDownloadOwnership()
