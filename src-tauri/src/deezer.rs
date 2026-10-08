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
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    /// Coincidencias en la música local del usuario.
    pub local_artists: Vec<Artist>,
    pub local_albums: Vec<Album>,
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
            .user_agent(concat!("Pletina/", env!("CARGO_PKG_VERSION")))
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
            local_artists: vec![],
            local_albums: vec![],
        })
    }

    /// Busca una grabación equivalente para una importación. Una ausencia devuelve
    /// `None`; los fallos de conexión o cuota se propagan para no tratarlos como ausencias.
    pub async fn match_import_track(
        &self,
        title: &str,
        artists: &[String],
        duration_ms: Option<u64>,
        isrc: Option<&str>,
    ) -> Result<Option<crate::library::LibTrack>, String> {
        let Some(artist) = artists.first().filter(|a| !normalize_match(a).is_empty()) else {
            return Ok(None);
        };
        if normalize_title(title).is_empty() {
            return Ok(None);
        }
        if let Some(code) = isrc.and_then(normalize_isrc) {
            let url = format!("{API}/track/isrc:{code}");
            if let Some(track) = self.get_import::<TopTrack>(&url, true).await? {
                if import_isrc_matches(&track, &code, title, artist, duration_ms) {
                    return Ok(Some(import_lib_track(track)));
                }
            }
        }

        // El endpoint puede devolver cero resultados con filtros track:/artist:
        // aunque la búsqueda libre encuentre la grabación. Se buscan candidatos
        // por texto y se validan abajo: artista, título, versión y duración.
        let query = format!("{} {}", normalize_match(artist), normalize_title(title));
        let url = format!("{API}/search/track?q={}&limit=25", urlencode(&query));
        let page = self.get_import::<Page<TopTrack>>(&url, false).await?
            .ok_or_else(|| "Respuesta inesperada de Deezer".to_string())?;
        Ok(select_import_track(page.data, title, artist, duration_ms).map(import_lib_track))
    }

    async fn get_import<T: DeserializeOwned>(&self, url: &str, allow_missing: bool) -> Result<Option<T>, String> {
        let response = self.http.get(url).send().await
            .map_err(|e| format!("No se pudo conectar con Deezer: {e}"))?;
        let status = response.status();
        if allow_missing && status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(format!("Deezer: error HTTP {}", status.as_u16()));
        }
        let bytes = response.bytes().await.map_err(|e| format!("No se pudo leer Deezer: {e}"))?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Respuesta inesperada de Deezer: {e}"))?;
        decode_import_response(value, allow_missing)
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

fn decode_import_response<T: DeserializeOwned>(value: Value, allow_missing: bool) -> Result<Option<T>, String> {
    if let Some(error) = value.get("error") {
        // DATA_NOT_FOUND (800) es lo único que significa que no hay grabación.
        // QUERY_QUOTA (4), permisos y errores internos no se deben ocultar.
        if allow_missing && error.get("code").and_then(Value::as_u64) == Some(800) {
            return Ok(None);
        }
        let message = error.get("message").and_then(Value::as_str).unwrap_or("error desconocido");
        return Err(format!("Deezer: {message}"));
    }
    serde_json::from_value(value).map(Some)
        .map_err(|e| format!("Respuesta inesperada de Deezer: {e}"))
}

fn import_lib_track(value: TopTrack) -> crate::library::LibTrack {
    let TopTrack { track, album } = value;
    crate::library::LibTrack {
        id: track.id,
        title: track.title,
        duration: track.duration,
        explicit: track.explicit_lyrics,
        artist_id: track.artist.id,
        artist_name: track.artist.name,
        album_id: album.id,
        album_title: album.title,
        album_artist_id: track.artist.id,
        cover: album.cover_big.or(album.cover_medium),
    }
}

fn select_import_track(tracks: Vec<TopTrack>, title: &str, artist: &str, duration_ms: Option<u64>) -> Option<TopTrack> {
    tracks.into_iter()
        .filter_map(|track| import_match_score(&track, title, artist, duration_ms).map(|score| (score, track)))
        .min_by_key(|(score, track)| (*score, track.track.id))
        .map(|(_, track)| track)
}

fn import_isrc_matches(track: &TopTrack, code: &str, title: &str, artist: &str, duration_ms: Option<u64>) -> bool {
    track.track.isrc.as_deref().and_then(normalize_isrc).as_deref() == Some(code)
        && import_match_score(track, title, artist, duration_ms).is_some()
}

/// Menor distancia de duración gana, una vez comprobados título y artista.
fn import_match_score(track: &TopTrack, title: &str, artist: &str, duration_ms: Option<u64>) -> Option<u64> {
    if track.track.id == 0 || track.album.id == 0 || track.track.duration == 0
        || normalize_match(&track.track.artist.name) != normalize_match(artist)
    {
        return None;
    }
    let mut candidate_title = normalize_title(&track.track.title);
    if let Some(version) = &track.track.title_version {
        let version = normalize_title(version);
        if !version.is_empty() && !candidate_title.ends_with(&format!(" {version}")) && candidate_title != version {
            candidate_title.push(' ');
            candidate_title.push_str(&version);
        }
    }
    if candidate_title != normalize_title(title) {
        return None;
    }
    match duration_ms.filter(|duration| *duration > 0) {
        Some(duration) => {
            let distance = (u64::from(track.track.duration) * 1000).abs_diff(duration);
            // Redondeo de Deezer y pequeños silencios de las ediciones: 2,5–6 s.
            let tolerance = (duration / 50).clamp(2500, 6000);
            (distance <= tolerance).then_some(distance)
        }
        None => Some(0),
    }
}

fn normalize_isrc(value: &str) -> Option<String> {
    let code: String = value.chars().filter(|c| *c != '-' && !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    let bytes = code.as_bytes();
    (bytes.len() == 12 && bytes[..2].iter().all(u8::is_ascii_alphabetic)
        && bytes[2..5].iter().all(u8::is_ascii_alphanumeric)
        && bytes[5..].iter().all(u8::is_ascii_digit)).then_some(code)
}

fn normalize_match(value: &str) -> String {
    let mut normalized = String::new();
    for character in value.chars().flat_map(char::to_lowercase) {
        let character = match character {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            'ý' | 'ÿ' => 'y',
            // Las marcas combinantes equivalen a la vocal ya normalizada.
            '\u{0300}'..='\u{036f}' => continue,
            _ => character,
        };
        if character == '&' {
            normalized.push_str(" and ");
        } else if character.is_alphanumeric() {
            normalized.push(character);
        } else {
            normalized.push(' ');
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn ignorable_title_suffix(value: &str) -> bool {
    let normalized = normalize_match(value);
    let words: Vec<_> = normalized.split_whitespace().collect();
    if matches!(words.first(), Some(&"feat" | &"ft" | &"featuring")) && !has_version_words(&normalized) {
        return true;
    }
    words.iter().any(|word| matches!(*word, "remaster" | "remastered"))
        && words.iter().all(|word| matches!(*word, "remaster" | "remastered" | "version") || word.chars().all(|c| c.is_ascii_digit()))
}

fn has_version_words(value: &str) -> bool {
    normalize_match(value).split_whitespace().any(|word| matches!(word,
        "live" | "remix" | "mix" | "edit" | "acoustic" | "instrumental" | "karaoke"
        | "cover" | "demo" | "version" | "session" | "sessions" | "sped" | "slowed"))
}

/// Conserva la información de versiones (live, remix, acústico, cover…), salvo
/// créditos de colaboración y remasterización, que los catálogos rotulan distinto.
fn normalize_title(value: &str) -> String {
    if ignorable_title_suffix(value) {
        return String::new();
    }
    let mut title = String::new();
    let mut rest = value;
    while let Some(start) = rest.find(['(', '[']) {
        title.push_str(&rest[..start]);
        let closing = if rest.as_bytes()[start] == b'(' { ')' } else { ']' };
        let group = &rest[start + 1..];
        let Some(end) = group.find(closing) else {
            title.push_str(&rest[start..]);
            rest = "";
            break;
        };
        if !ignorable_title_suffix(&group[..end]) {
            title.push(' ');
            title.push_str(&group[..end]);
            title.push(' ');
        }
        rest = &group[end + 1..];
    }
    title.push_str(rest);
    if let Some((base, suffix)) = title.rsplit_once(" - ") {
        if ignorable_title_suffix(suffix) {
            title = base.to_string();
        }
    }
    let normalized = normalize_match(&title);
    for marker in [" feat ", " ft ", " featuring "] {
        if let Some(index) = normalized.find(marker) {
            if has_version_words(&normalized[index + marker.len()..]) {
                break;
            }
            return normalized[..index].to_string();
        }
    }
    normalized
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
mod import_tests {
    use super::*;

    fn candidate(id: u64, title: &str, artist: &str, duration: u32) -> TopTrack {
        TopTrack {
            track: Track {
                id,
                title: title.into(),
                title_version: None,
                duration,
                track_position: 1,
                disk_number: 1,
                explicit_lyrics: false,
                isrc: None,
                artist: ArtistRef { id: 7, name: artist.into(), picture_medium: None },
            },
            album: AlbumRef {
                id: 12, title: "Album".into(), cover_medium: None, cover_big: Some("cover.jpg".into()),
            },
        }
    }

    #[test]
    fn selects_valid_artist_and_closest_duration_instead_of_first_result() {
        let tracks = vec![
            candidate(1, "Song", "Cover Band", 200),
            candidate(2, "Song", "Artist", 205),
            candidate(3, "Song", "Artist", 203),
            candidate(4, "Song", "Artist", 200),
        ];
        assert_eq!(select_import_track(tracks, "Song", "Artist", Some(200_500)).unwrap().track.id, 4);
        assert!(select_import_track(vec![candidate(1, "Song", "Artist Jr.", 200)], "Song", "Artist", None).is_none());
        assert!(select_import_track(vec![candidate(1, "Song", "Artist", 214)], "Song", "Artist", Some(200_000)).is_none());
    }

    #[test]
    fn keeps_live_remix_and_cover_versions_distinct() {
        for version in ["Live", "Acoustic", "Cover", "Remix", "Someone Remix", "Instrumental", "Radio Edit"] {
            let mut track = candidate(1, "Song", "Artist", 200);
            track.track.title_version = Some(format!("({version})"));
            assert!(import_match_score(&track, "Song", "Artist", None).is_none(), "{version}");
            assert!(import_match_score(&track, &format!("Song - {version}"), "Artist", None).is_some(), "{version}");
        }
        assert!(import_match_score(&candidate(1, "Song (Alice Remix)", "Artist", 200), "Song (Bob Remix)", "Artist", None).is_none());
        assert!(import_match_score(&candidate(1, "Song (Live)", "Artist", 200), "Song", "Artist", None).is_none());
        assert!(import_match_score(&candidate(1, "Song", "Artist", 200), "Song feat. Guest - Live", "Artist", None).is_none());
        assert!(import_match_score(&candidate(1, "Song", "Artist", 200), "Song (feat. Guest - Remix)", "Artist", None).is_none());
    }

    #[test]
    fn normalizes_spelling_features_and_remasters_without_dropping_versions() {
        let mut track = candidate(1, "Deja Vu", "Beyonce", 200);
        track.track.title_version = Some("(2011 Remaster)".into());
        assert!(import_match_score(&track, "Déjà-Vu (feat. Guest) - 2020 Remaster", "Beyoncé", Some(200_123)).is_some());
        track.track.title = "Song (Live)".into();
        track.track.title_version = Some("(Live)".into());
        assert!(import_match_score(&track, "Song - Live", "Beyonce", None).is_some());
        assert_eq!(normalize_title("Song feat. Guest"), "song");
        assert_eq!(normalize_match("Simon & Garfunkel"), normalize_match("Simon and Garfunkel"));
    }

    #[test]
    fn duration_tolerance_is_bounded_and_missing_duration_is_supported() {
        let track = candidate(1, "Song", "Artist", 60);
        assert!(import_match_score(&track, "Song", "Artist", Some(62_000)).is_some());
        assert!(import_match_score(&track, "Song", "Artist", Some(63_000)).is_none());
        let long = candidate(1, "Song", "Artist", 1000);
        assert!(import_match_score(&long, "Song", "Artist", Some(1_010_000)).is_none());
        assert!(import_match_score(&track, "Song", "Artist", None).is_some());
        assert!(import_match_score(&candidate(1, "Song", "Artist", 0), "Song", "Artist", None).is_none());
    }

    #[test]
    fn isrc_requires_matching_identifier_and_compatible_recording() {
        let code = "USABC2300123";
        assert_eq!(normalize_isrc("us-abc-23-00123").as_deref(), Some(code));
        assert!(normalize_isrc("USABC23/0123").is_none());
        let mut track = candidate(1, "Song", "Artist", 200);
        assert!(!import_isrc_matches(&track, code, "Song", "Artist", Some(200_000)));
        track.track.isrc = Some("USABC2300124".into());
        assert!(!import_isrc_matches(&track, code, "Song", "Artist", Some(200_000)));
        track.track.isrc = Some(code.into());
        assert!(import_isrc_matches(&track, code, "Song", "Artist", Some(200_000)));
        assert!(!import_isrc_matches(&track, code, "Song", "Other Artist", Some(200_000)));
        assert!(!import_isrc_matches(&track, code, "Song (Live)", "Artist", Some(200_000)));
        assert!(!import_isrc_matches(&track, code, "Song", "Artist", Some(220_000)));
    }

    #[test]
    fn missing_isrc_can_fall_back_but_api_failures_are_errors() {
        let missing = serde_json::json!({ "error": { "code": 800, "message": "no data" } });
        assert!(decode_import_response::<TopTrack>(missing.clone(), true).unwrap().is_none());
        assert!(decode_import_response::<TopTrack>(missing, false).is_err());
        let quota = serde_json::json!({ "error": { "code": 4, "message": "Quota limit exceeded" } });
        assert!(decode_import_response::<TopTrack>(quota, true).unwrap_err().contains("Quota"));
        assert!(decode_import_response::<TopTrack>(serde_json::json!({}), true).is_err());
    }

    #[test]
    fn copies_library_metadata_from_the_selected_recording() {
        let mut source = candidate(42, "Song", "Artist", 201);
        source.track.explicit_lyrics = true;
        let saved = import_lib_track(source);
        assert_eq!((saved.id, saved.album_id, saved.artist_id, saved.album_artist_id), (42, 12, 7, 7));
        assert_eq!(saved.duration, 201);
        assert!(saved.explicit);
        assert_eq!(saved.cover.as_deref(), Some("cover.jpg"));
    }

    /// Comprueba el contrato real sin que los tests habituales dependan de red/cuota.
    #[tokio::test]
    #[ignore]
    async fn real_import_track_search() {
        let deezer = Deezer::new();
        let track = deezer.match_import_track("No Surprises", &["Radiohead".into()], Some(229_000), None)
            .await.unwrap().expect("grabación de Radiohead");
        assert_eq!(normalize_match(&track.artist_name), "radiohead");
        assert_eq!(normalize_title(&track.title), "no surprises");
        let by_isrc = deezer.match_import_track("No Surprises", &["Radiohead".into()], Some(229_000), Some("GBAYE9700386"))
            .await.unwrap().expect("grabación por ISRC");
        assert_eq!(normalize_match(&by_isrc.artist_name), "radiohead");
        assert_eq!(normalize_title(&by_isrc.title), "no surprises");
    }

    #[tokio::test]
    #[ignore]
    async fn spotify_to_catalog_smoke_test() {
        let playlist = crate::spotify::read_playlist("https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n")
            .await.expect("playlist pública de ejemplo");
        let deezer = Deezer::new();
        let sample = playlist.tracks.iter().take(5);
        let total = sample.len();
        let mut found = 0;
        for source in sample {
            let matched = deezer.match_import_track(&source.title, &source.artists, source.duration_ms, source.isrc.as_deref())
                .await.expect("consulta Deezer sin fallos de red ni cuota");
            println!("{} — {}: {}", source.title, source.artists.join(", "), if matched.is_some() { "encontrada" } else { "sin coincidencia" });
            if matched.is_some() { found += 1; }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        println!("Spotify → catálogo: {found}/{total} encontradas");
        assert!(found > 0, "ninguna grabación compatible de la playlist de ejemplo");
    }
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
