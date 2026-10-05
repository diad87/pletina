export function duration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function longDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

/** Deezer usa "0000-00-00" cuando no conoce la fecha. */
export function validDate(date: string | null): date is string {
  return !!date && !date.startsWith('0000')
}

export function year(date: string | null): string {
  return validDate(date) ? date.slice(0, 4) : ''
}

export function longDate(date: string | null): string {
  if (!validDate(date)) return ''
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date))
}

const RECORD_TYPES: Record<string, string> = {
  album: 'Álbum',
  single: 'Sencillo',
  ep: 'EP',
  compile: 'Recopilatorio',
}

export function recordType(type: string | null): string {
  return (type && RECORD_TYPES[type]) || 'Álbum'
}

export function fans(n: number): string {
  return new Intl.NumberFormat('es-ES').format(n)
}

/** "ahora", "hace 5 min", "hace 3 h", "ayer", "hace 4 días" o la fecha. */
export function relativeTime(unix: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - unix)
  if (seconds < 60) return 'ahora'
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `hace ${Math.floor(seconds / 3600)} h`
  const days = Math.floor(seconds / 86400)
  if (days === 1) return 'ayer'
  if (days < 7) return `hace ${days} días`
  return shortDate(unix)
}

/** "12 sept 2026". */
export function shortDate(unix: number): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(unix * 1000))
}

export function songs(n: number): string {
  return n === 1 ? '1 canción' : `${fans(n)} canciones`
}
