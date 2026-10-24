export const SLEEP_PRESETS = [15, 30, 60] as const
export const MIN_SLEEP_MINUTES = 1
export const MAX_SLEEP_MINUTES = 1440

export interface SleepTimerState {
  mode: 'off' | 'time' | 'end'
  /** Hora de corte en milisegundos, o cero si no hay cuenta atrás. */
  endsAt: number
}

export function isSleepMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MIN_SLEEP_MINUTES && minutes <= MAX_SLEEP_MINUTES
}
