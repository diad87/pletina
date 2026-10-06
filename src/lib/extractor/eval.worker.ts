// Ejecuta el trozo del reproductor de YouTube que descifra la firma y el parámetro `n` de las URL.
// Va en un worker para que ese código (de YouTube) no vea la app ni pueda llamar a Rust.

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; code: string }>) => void) | null
  postMessage(message: unknown): void
}

scope.onmessage = (e) => {
  const { id, code } = e.data
  try {
    const result = new Function(code)()
    scope.postMessage({ id, result })
  } catch (err) {
    scope.postMessage({ id, error: String(err) })
  }
}
