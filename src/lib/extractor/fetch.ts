import { invoke } from '@tauri-apps/api/core'

/**
 * `fetch` para youtubei.js: la petición la hace Rust (comando `http_fetch`), así que no hay
 * CORS y se pueden mandar cabeceras que el navegador no deja (User-Agent, Origin, Cookie…).
 */
export async function rustFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null
  const url = req ? req.url : input.toString()
  const method = init?.method ?? req?.method ?? 'GET'

  const headers = new Headers(req?.headers)
  new Headers(init?.headers).forEach((v, k) => headers.set(k, v))

  let body: string | number[] | null = null
  const raw = init?.body ?? (req?.body ? await req.clone().arrayBuffer() : null)
  if (typeof raw === 'string') body = raw
  else if (raw != null) body = Array.from(new Uint8Array(await new Response(raw).arrayBuffer()))

  const buf = await invoke<ArrayBuffer>('http_fetch', { req: { url, method, headers: [...headers], body } })
  const size = new DataView(buf).getUint32(0, true)
  const head: { status: number; statusText: string; headers: [string, string][]; url: string } = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, size)),
  )
  const noBody = [101, 204, 205, 304].includes(head.status)
  const res = new Response(noBody ? null : new Uint8Array(buf, 4 + size), {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers,
  })
  Object.defineProperty(res, 'url', { value: head.url })
  return res
}
