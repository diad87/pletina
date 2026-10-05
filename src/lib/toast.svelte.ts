/** Aviso temporal que se muestra sobre la barra de reproducción. */
class Toast {
  message = $state<string | null>(null)
  #timer: ReturnType<typeof setTimeout> | undefined

  show(message: string) {
    this.message = message
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => (this.message = null), 4000)
  }
}

export const toast = new Toast()
