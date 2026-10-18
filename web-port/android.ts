export const isAndroid = false
// Rollup elimina esta rama del reproductor en el build web.
export class AndroidPlayer { constructor() { throw new Error('El servicio nativo no forma parte de la PWA.') } }
