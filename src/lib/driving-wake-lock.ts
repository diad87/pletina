export type DrivingWakeLockState = 'unsupported' | 'off' | 'requesting' | 'active' | 'unavailable'

export interface DrivingWakeLockEnvironment {
  wakeLock?: Pick<WakeLock, 'request'>
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
}

/** Keep the driving screen awake while it is visible, when the browser permits it. */
export function createDrivingWakeLock(
  onState: (state: DrivingWakeLockState) => void,
  environment?: DrivingWakeLockEnvironment,
): { setEnabled(enabled: boolean): void; destroy(): void } {
  const wakeLock = environment ? environment.wakeLock : typeof navigator === 'undefined' ? undefined : navigator.wakeLock
  const page = environment ? environment.document : typeof document === 'undefined' ? undefined : document
  const supported = typeof wakeLock?.request === 'function' && !!page
  let enabled = false
  let destroyed = false
  let pending = false
  let revision = 0
  let visible = page?.visibilityState === 'visible'
  let sentinel: WakeLockSentinel | undefined
  let releaseListener: (() => void) | undefined
  let state: DrivingWakeLockState | undefined

  function emit(next: DrivingWakeLockState) {
    if (state === next) return
    state = next
    onState(next)
  }

  function release(lock: WakeLockSentinel) {
    if (lock.released) return
    try {
      void lock.release().catch(() => {})
    } catch {
      // Some browser implementations may reject releasing an already lost lock.
    }
  }

  function releaseCurrent() {
    if (!sentinel) return
    const previous = sentinel
    sentinel = undefined
    if (releaseListener) previous.removeEventListener('release', releaseListener)
    releaseListener = undefined
    release(previous)
  }

  async function acquire() {
    if (!supported || destroyed || !enabled || !visible || sentinel) return
    emit('requesting')
    if (pending) return
    pending = true
    const requestedRevision = revision
    try {
      const acquired = await wakeLock!.request('screen')
      if (destroyed || requestedRevision !== revision || !enabled || !visible) {
        release(acquired)
        return
      }
      if (acquired.released) {
        emit('unavailable')
        return
      }
      sentinel = acquired
      releaseListener = () => {
        if (sentinel !== acquired) return
        if (releaseListener) acquired.removeEventListener('release', releaseListener)
        sentinel = undefined
        releaseListener = undefined
        if (!destroyed) emit(enabled && visible ? 'unavailable' : 'off')
        // A system release must not trigger an automatic request/release loop.
      }
      acquired.addEventListener('release', releaseListener)
      if (acquired.released) releaseListener()
      else emit('active')
    } catch {
      if (!destroyed && requestedRevision === revision && enabled && visible) emit('unavailable')
    } finally {
      pending = false
      // An enable/visibility change during a request needs a fresh acquisition.
      if (!destroyed && requestedRevision !== revision && enabled && visible) void acquire()
    }
  }

  function onVisibilityChange() {
    const nextVisible = page?.visibilityState === 'visible'
    if (visible === nextVisible) return
    visible = nextVisible
    revision += 1
    if (!visible) {
      releaseCurrent()
      emit('off')
    } else if (enabled) {
      void acquire()
    }
  }

  emit(supported ? 'off' : 'unsupported')
  if (supported) page!.addEventListener('visibilitychange', onVisibilityChange)

  return {
    setEnabled(nextEnabled) {
      if (destroyed || enabled === nextEnabled) return
      enabled = nextEnabled
      revision += 1
      if (!supported) return
      if (enabled && visible) void acquire()
      else {
        releaseCurrent()
        emit('off')
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      enabled = false
      revision += 1
      if (supported) page!.removeEventListener('visibilitychange', onVisibilityChange)
      releaseCurrent()
      if (supported) emit('off')
    },
  }
}
