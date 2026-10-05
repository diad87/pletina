//! Cliente mínimo de la API pública de Deezer (sin clave).
//! Solo se usa para el catálogo: artistas, discos, carátulas y listas de canciones.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const API: &str = "https://api.deezer.com";
/// Tope de páginas al seguir `next`, para no disparar la cuota (50 peticiones / 5 s).
const MAX_PAGES: usize = 10;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct ArtistRef {
    pub id: u64,
    #[serde(deserialize_with = "text")]
    pub name: String,
    /// Solo viene en algunos sitios (p. ej. la cabecera de un disco).
    #[serde(default)]
    pub picture_medium: Option<String>,
}

/// Disco al que pertenece una canción suelta (p. ej. en las más escuchadas de un artista).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct AlbumRef {
    pub id: u64,
    #[serde(deserialize_with = "text")]
    pub title: String,
    pub cover_medium: Option<String>,
    pub cover_big: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct TopTrack {
    #[serde(flatten)]
    pub track: Track,
    pub album: AlbumRef,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Artist {
    pub id: u64,
    #[serde(deserialize_with = "text")]
    pub name: String,
    pub picture_medium: Option<String>,
    pub picture_xl: Option<String>,
    #[serde(default)]
    pub nb_album: u32,
    #[serde(default)]
    pub nb_fan: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Album {
    pub id: u64,
    #[serde(deserialize_with = "text")]
    pub title: String,
    pub cover_medium: Option<String>,
    pub cover_xl: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub record_type: Option<String>,
    #[serde(default)]
    pub nb_tracks: u32,
    #[serde(default)]
    pub explicit_lyrics: bool,
    #[serde(default)]
    pub fans: u64,
    /// Viene en las búsquedas; en la discografía de un artista no.
    pub artist: Option<ArtistRef>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Track {
    pub id: u64,
    #[serde(deserialize_with = "text")]
    pub title: String,
    #[serde(default, deserialize_with = "opt_text")]
    pub title_version: Option<String>,
    /// Segundos. Clave para elegir el vídeo correcto en YouTube.
    pub duration: u32,
    #[serde(default)]
    pub track_position: u32,
    #[serde(default)]
    pub disk_number: u32,
    #[serde(default)]
    pub explicit_lyrics: bool,
    #[serde(default)]
    pub isrc: Option<String>,
    pub artist: ArtistRef,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumDetail {
    pub id: u64,
    pub title: String,
    pub cover_big: Option<String>,
    pub cover_xl: Option<String>,
    pub release_date: Option<String>,
    pub record_type: Option<String>,
    pub label: Option<String>,
    pub duration: u32,
    pub nb_tracks: u32,
    pub explicit_lyrics: bool,
    pub genres: Vec<String>,
    pub artist: ArtistRef,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Serialize)]
pub struct SearchResults {
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
}

#[derive(Debug, Serialize)]
pub struct ArtistPage {
    pub artist: Artist,
    pub albums: Vec<Album>,
    /// Las canciones más escuchadas del artista.
    pub top: Vec<TopTrack>,
}

#[derive(Deserialize)]
struct Page<T> {
    data: Vec<T>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct RawAlbumDetail {
    id: u64,
    #[serde(deserialize_with = "text")]
    title: String,
    cover_big: Option<String>,
    cover_xl: Option<String>,
    release_date: Option<String>,
    record_type: Option<String>,
    #[serde(default, deserialize_with = "opt_text")]
    label: Option<String>,
    #[serde(default)]
    duration: u32,
    #[serde(default)]
    nb_tracks: u32,
    #[serde(default)]
    explicit_lyrics: bool,
    genres: Option<Page<Genre>>,
    artist: ArtistRef,
}

#[derive(Deserialize)]
struct Genre {
    #[serde(deserialize_with = "text")]
    name: String,
}

pub struct Deezer {
    http: reqwest::Client,
}

impl Deezer {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("Musify/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("cliente HTTP");
        Self { http }
    }

    /// GET a una URL de la API. Deezer devuelve los errores con HTTP 200 y un objeto `error`.
    async fn get<T: DeserializeOwned>(&self, url: &str) -> Result<T, String> {
        let res = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("No se pudo conectar con Deezer: {e}"))?;
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if let Some(err) = value.get("error") {
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("error desconocido");
            return Err(format!("Deezer: {msg}"));
        }
        serde_json::from_value(value).map_err(|e| format!("Respuesta inesperada de Deezer: {e}"))
    }

    /// Recorre todas las páginas de un listado siguiendo `next`.
    async fn get_all<T: DeserializeOwned>(&self, url: &str) -> Result<Vec<T>, String> {
        let mut out = Vec::new();
        let mut next = Some(url.to_string());
        for _ in 0..MAX_PAGES {
            let Some(url) = next.take() else { break };
            let page: Page<T> = self.get(&url).await?;
            out.extend(page.data);
            next = page.next;
        }
        Ok(out)
    }

    pub async fn search(&self, query: &str) -> Result<SearchResults, String> {
        let q = urlencode(query);
        let artists_url = format!("{API}/search/artist?q={q}&limit=8");
        let albums_url = format!("{API}/search/album?q={q}&limit=30");
        let (artists, albums) = tokio::join!(
            self.get::<Page<Artist>>(&artists_url),
            self.get::<Page<Album>>(&albums_url),
        );
        Ok(SearchResults {
            artists: artists?.data,
            albums: albums?.data,
        })
    }

    pub async fn artist(&self, id: u64) -> Result<ArtistPage, String> {
        let artist_url = format!("{API}/artist/{id}");
        let albums_url = format!("{API}/artist/{id}/albums?limit=100");
        let top_url = format!("{API}/artist/{id}/top?limit=10");
        let (artist, albums, top) = tokio::join!(
            self.get::<Artist>(&artist_url),
            self.get_all::<Album>(&albums_url),
            self.get::<Page<TopTrack>>(&top_url),
        );
        let mut albums = dedupe_albums(albums?);
        // Lo más reciente primero, como en Spotify.
        albums.sort_by(|a, b| b.release_date.cmp(&a.release_date));
        // Si fallan las más escuchadas, la página se muestra igual.
        Ok(ArtistPage { artist: artist?, albums, top: top.map(|p| p.data).unwrap_or_default() })
    }

    pub async fn album(&self, id: u64) -> Result<AlbumDetail, String> {
        let album_url = format!("{API}/album/{id}");
        let tracks_url = format!("{API}/album/{id}/tracks?limit=200");
        let (raw, tracks) = tokio::join!(
            self.get::<RawAlbumDetail>(&album_url),
            self.get_all::<Track>(&tracks_url),
        );
        let raw = raw?;
        let mut tracks = tracks?;
        tracks.sort_by_key(|t| (t.disk_number, t.track_position));
        Ok(AlbumDetail {
            id: raw.id,
            title: raw.title,
            cover_big: raw.cover_big,
            cover_xl: raw.cover_xl,
            release_date: raw.release_date,
            record_type: raw.record_type,
            label: raw.label,
            duration: raw.duration,
            nb_tracks: raw.nb_tracks,
            explicit_lyrics: raw.explicit_lyrics,
            genres: raw.genres.map(|g| g.data.into_iter().map(|g| g.name).collect()).unwrap_or_default(),
            artist: raw.artist,
            tracks,
        })
    }
}

/// Deezer suele tener el mismo disco repetido (ediciones, versión explícita/limpia).
/// Se queda con el que más fans tiene de cada título + tipo.
fn dedupe_albums(albums: Vec<Album>) -> Vec<Album> {
    let mut best: HashMap<(String, String), Album> = HashMap::new();
    for album in albums {
        let key = (
            album.title.trim().to_lowercase(),
            album.record_type.clone().unwrap_or_default(),
        );
        match best.get(&key) {
            Some(current) if current.fans >= album.fans => {}
            _ => {
                best.insert(key, album);
            }
        }
    }
    best.into_values().collect()
}

/// Deezer devuelve algunos textos con entidades HTML ("Will Taylor &amp; Strings Attached").
fn unescape(s: String) -> String {
    if !s.contains('&') {
        return s;
    }
    // `&amp;` el último, para no decodificar dos veces "&amp;lt;".
    s.replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    String::deserialize(d).map(unescape)
}

fn opt_text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d).map(|s| s.map(unescape))
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod fixtures {
    use super::*;

    /// Guarda respuestas reales en `src/dev/fixtures` para la vista previa en el navegador:
    /// `cargo test write_fixtures -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn write_fixtures() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/dev/fixtures");
        std::fs::create_dir_all(&dir).unwrap();
        let save = |name: &str, value: &dyn erased::Json| std::fs::write(dir.join(name), value.json()).unwrap();
        let d = Deezer::new();
        save("search.json", &d.search("radiohead").await.unwrap());
        save("artist.json", &d.artist(399).await.unwrap());
        for (name, query) in [("album-1.json", "radiohead ok computer"), ("album-2.json", "berri txarrak infrasoinuak"), ("album-3.json", "rosalia motomami"), ("album-4.json", "the beatles abbey road")] {
            let found = d.search(query).await.unwrap();
            save(name, &d.album(found.albums[0].id).await.unwrap());
        }
    }

    mod erased {
        pub trait Json {
            fn json(&self) -> String;
        }
        impl<T: serde::Serialize> Json for T {
            fn json(&self) -> String {
                serde_json::to_string_pretty(self).unwrap()
            }
        }
    }
}
