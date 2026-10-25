# Pletina: instalaciones anteriores

Esta dirección conserva la identidad y los datos de la PWA que se instaló
desde GitHub. Su pequeño service worker importa la distribución actual de
https://pletina-app.netlify.app/, con las copias de Codeberg y Cloudflare
gestionadas por esa entrada. Los recursos mantienen su verificación SHA-256.

Las siguientes publicaciones de la distribución nueva se detectan mediante
el worker importado; este puente no contiene otra compilación de la aplicación.
Los archivos históricos se conservan para los clientes que aún no actualizaron.

GitHub Pages debe seguir sirviendo `sw.js` e `index.html`. No elimines ni
desactives esta dirección mientras quieras mantener las instalaciones antiguas.
El cambio se recibe al volver a abrir con conexión y se activa con el mecanismo
habitual de actualización. No se borran biblioteca, listas ni descargas.

La nueva instalación directa está en https://pletina-app.netlify.app/.
Código fuente correspondiente y licencias: https://codeberg.org/pletina/pletina.
El código de este puente se conserva legible en `sw.js` e `index.html` y se
distribuye bajo la licencia GPL del proyecto.

Las instalaciones de usuarios no se registraban; su total es desconocido.
