//! Lectura de la vista pública de una playlist. No usa cuentas, tokens ni audio de Spotify.
//!
//! El embed no es una API de exportación: hoy entrega como máximo 100 entradas y
//! no incluye total ni paginación. La interfaz debe conservar los avisos al importar.

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const EMBED_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTrack {
    pub title: String,
    pub artists: Vec<String>,
    pub duration_ms: Option<u64>,
    pub isrc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub name: String,
    pub tracks: Vec<ImportTrack>,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|c| c.is_ascii_alphanumeric())
}

fn playlist_id(input: &str) -> Result<String, String> {
    let input = input.trim();
    let invalid = || "Pega el enlace completo de una playlist de Spotify (https://open.spotify.com/playlist/…)".to_string();
    if input.len() > 4096 {
        return Err(invalid());
    }
    if let Some(id) = input.strip_prefix("spotify:playlist:") {
        return valid_id(id).then(|| id.to_owned()).ok_or_else(invalid);
    }
    // URI antiguas que todavía pueden estar guardadas en listas o marcadores.
    if input.starts_with("spotify:user:") {
        let parts: Vec<_> = input.split(':').collect();
        if let ["spotify", "user", user, "playlist", id] = parts.as_slice() {
            if !user.is_empty() && valid_id(id) {
                return Ok((*id).to_owned());
            }
        }
        return Err(invalid());
    }
    let url = Url::parse(input).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty()
        || url.password().is_some() || url.port().is_some()
    {
        return Err(invalid());
    }
    if matches!(url.host_str(), Some("spotify.link" | "spoti.fi")) {
        return Err("Abre el enlace corto en el navegador y copia la dirección completa de la playlist, que empieza por https://open.spotify.com/playlist/".into());
    }
    if url.host_str() != Some("open.spotify.com") {
        return Err(invalid());
    }
    let parts: Vec<_> = url.path().trim_end_matches('/').split('/').filter(|p| !p.is_empty()).collect();
    let id = match parts.as_slice() {
        ["playlist", id] | ["embed", "playlist", id] => *id,
        [locale, "playlist", id] if locale.strip_prefix("intl-").is_some_and(|l| {
            (2..=16).contains(&l.len()) && l.bytes().all(|c| c.is_ascii_alphabetic() || c == b'-')
        }) => *id,
        _ => return Err(invalid()),
    };
    valid_id(id).then(|| id.to_owned()).ok_or_else(invalid)
}

pub async fn read_playlist(input: &str) -> Result<ImportSource, String> {
    let id = playlist_id(input)?;
    let client = Client::builder()
        .user_agent(concat!("Pletina/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        // Nunca seguimos un enlace proporcionado por el usuario ni una redirección.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("No se pudo preparar la conexión con Spotify: {e}"))?;
    let mut response = client.get(format!("https://open.spotify.com/embed/playlist/{id}"))
        .send().await.map_err(|e| format!("No se pudo conectar con Spotify: {e}"))?;
    match response.status().as_u16() {
        200 => {},
        404 => return Err("No se encontró la playlist. Comprueba el enlace y que sea pública".into()),
        429 => return Err("Spotify ha limitado las consultas. Espera un momento y vuelve a intentarlo".into()),
        _ => return Err("Spotify no permite leer esta playlist. Comprueba que sea pública y vuelve a intentarlo".into()),
    }
    if response.content_length().is_some_and(|n| n > MAX_PAGE_BYTES as u64) {
        return Err("La respuesta de Spotify es demasiado grande".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await
        .map_err(|e| format!("No se pudo terminar de leer Spotify: {e}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_PAGE_BYTES {
            return Err("La respuesta de Spotify es demasiado grande".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let html = std::str::from_utf8(&bytes)
        .map_err(|_| "Spotify devolvió una respuesta que no se pudo leer".to_string())?;
    parse_playlist(html, &id)
}

/// Encuentra un atributo sin depender del orden, las comillas o el espaciado del HTML.
fn attribute<'a>(mut tag: &'a str, wanted: &str) -> Option<&'a str> {
    while !tag.is_empty() {
        tag = tag.trim_start();
        let end = tag.find(|c: char| c.is_ascii_whitespace() || c == '=').unwrap_or(tag.len());
        let name = &tag[..end];
        tag = tag[end..].trim_start();
        if !tag.starts_with('=') {
            if tag.is_empty() { break; }
            continue;
        }
        tag = tag[1..].trim_start();
        let quote = tag.chars().next()?;
        let value;
        if matches!(quote, '\'' | '"') {
            tag = &tag[1..];
            let end = tag.find(quote)?;
            value = &tag[..end];
            tag = &tag[end + 1..];
        } else {
            let end = tag.find(char::is_whitespace).unwrap_or(tag.len());
            value = &tag[..end];
            tag = &tag[end..];
        }
        if name.eq_ignore_ascii_case(wanted) { return Some(value); }
    }
    None
}

fn next_data(mut html: &str) -> Option<&str> {
    while let Some(start) = html.find("<script") {
        html = &html[start + "<script".len()..];
        if !html.starts_with(|c: char| c.is_ascii_whitespace() || c == '>') { continue; }
        let end = html.find('>')?;
        let tag = &html[..end];
        html = &html[end + 1..];
        let close = html.find("</script>")?;
        if attribute(tag, "id") == Some("__NEXT_DATA__") { return Some(&html[..close]); }
        html = &html[close + "</script>".len()..];
    }
    None
}

fn parse_playlist(html: &str, expected_id: &str) -> Result<ImportSource, String> {
    let unsupported = || "No se pudo leer la vista pública de Spotify. La playlist puede ser privada, no estar disponible o haber cambiado el formato de Spotify".to_string();
    let raw = next_data(html).ok_or_else(unsupported)?;
    let data: Value = serde_json::from_str(raw).map_err(|_| unsupported())?;
    let entity = data.pointer("/props/pageProps/state/data/entity").ok_or_else(unsupported)?;
    if entity.get("type").and_then(Value::as_str) != Some("playlist")
        || entity.get("id").and_then(Value::as_str) != Some(expected_id)
    {
        return Err(unsupported());
    }
    let name = entity.get("name").or_else(|| entity.get("title"))
        .and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).ok_or_else(unsupported)?;
    let entries = entity.get("trackList").and_then(Value::as_array).ok_or_else(unsupported)?;
    let mut source = ImportSource {
        name: name.into(), tracks: Vec::new(), skipped: 0,
        warnings: vec!["Se lee la vista pública de Spotify, que puede mostrar solo parte de la playlist. Revisa las canciones antes de importar; las playlists privadas no se pueden leer mediante su enlace".into()],
    };
    if entries.len() >= EMBED_LIMIT {
        source.warnings.push(format!("Spotify ha mostrado {} entradas. Esta vista suele limitarse a las primeras 100; la playlist puede tener más canciones que no aparecen aquí", entries.len()));
    }
    for entry in entries {
        let uri = entry.get("uri").and_then(Value::as_str).unwrap_or("");
        let title = entry.get("title").and_then(Value::as_str).map(str::trim).unwrap_or("");
        let artists: Vec<String> = entry.get("subtitle").and_then(Value::as_str).unwrap_or("")
            // El embed separa artistas con coma + espacio no separable. Una coma
            // ordinaria puede ser parte del nombre (p. ej. «Tyler, The Creator»).
            .split(",\u{a0}").map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
        if !uri.strip_prefix("spotify:track:").is_some_and(valid_id) || title.is_empty() || artists.is_empty()
            || title.len() > 2000 || artists.len() > 100 || artists.iter().any(|artist| artist.len() > 1000)
            || entry.get("entityType").and_then(Value::as_str).is_some_and(|kind| kind != "track")
        {
            source.skipped += 1;
            continue;
        }
        source.tracks.push(ImportTrack {
            title: title.into(), artists,
            duration_ms: entry.get("duration").and_then(Value::as_u64).filter(|n| *n > 0),
            isrc: None,
        });
    }
    if source.skipped > 0 {
        source.warnings.push(format!("Se han omitido {} entradas sin datos suficientes, archivos locales o episodios de podcast", source.skipped));
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "3cEYpjA9oz9GiPac4AsH4n";

    fn page(entries: Vec<Value>) -> String {
        let data = json!({"props":{"pageProps":{"state":{"data":{"entity":{
            "type":"playlist", "id":ID, "name":"Mi lista & favoritos", "trackList": entries
        }}}}}});
        format!("<html><script src=\"other.js\"></script><script type='application/json' id = '__NEXT_DATA__'>{data}</script></html>")
    }

    fn track(title: &str, artist: &str) -> Value {
        json!({"uri":"spotify:track:4rzfv0JLZfVhOhbSQ8o5jZ", "title":title,
            "subtitle":artist, "duration":210_500, "entityType":"track"})
    }

    #[test]
    fn accepts_shared_playlist_links_and_uris() {
        for input in [format!(" https://open.spotify.com/playlist/{ID}?si=test "),
            format!("https://open.spotify.com/intl-es/playlist/{ID}"),
            format!("https://open.spotify.com/embed/playlist/{ID}/"),
            format!("spotify:playlist:{ID}"), format!("spotify:user:someone:playlist:{ID}")]
        {
            assert_eq!(playlist_id(&input).unwrap(), ID);
        }
    }

    #[test]
    fn rejects_foreign_hosts_credentials_and_non_playlist_links() {
        for input in [format!("https://open.spotify.com.evil.test/playlist/{ID}"),
            format!("https://evil.test/playlist/{ID}"), format!("https://someone@open.spotify.com/playlist/{ID}"),
            format!("https://open.spotify.com:444/playlist/{ID}"), format!("https://open.spotify.com/track/{ID}"),
            "file:///playlist/test".into(), "spotify:playlist:../../etc/passwd".into(), ID.into()]
        {
            assert!(playlist_id(&input).is_err(), "{input}");
        }
        assert!(playlist_id("https://spotify.link/short").unwrap_err().contains("enlace corto"));
    }

    #[test]
    fn preserves_order_duplicates_and_artist_names() {
        let html = page(vec![track("First", "Tyler, The Creator,\u{a0}Kali Uchis"),
            track("Second & third", "Björk"), track("First", "Tyler, The Creator,\u{a0}Kali Uchis")]);
        let parsed = parse_playlist(&html, ID).unwrap();
        assert_eq!(parsed.name, "Mi lista & favoritos");
        assert_eq!(parsed.tracks.len(), 3);
        assert_eq!(parsed.tracks[0].artists, ["Tyler, The Creator", "Kali Uchis"]);
        assert_eq!(parsed.tracks[1].title, "Second & third");
        assert_eq!(parsed.tracks[2].title, "First");
        assert_eq!(parsed.tracks[0].duration_ms, Some(210_500));
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.warnings.len(), 1);
    }

    #[test]
    fn reports_invalid_entries_and_possible_truncation() {
        let mut entries = vec![track("Song", "Artist"); 98];
        entries.push(json!({"uri":"spotify:episode:4rzfv0JLZfVhOhbSQ8o5jZ", "title":"Episode", "subtitle":"Host"}));
        entries.push(track("", "Artist"));
        let parsed = parse_playlist(&page(entries), ID).unwrap();
        assert_eq!(parsed.tracks.len(), 98);
        assert_eq!(parsed.skipped, 2);
        assert!(parsed.warnings.iter().any(|v| v.contains("100")));
        assert!(parsed.warnings.iter().any(|v| v.contains("omitido 2")));
    }

    #[test]
    fn fails_closed_on_unavailable_changed_or_wrong_playlist() {
        assert!(parse_playlist("<html>Login</html>", ID).is_err());
        assert!(parse_playlist("<script id=\"__NEXT_DATA__\">{}</script>", ID).is_err());
        assert!(parse_playlist(&page(vec![]), "37i9dQZF1DXcBWIGoYBM5M").is_err());
        assert_eq!(parse_playlist(&page(vec![]), ID).unwrap().tracks.len(), 0);
    }

    #[tokio::test]
    #[ignore = "Consulta real a Spotify; depende de Internet y de la vista pública"]
    async fn public_playlist_smoke_test() {
        let result = read_playlist(&format!("https://open.spotify.com/playlist/{ID}")).await.unwrap();
        assert!(!result.name.is_empty());
        assert!(!result.tracks.is_empty());
        assert!(!result.warnings.is_empty());
    }
}
