//! Descubrimiento de podcasts con iTunes y reproducción de los audios de su RSS.
//! El país del catálogo solo ayuda a ordenar: el idioma se comprueba en cada feed.

use crate::db::Db;
use encoding_rs::Encoding;
use reqwest::{Client, Url};
use roxmltree::{Document, Node};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

const PODCAST_BASE: u64 = 500_000_000_000_000;
const EPISODE_BASE: u64 = 750_000_000_000_000;
const PODCAST_END: u64 = 1_000_000_000_000_000;
// Algunos programas incluyen años de episodios en un único RSS (hasta ~17 MiB).
const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;
const MAX_EPISODES: usize = 300;
const MAX_PARALLEL_FEEDS: usize = 6;
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const ITUNES_NS: &str = "http://www.itunes.com/dtds/podcast-1.0.dtd";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Podcast {
    pub id: u64,
    pub title: String,
    pub author: String,
    pub description: String,
    pub image: Option<String>,
    pub feed_url: String,
    pub language: Option<String>,
    pub episode_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastEpisode {
    pub id: u64,
    pub title: String,
    pub description: String,
    pub published_at: Option<String>,
    pub duration: u32,
    pub audio_url: String,
    pub image: Option<String>,
    pub explicit: bool,
    #[serde(skip)]
    guid: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastDetail {
    pub podcast: Podcast,
    pub episodes: Vec<PodcastEpisode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastSearchResults {
    pub podcasts: Vec<Podcast>,
    /// Feeds que no pudieron comprobarse. La interfaz puede avisar de resultados parciales.
    pub failed_feeds: usize,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    feed_url: Option<String>,
    /// Portada de 600 px: la del RSS puede ser de 3000 px, demasiado para una cuadrícula en el móvil.
    artwork_url600: Option<String>,
}

#[derive(Deserialize)]
struct DirectoryResponse {
    results: Vec<DirectoryEntry>,
}

type Cache<T> = Arc<Mutex<HashMap<String, (Instant, T)>>>;

#[derive(Clone)]
pub struct Podcasts {
    http: Client,
    feeds: Cache<PodcastDetail>,
    searches: Cache<Vec<DirectoryEntry>>,
    permits: Arc<Semaphore>,
    search_generation: Arc<AtomicU64>,
}

impl Podcasts {
    pub fn new() -> Self {
        Self {
            http: Client::builder()
                .user_agent(concat!("Pletina/", env!("CARGO_PKG_VERSION"), " (podcast RSS reader)"))
                .timeout(Duration::from_secs(9))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()
                .expect("cliente HTTP de podcasts"),
            feeds: Arc::new(Mutex::new(HashMap::new())),
            searches: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(MAX_PARALLEL_FEEDS)),
            search_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    async fn directory(&self, query: &str) -> Result<Vec<DirectoryEntry>, String> {
        let query = query.trim();
        let query = if query.is_empty() { "podcast" } else { query };
        if query.chars().count() > 250 {
            return Err("La búsqueda de podcasts es demasiado larga".into());
        }
        // La tienda es fija: cambiar el idioma filtra el mismo catálogo, de modo que
        // «Todos» siempre incluye lo encontrado en un idioma concreto.
        let key = query.to_string();
        if let Some(cached) = cached(&self.searches, &key) {
            return Ok(cached);
        }
        let response = self.http.get("https://itunes.apple.com/search")
            .query(&[("term", query), ("media", "podcast"), ("entity", "podcast"), ("country", "ES"), ("limit", "30")])
            .send().await.map_err(|e| format!("No se pudo buscar podcasts: {e}"))?;
        let bytes = limited_body(response, 1024 * 1024).await?;
        let result: DirectoryResponse = serde_json::from_slice(&bytes)
            .map_err(|_| "El catálogo de podcasts devolvió una respuesta no válida".to_string())?;
        put_cached(&self.searches, key, result.results.clone(), 24);
        Ok(result.results)
    }

    async fn feed(&self, feed_url: &str) -> Result<PodcastDetail, String> {
        let url = web_url(feed_url).ok_or("La dirección del podcast debe usar HTTP o HTTPS")?;
        if let Some(cached) = cached(&self.feeds, url.as_str()) {
            return Ok(cached);
        }
        let _permit = self.permits.acquire().await.map_err(|_| "La búsqueda se ha cerrado")?;
        // Una búsqueda anterior pudo haberlo guardado mientras esperábamos turno.
        if let Some(cached) = cached(&self.feeds, url.as_str()) {
            return Ok(cached);
        }
        let response = self.http.get(url.clone()).send().await
            .map_err(|e| format!("No se pudo cargar el RSS del podcast: {e}"))?;
        let content_base = response.url().to_string();
        let bytes = limited_body(response, MAX_FEED_BYTES).await?;
        let xml = decode_xml(&bytes)?;
        let mut detail = parse_feed(&xml, &content_base)?;
        // La dirección original identifica el programa aunque el alojamiento redirija el RSS.
        detail.podcast.feed_url = url.to_string();
        put_cached(&self.feeds, url.to_string(), detail.clone(), 32);
        Ok(detail)
    }

    async fn search(&self, query: &str, language: &str, db: &Db) -> Result<PodcastSearchResults, String> {
        let generation = self.search_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let language = filter_language(language)?;
        let entries = self.directory(query).await?;
        self.check_generation(generation)?;
        let mut seen = HashSet::new();
        let (urls, artworks): (Vec<_>, Vec<_>) = entries.into_iter()
            .filter_map(|e| Some((web_url(e.feed_url.as_deref()?)?.to_string(), e.artwork_url600)))
            .filter(|(u, _)| seen.insert(u.clone())).take(30).unzip();
        let total = urls.len();
        let mut pending = urls.into_iter().enumerate();
        let mut tasks = JoinSet::new();
        for (index, url) in pending.by_ref().take(MAX_PARALLEL_FEEDS) {
            let client = self.clone();
            tasks.spawn(async move { (index, client.feed(&url).await) });
        }
        let mut found = Vec::new();
        let mut failed_feeds = 0;
        let mut last_error = String::new();
        while let Some(joined) = tasks.join_next().await {
            // Al cambiar la consulta o el idioma dejamos de pedir feeds de la anterior.
            // Al salir se destruye JoinSet y se cancelan también sus peticiones pendientes.
            self.check_generation(generation)?;
            match joined {
                Ok((index, Ok(detail))) => {
                    if matches_language(detail.podcast.language.as_deref(), language.as_deref()) {
                        let mut podcast = detail.podcast;
                        save_show(db, &mut podcast)?;
                        // En la lista, la portada pequeña del catálogo; el programa guarda la del RSS.
                        if let Some(small) = artworks[index].clone().filter(|u| u.starts_with("https://")) {
                            podcast.image = Some(small);
                        }
                        found.push((index, podcast));
                    }
                }
                Ok((_, Err(error))) => { failed_feeds += 1; last_error = error; }
                Err(_) => { failed_feeds += 1; last_error = "No se pudo leer el podcast".into(); }
            }
            if let Some((index, url)) = pending.next() {
                let client = self.clone();
                tasks.spawn(async move { (index, client.feed(&url).await) });
            }
        }
        if total > 0 && failed_feeds == total {
            return Err(format!("Se encontró el catálogo, pero no se pudo leer ningún podcast. {last_error}"));
        }
        found.sort_by_key(|(index, _)| *index);
        Ok(PodcastSearchResults { podcasts: found.into_iter().map(|(_, p)| p).collect(), failed_feeds })
    }

    fn check_generation(&self, generation: u64) -> Result<(), String> {
        if self.search_generation.load(Ordering::Relaxed) != generation {
            Err("La búsqueda fue sustituida por una consulta nueva".into())
        } else { Ok(()) }
    }
}

fn cached<T: Clone>(cache: &Cache<T>, key: &str) -> Option<T> {
    cache.lock().unwrap().get(key).filter(|(time, _)| time.elapsed() < CACHE_TTL).map(|(_, value)| value.clone())
}

fn put_cached<T>(cache: &Cache<T>, key: String, value: T, limit: usize) {
    let mut cache = cache.lock().unwrap();
    cache.retain(|_, (time, _)| time.elapsed() < CACHE_TTL);
    if cache.len() >= limit {
        if let Some(oldest) = cache.iter().min_by_key(|(_, (time, _))| *time).map(|(key, _)| key.clone()) {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, (Instant::now(), value));
}

async fn limited_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(if status.as_u16() == 429 { "El servicio de podcasts está recibiendo demasiadas consultas. Prueba dentro de un minuto".into() }
            else { format!("El servicio de podcasts respondió con HTTP {status}") });
    }
    if response.content_length().is_some_and(|len| len > limit as u64) {
        return Err("El RSS del podcast supera el tamaño admitido".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("No se pudo terminar de leer el podcast: {e}"))? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("El RSS del podcast supera el tamaño admitido".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn decode_xml(bytes: &[u8]) -> Result<String, String> {
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]);
    let declared = prefix.strip_prefix("<?xml").and_then(|p| p.split("?>").next())
        .and_then(|p| p.split_once("encoding"))
        .and_then(|(_, tail)| tail.trim_start().strip_prefix('='))
        .and_then(|tail| {
            let tail = tail.trim_start();
            let quote = tail.chars().next()?;
            if quote != '\'' && quote != '"' { return None; }
            let label = tail[1..].split(quote).next()?;
            Encoding::for_label(label.as_bytes())
        });
    let encoding = Encoding::for_bom(bytes).map(|(encoding, _)| encoding).or(declared).unwrap_or(encoding_rs::UTF_8);
    let (text, _, errors) = encoding.decode(bytes);
    if errors { return Err("La codificación del RSS del podcast no es válida".into()); }
    Ok(text.into_owned())
}

fn web_url(value: &str) -> Option<Url> {
    let url = Url::parse(value.trim()).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.username().is_empty() && url.password().is_none()).then_some(url)
}

fn relative_web_url(base: &str, value: &str) -> Option<String> {
    let url = Url::parse(base).ok()?.join(value.trim()).ok()?;
    web_url(url.as_str()).map(|url| url.to_string())
}

fn normalize_language(value: &str) -> Option<String> {
    let primary = value.trim().split(['-', '_']).next()?.to_ascii_lowercase();
    if (primary.len() == 2 || primary.len() == 3) && primary.bytes().all(|b| b.is_ascii_alphabetic()) {
        // ISO 639-2 aliases found in older RSS publishers.
        Some(match primary.as_str() {
            "spa" => "es", "eng" => "en", "cat" => "ca", "eus" | "baq" => "eu", "glg" => "gl",
            "fra" | "fre" => "fr", "por" => "pt", "deu" | "ger" => "de", "ita" => "it",
            "und" | "mul" | "zxx" => return None,
            _ => &primary,
        }.to_string())
    } else { None }
}

fn filter_language(value: &str) -> Result<Option<String>, String> {
    if value.trim().is_empty() || value.trim().eq_ignore_ascii_case("all") { return Ok(None); }
    normalize_language(value).map(Some).ok_or_else(|| "El filtro de idioma no es válido".into())
}

fn matches_language(actual: Option<&str>, requested: Option<&str>) -> bool {
    requested.is_none() || actual.zip(requested).is_some_and(|(a, r)| a == r)
}

fn child<'a, 'input>(parent: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    parent.children().find(|n| n.is_element() && n.tag_name().name() == name && n.tag_name().namespace().is_none())
}

fn itunes<'a, 'input>(parent: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    parent.children().find(|n| n.has_tag_name((ITUNES_NS, name)))
}

fn text(node: Node<'_, '_>) -> String {
    node.descendants().filter(|n| n.is_text()).filter_map(|n| n.text()).collect::<String>().trim().to_string()
}

fn child_text(parent: Node<'_, '_>, name: &str) -> Option<String> {
    child(parent, name).map(text).filter(|s| !s.is_empty())
}

fn description(parent: Node<'_, '_>) -> String {
    let source = child(parent, "description").or_else(|| itunes(parent, "summary"))
        .or_else(|| parent.children().find(|n| n.has_tag_name(("http://purl.org/rss/1.0/modules/content/", "encoded"))));
    source.map(|n| plain_text(&text(n))).unwrap_or_default()
}

/// Las descripciones se muestran como texto, nunca como HTML de un tercero.
fn plain_text(value: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for c in value.chars().take(32_000) {
        match c {
            '<' => { in_tag = true; result.push(' '); }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => (),
        }
    }
    let result = result.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&amp;", "&");
    result.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(4_000).collect()
}

fn artwork(parent: Node<'_, '_>, base: &str) -> Option<String> {
    itunes(parent, "image").and_then(|n| n.attribute("href")).and_then(|url| relative_web_url(base, url))
        .or_else(|| child(parent, "image").and_then(|n| child_text(n, "url")).and_then(|url| relative_web_url(base, &url)))
}

fn duration(value: &str) -> u32 {
    let parts: Vec<_> = value.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 { return 0; }
    let mut total = 0u32;
    for (index, part) in parts.iter().enumerate() {
        let Ok(value) = part.parse::<u32>() else { return 0; };
        if index > 0 && value >= 60 { return 0; }
        let Some(next) = total.checked_mul(60).and_then(|n| n.checked_add(value)) else { return 0; };
        total = next;
    }
    total
}

fn audio_enclosure(item: Node<'_, '_>, base: &str) -> Option<String> {
    item.children().filter(|n| n.has_tag_name("enclosure")).find_map(|n| {
        let url = relative_web_url(base, n.attribute("url")?)?;
        let media_type = n.attribute("type").unwrap_or("").split(';').next()?.trim().to_ascii_lowercase();
        let extension = Url::parse(&url).ok()?.path().rsplit('.').next()?.to_ascii_lowercase();
        let known_extension = matches!(extension.as_str(), "mp3" | "m4a" | "aac" | "ogg" | "oga" | "opus" | "wav" | "flac");
        (media_type.starts_with("audio/") || media_type == "application/ogg"
            || ((media_type.is_empty() || media_type == "application/octet-stream") && known_extension)).then_some(url)
    })
}

fn parse_feed(xml: &str, feed_url: &str) -> Result<PodcastDetail, String> {
    let doc = Document::parse_with_options(xml, roxmltree::ParsingOptions { nodes_limit: 150_000, ..Default::default() })
        .map_err(|e| format!("El RSS del podcast no es válido: {e}"))?;
    let root = doc.root_element();
    if !root.has_tag_name("rss") { return Err("El podcast no contiene un feed RSS compatible".into()); }
    let channel = child(root, "channel").ok_or("El RSS del podcast no contiene un canal")?;
    let title = child_text(channel, "title").ok_or("El RSS del podcast no tiene título")?;
    let language = child_text(channel, "language").and_then(|s| normalize_language(&s));
    let author = itunes(channel, "author").map(text).filter(|s| !s.is_empty())
        .or_else(|| child_text(channel, "managingEditor")).unwrap_or_else(|| title.clone());
    let image = artwork(channel, feed_url);
    let show_explicit = itunes(channel, "explicit").map(text).is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "yes" | "true" | "1"));
    let mut seen = HashSet::new();
    let mut episodes = Vec::new();
    for item in channel.children().filter(|n| n.has_tag_name("item")) {
        let Some(audio_url) = audio_enclosure(item, feed_url) else { continue; };
        let Some(title) = child_text(item, "title") else { continue; };
        let guid = child_text(item, "guid").unwrap_or_else(|| audio_url.clone());
        if !seen.insert(guid.clone()) { continue; }
        episodes.push(PodcastEpisode {
            id: 0, title, description: description(item), guid,
            published_at: child_text(item, "pubDate"),
            duration: itunes(item, "duration").map(text).map(|s| duration(&s)).unwrap_or(0),
            audio_url,
            image: artwork(item, feed_url).or_else(|| image.clone()),
            explicit: itunes(item, "explicit").map(text).map(|s| matches!(s.to_ascii_lowercase().as_str(), "yes" | "true" | "1")).unwrap_or(show_explicit),
        });
        if episodes.len() >= MAX_EPISODES { break; }
    }
    Ok(PodcastDetail {
        podcast: Podcast { id: 0, title, author, description: description(channel), image,
            feed_url: feed_url.to_string(), language, episode_count: episodes.len() },
        episodes,
    })
}

pub fn is_podcast(id: u64) -> bool { (PODCAST_BASE..PODCAST_END).contains(&id) }

fn persist_show(conn: &rusqlite::Connection, podcast: &Podcast) -> Result<u64, String> {
    conn.execute("INSERT INTO podcast_shows (feed_url, title, author, description, image, language)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(feed_url) DO UPDATE SET
        title=excluded.title, author=excluded.author, description=excluded.description, image=excluded.image, language=excluded.language",
        params![podcast.feed_url, podcast.title, podcast.author, podcast.description, podcast.image, podcast.language])
        .map_err(|e| format!("No se pudo guardar el podcast: {e}"))?;
    let id: i64 = conn.query_row("SELECT id FROM podcast_shows WHERE feed_url=?1", params![podcast.feed_url], |r| r.get(0))
        .map_err(|e| format!("No se pudo recuperar el podcast: {e}"))?;
    Ok(PODCAST_BASE + id as u64)
}

fn save_show(db: &Db, podcast: &mut Podcast) -> Result<(), String> {
    podcast.id = persist_show(&db.0.lock().unwrap(), podcast)?;
    Ok(())
}

fn save_detail(db: &Db, detail: &mut PodcastDetail) -> Result<(), String> {
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    detail.podcast.id = persist_show(&tx, &detail.podcast)?;
    let show_id = (detail.podcast.id - PODCAST_BASE) as i64;
    for episode in &mut detail.episodes {
        tx.execute("INSERT INTO podcast_episodes (show_id, guid, audio_url) VALUES (?1, ?2, ?3)
            ON CONFLICT(show_id, guid) DO UPDATE SET audio_url=excluded.audio_url", params![show_id, episode.guid, episode.audio_url])
            .map_err(|e| format!("No se pudo guardar el episodio: {e}"))?;
        let id: i64 = tx.query_row("SELECT id FROM podcast_episodes WHERE show_id=?1 AND guid=?2", params![show_id, episode.guid], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        episode.id = EPISODE_BASE + id as u64;
    }
    tx.commit().map_err(|e| format!("No se pudieron guardar los episodios: {e}"))
}

pub fn audio(db: &Db, id: u64) -> Result<String, String> {
    if !(EPISODE_BASE..PODCAST_END).contains(&id) { return Err("El identificador no corresponde a un episodio".into()); }
    db.0.lock().unwrap().query_row("SELECT audio_url FROM podcast_episodes WHERE id=?1", params![(id - EPISODE_BASE) as i64], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?
        .ok_or_else(|| "Este episodio ya no está disponible. Vuelve a abrir su podcast".into())
}

pub fn feed_url(db: &Db, id: u64) -> Result<String, String> {
    if !(PODCAST_BASE..EPISODE_BASE).contains(&id) { return Err("El identificador no corresponde a un podcast".into()); }
    db.0.lock().unwrap().query_row("SELECT feed_url FROM podcast_shows WHERE id=?1", params![(id - PODCAST_BASE) as i64], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?.ok_or_else(|| "No se encuentra este podcast en la biblioteca".into())
}

#[tauri::command]
pub async fn podcast_search(query: String, language: String, podcasts: State<'_, Podcasts>, db: State<'_, Db>) -> Result<PodcastSearchResults, String> {
    podcasts.search(&query, &language, &db).await
}

#[tauri::command]
pub async fn podcast_detail(feed_url: String, podcasts: State<'_, Podcasts>, db: State<'_, Db>) -> Result<PodcastDetail, String> {
    let mut detail = podcasts.feed(&feed_url).await?;
    save_detail(&db, &mut detail)?;
    Ok(detail)
}

#[tauri::command]
pub fn podcast_feed_url(id: u64, db: State<'_, Db>) -> Result<String, String> { feed_url(&db, id) }

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
        <title>Ciencia &amp; café</title><language>es-ES</language><itunes:author>María</itunes:author>
        <description><![CDATA[<p>Ideas &amp; ciencia.</p>]]></description><itunes:image href="/cover.jpg"/>
        <itunes:explicit>yes</itunes:explicit>
        <item><title>Episodio uno</title><guid>stable-guid</guid><pubDate>Wed, 07 Oct 2026 08:00:00 GMT</pubDate>
        <itunes:duration>1:02:03</itunes:duration><itunes:explicit>no</itunes:explicit>
        <description><![CDATA[<p>Una <b>charla</b>.</p>]]></description>
        <enclosure url="https://audio.example/one.mp3?x=1&amp;y=2" type="audio/mpeg"/></item>
        <item><title>Duplicado</title><guid>stable-guid</guid><enclosure url="https://audio.example/one.mp3" type="audio/mpeg"/></item>
        <item><title>Vídeo</title><enclosure url="https://audio.example/video.mp4" type="video/mp4"/></item>
        <item><title>Sin audio</title></item>
        <item><title>Episodio dos</title><itunes:duration>95</itunes:duration><enclosure url="/two.m4a"/></item>
        <item><title>Archivo inseguro</title><enclosure url="file:///private.mp3" type="audio/mpeg"/></item>
        </channel></rss>"#;

    #[test]
    fn filters_actual_language_and_regional_variants() {
        for (input, expected) in [("es-ES", "es"), (" ES_mx ", "es"), ("spa", "es"), ("en-US", "en"), ("ca-ES", "ca")] {
            let actual = normalize_language(input);
            assert_eq!(actual.as_deref(), Some(expected));
            assert!(matches_language(actual.as_deref(), Some(expected)));
        }
        assert!(!matches_language(Some("en"), Some("es")));
        assert!(!matches_language(None, Some("es")));
        assert!(matches_language(None, None));
        assert_eq!(normalize_language("und"), None);
        assert_eq!(normalize_language("Spanish"), None);
        assert_eq!(filter_language("all").unwrap(), None);
        assert!(filter_language("invalid-language").is_err());
    }

    #[test]
    fn reads_namespaces_cdata_and_audio_episodes() {
        let detail = parse_feed(FEED, "https://feed.example/rss").unwrap();
        assert_eq!(detail.podcast.title, "Ciencia & café");
        assert_eq!(detail.podcast.author, "María");
        assert_eq!(detail.podcast.language.as_deref(), Some("es"));
        assert_eq!(detail.podcast.description, "Ideas & ciencia.");
        assert_eq!(detail.podcast.image.as_deref(), Some("https://feed.example/cover.jpg"));
        assert_eq!(detail.episodes.len(), 2);
        assert_eq!(detail.episodes[0].duration, 3723);
        assert_eq!(detail.episodes[0].audio_url, "https://audio.example/one.mp3?x=1&y=2");
        assert!(!detail.episodes[0].explicit);
        assert!(detail.episodes[1].explicit);
        assert_eq!(detail.episodes[1].audio_url, "https://feed.example/two.m4a");
        assert_eq!(detail.episodes[1].duration, 95);
        assert!(detail.episodes[0].published_at.is_some());
    }

    #[test]
    fn rejects_bad_feeds_and_limits_duration() {
        assert!(parse_feed("<html><title>Error</title></html>", "https://feed.example/rss").is_err());
        assert!(parse_feed("<rss><channel>", "https://feed.example/rss").is_err());
        assert!(parse_feed("<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///private'>]><rss><channel><title>&x;</title></channel></rss>", "https://feed.example/rss").is_err());
        for value in ["1:60", "1:02:99", "-5", "unknown", "4294967295:20"] { assert_eq!(duration(value), 0); }
        assert_eq!(duration("02:30"), 150);
        assert_eq!(duration("300"), 300);
        assert!(web_url("javascript:alert(1)").is_none());
    }

    #[test]
    fn supports_declared_feed_encoding() {
        let mut bytes = b"<?xml version='1.0' encoding='ISO-8859-1'?><rss><channel><title>Caf".to_vec();
        bytes.push(0xe9);
        bytes.extend_from_slice(b"</title></channel></rss>");
        let detail = parse_feed(&decode_xml(&bytes).unwrap(), "https://feed.example/rss").unwrap();
        assert_eq!(detail.podcast.title, "Café");
        assert_eq!(detail.podcast.language, None);
    }

    #[tokio::test]
    async fn language_filters_share_the_same_catalog_and_all_includes_unknown() {
        let client = Podcasts::new();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut directory = Vec::new();
        for (index, language) in [Some("es"), Some("en"), None].into_iter().enumerate() {
            let url = format!("https://feed.example/{index}");
            let mut detail = parse_feed(FEED, &url).unwrap();
            detail.podcast.language = language.map(String::from);
            put_cached(&client.feeds, url.clone(), detail, 32);
            directory.push(DirectoryEntry { feed_url: Some(url), artwork_url600: None });
        }
        put_cached(&client.searches, "offline".into(), directory, 24);
        let spanish = client.search("offline", "es-MX", &db).await.unwrap();
        let all = client.search("offline", "all", &db).await.unwrap();
        let english = client.search("offline", "en", &db).await.unwrap();
        assert_eq!(spanish.podcasts.len(), 1);
        assert_eq!(english.podcasts.len(), 1);
        assert_eq!(all.podcasts.len(), 3);
        assert_eq!(spanish.failed_feeds, 0);
        assert!(all.podcasts.iter().any(|podcast| podcast.id == spanish.podcasts[0].id));
        assert!(all.podcasts.iter().any(|podcast| podcast.language.is_none()));
    }

    #[tokio::test]
    async fn unreachable_feeds_report_failure_instead_of_empty_success() {
        let client = Podcasts::new();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        // TCP port zero cannot host a feed. No connection to an external service is made.
        put_cached(&client.searches, "offline-failure".into(), vec![DirectoryEntry {
            feed_url: Some("http://127.0.0.1:0/rss".into()),
            artwork_url600: None,
        }], 24);
        let error = client.search("offline-failure", "es", &db).await.unwrap_err();
        assert!(error.contains("no se pudo leer ningún podcast"), "{error}");
    }

    #[test]
    fn episode_identity_and_audio_survive_restart_and_url_changes() {
        let path = std::env::temp_dir().join(format!("pletina-podcast-test-{}.db", std::process::id()));
        let mut first = parse_feed(FEED, "https://feed.example/rss").unwrap();
        let db = Db::open(&path).unwrap();
        save_detail(&db, &mut first).unwrap();
        let id = first.episodes[0].id;
        let show = first.podcast.id;
        assert!(is_podcast(id) && is_podcast(show));
        assert!(id < crate::local::LOCAL_BASE && show < crate::local::LOCAL_BASE);
        assert_ne!(id, show);
        drop(db);
        let db = Db::open(&path).unwrap();
        assert_eq!(audio(&db, id).unwrap(), first.episodes[0].audio_url);
        assert_eq!(feed_url(&db, show).unwrap(), first.podcast.feed_url);
        let mut changed = parse_feed(&FEED.replace("one.mp3", "renewed.mp3"), "https://feed.example/rss").unwrap();
        save_detail(&db, &mut changed).unwrap();
        assert_eq!(changed.episodes[0].id, id);
        assert!(audio(&db, id).unwrap().contains("renewed.mp3"));
        assert!(audio(&db, show).is_err());
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    #[ignore = "consulta el catálogo de Apple y RSS públicos; requiere conexión"]
    async fn live_catalog_search_and_spanish_filter() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let client = Podcasts::new();
        let found = client.search("historia", "es", &db).await.unwrap();
        assert!(!found.podcasts.is_empty(), "No se devolvieron podcasts en español");
        assert!(found.podcasts.iter().all(|p| p.language.as_deref() == Some("es")));
        let mut detail = client.feed(&found.podcasts[0].feed_url).await.unwrap();
        save_detail(&db, &mut detail).unwrap();
        assert!(!detail.episodes.is_empty());
        let audio_url = audio(&db, detail.episodes[0].id).unwrap();
        assert!(web_url(&audio_url).is_some());
        let response = client.http.get(audio_url).header(reqwest::header::RANGE, "bytes=0-0").send().await.unwrap();
        assert!(response.status().is_success(), "El audio respondió con {}", response.status());
        // Solo comprobar cabeceras: si el servidor ignora Range, no descargar todo el episodio.
        drop(response);
    }
}
