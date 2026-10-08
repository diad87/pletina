//! Podcasts de YouTube Music: buscar programas y leer sus episodios, con la misma API interna que
//! usa su web (ver `youtube.rs`). Cada episodio es un vídeo, así que suena con el motor de audio de
//! siempre (también en el móvil). En YouTube Music cada temporada suele ser un programa aparte.
//!
//! `podcasts.rs` los guarda como cualquier otro podcast: el programa con la dirección
//! `youtube:<id>` en lugar de la de un RSS, y cada episodio con el audio `youtube:<vídeo>`.

use crate::youtube::YouTubeMusic;
use serde_json::{Value, json};

/// Prefijo de los programas (`youtube:MPSP…`) y de los episodios (`youtube:<vídeo>`).
pub const PREFIX: &str = "youtube:";
/// Filtro «Podcasts» de la búsqueda de YouTube Music.
const PODCASTS_PARAMS: &str = "EgWKAQJQAWoMEA4QChADEAQQCRAF";
const MAX_SHOWS: usize = 20;
/// Las páginas de episodios son de unos 20.
const MAX_EPISODES: usize = 300;

#[derive(Debug, Clone, PartialEq)]
pub struct Show {
    pub browse_id: String,
    pub title: String,
    pub author: String,
    pub image: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Episode {
    pub video_id: String,
    pub title: String,
    pub description: String,
    /// Fecha en ISO 8601 (YouTube solo da «27 ago 2018» o «hace 4 d»).
    pub published: Option<String>,
    pub duration: u32,
    pub image: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ShowPage {
    pub show: Show,
    pub description: String,
    pub episodes: Vec<Episode>,
}

/// Programas que encuentra la búsqueda de podcasts de YouTube Music.
pub async fn search(ytm: &YouTubeMusic, query: &str) -> Result<Vec<Show>, String> {
    let response = ytm.api("search", json!({ "query": query, "params": PODCASTS_PARAMS })).await?;
    Ok(parse_search(&response))
}

/// Un programa y sus episodios (todas las páginas, hasta `MAX_EPISODES`).
pub async fn show(ytm: &YouTubeMusic, browse_id: &str) -> Result<ShowPage, String> {
    if !valid_browse_id(browse_id) {
        return Err("Este podcast de YouTube no es válido".into());
    }
    let response = ytm.api("browse", json!({ "browseId": browse_id })).await?;
    let mut page = parse_show(browse_id, &response, today())?;
    let mut token = continuation(&response);
    while let Some(next) = token.filter(|_| page.episodes.len() < MAX_EPISODES) {
        let more = ytm.api("browse", json!({ "continuation": next })).await?;
        let before = page.episodes.len();
        add_episodes(&mut page.episodes, &more, today());
        // Sin episodios nuevos, la página siguiente ya no aporta nada.
        token = if page.episodes.len() > before { continuation(&more) } else { None };
    }
    page.episodes.truncate(MAX_EPISODES);
    Ok(page)
}

fn valid_browse_id(id: &str) -> bool {
    id.starts_with("MPSP") && id.len() < 100 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn parse_search(response: &Value) -> Vec<Show> {
    let mut items = Vec::new();
    collect(response, "musicResponsiveListItemRenderer", &mut items);
    let mut shows: Vec<Show> = Vec::new();
    for item in items {
        let Some(browse_id) = item.pointer("/navigationEndpoint/browseEndpoint/browseId").and_then(Value::as_str) else { continue };
        if !valid_browse_id(browse_id) || shows.iter().any(|s| s.browse_id == browse_id) {
            continue;
        }
        let column = |i: usize| runs(item.pointer(&format!("/flexColumns/{i}/musicResponsiveListItemFlexColumnRenderer/text")));
        let title = column(0);
        if title.is_empty() {
            continue;
        }
        let author = column(1);
        let author = author.strip_prefix("Podcast • ").unwrap_or(&author).to_string();
        shows.push(Show {
            browse_id: browse_id.to_string(),
            title,
            author,
            image: thumbnail(item.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")),
        });
        if shows.len() == MAX_SHOWS {
            break;
        }
    }
    shows
}

fn parse_show(browse_id: &str, response: &Value, today: Date) -> Result<ShowPage, String> {
    let header = first(response, "musicResponsiveHeaderRenderer").ok_or("YouTube Music no ha devuelto este podcast")?;
    let show = Show {
        browse_id: browse_id.to_string(),
        title: runs(header.get("title")),
        author: runs(header.get("straplineTextOne")),
        image: thumbnail(header.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")),
    };
    let description = runs(header.pointer("/description/musicDescriptionShelfRenderer/description"));
    let mut episodes = Vec::new();
    add_episodes(&mut episodes, response, today);
    Ok(ShowPage { show, description, episodes })
}

fn add_episodes(episodes: &mut Vec<Episode>, response: &Value, today: Date) {
    let mut items = Vec::new();
    collect(response, "musicMultiRowListItemRenderer", &mut items);
    for item in items {
        if let Some(episode) = parse_episode(item, today) {
            if !episodes.iter().any(|e| e.video_id == episode.video_id) {
                episodes.push(episode);
            }
        }
    }
}

fn parse_episode(item: &Value, today: Date) -> Option<Episode> {
    let video_id = item
        .pointer("/onTap/watchEndpoint/videoId")
        .or_else(|| item.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId"))?
        .as_str()?;
    if video_id.len() != 11 || !video_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return None;
    }
    // «214 K visualizaciones • 27 ago 2018»: la fecha es lo último.
    let published = last_run(item.pointer("/subtitle/runs")).and_then(|t| parse_date(&t, today));
    let duration = last_run(item.pointer("/playbackProgress/musicPlaybackProgressRenderer/durationText/runs"))
        .map(|t| parse_duration(&t))
        .unwrap_or(0);
    Some(Episode {
        video_id: video_id.to_string(),
        title: runs(item.get("title")),
        description: runs(item.get("description")),
        published,
        duration,
        image: thumbnail(item.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")),
    })
}

fn continuation(response: &Value) -> Option<String> {
    first(response, "continuationCommand")
        .and_then(|c| c.get("token"))
        .or_else(|| first(response, "nextContinuationData").and_then(|c| c.get("continuation")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

// --- Ayudas para leer la respuesta ---------------------------------------------------------

/// Todos los objetos con esa clave, a cualquier profundidad.
fn collect<'a>(value: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if k == key {
                    out.push(v);
                }
                collect(v, key, out);
            }
        }
        Value::Array(list) => list.iter().for_each(|v| collect(v, key, out)),
        _ => {}
    }
}

fn first<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let mut found = Vec::new();
    collect(value, key, &mut found);
    found.into_iter().next()
}

/// El texto de un `{runs: [{text}]}`.
fn runs(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.get("runs"))
        .and_then(Value::as_array)
        .map(|runs| runs.iter().filter_map(|r| r.get("text").and_then(Value::as_str)).collect::<String>())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn last_run(value: Option<&Value>) -> Option<String> {
    value?.as_array()?.iter().rev().filter_map(|r| r.get("text")?.as_str()).map(str::trim).find(|t| !t.is_empty() && *t != "•").map(str::to_string)
}

/// La miniatura más grande, solo si es https.
fn thumbnail(value: Option<&Value>) -> Option<String> {
    value?
        .as_array()?
        .iter()
        .filter_map(|t| t.get("url")?.as_str())
        .last()
        .filter(|u| u.starts_with("https://"))
        .map(str::to_string)
}

// --- Fechas y duraciones -------------------------------------------------------------------

type Date = (i64, u32, u32);

fn today() -> Date {
    civil_from_days(crate::ytdlp::now() as i64 / 86_400)
}

/// «27 ago 2018», «26 sept» (de este año), «hace 4 d», «hace 2 semanas»… → `2018-08-27T12:00:00Z`.
fn parse_date(text: &str, today: Date) -> Option<String> {
    let text = text.trim().to_lowercase();
    let days = if let Some(ago) = text.strip_prefix("hace ") {
        let mut parts = ago.split_whitespace();
        let n: i64 = parts.next()?.parse().ok()?;
        let unit = parts.next()?;
        let per = if unit.starts_with("seg") || unit == "s" || unit.starts_with("min") || unit == "h" || unit.starts_with("hora") {
            0
        } else if unit == "d" || unit.starts_with("día") || unit.starts_with("dia") {
            1
        } else if unit.starts_with("sem") {
            7
        } else if unit.starts_with("mes") {
            30
        } else if unit.starts_with("año") || unit.starts_with("a") {
            365
        } else {
            return None;
        };
        days_from_civil(today) - n * per
    } else {
        let mut parts = text.split_whitespace();
        let day: u32 = parts.next()?.parse().ok()?;
        let month = month(parts.next()?)?;
        let date = match parts.next() {
            Some(year) => (year.parse().ok()?, month, day),
            None => {
                // Sin año: de este año, salvo que eso fuera en el futuro.
                let this_year = (today.0, month, day);
                if days_from_civil(this_year) > days_from_civil(today) { (today.0 - 1, month, day) } else { this_year }
            }
        };
        if !(1..=31).contains(&day) {
            return None;
        }
        days_from_civil(date)
    };
    let (y, m, d) = civil_from_days(days);
    Some(format!("{y:04}-{m:02}-{d:02}T12:00:00Z"))
}

fn month(name: &str) -> Option<u32> {
    let name = name.trim_end_matches('.');
    const MONTHS: [&str; 12] = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    MONTHS.iter().position(|m| name.starts_with(m)).map(|i| i as u32 + 1)
}

/// «51 min», «1 h 5 min», «45 s» o «1:02:03» → segundos.
fn parse_duration(text: &str) -> u32 {
    let text = text.trim();
    if text.contains(':') {
        return text.split(':').try_fold(0u32, |acc, part| part.trim().parse::<u32>().ok().map(|n| acc * 60 + n)).unwrap_or(0);
    }
    let mut total = 0;
    let mut number = None;
    for token in text.split_whitespace() {
        if let Ok(n) = token.parse::<u32>() {
            number = Some(n);
        } else if let Some(n) = number.take() {
            total += match token {
                t if t.starts_with('h') => n * 3600,
                t if t.starts_with("min") => n * 60,
                t if t.starts_with('s') => n,
                _ => 0,
            };
        }
    }
    total
}

/// Días desde el 1-1-1970 (algoritmo de Howard Hinnant).
fn days_from_civil((y, m, d): Date) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> Date {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: Date = (2026, 10, 8);

    #[test]
    fn dates() {
        assert_eq!(parse_date("27 ago 2018", TODAY).as_deref(), Some("2018-08-27T12:00:00Z"));
        assert_eq!(parse_date("26 sept", TODAY).as_deref(), Some("2026-09-26T12:00:00Z"));
        // Sin año y en el futuro: del año pasado.
        assert_eq!(parse_date("20 dic", TODAY).as_deref(), Some("2025-12-20T12:00:00Z"));
        assert_eq!(parse_date("hace 4 d", TODAY).as_deref(), Some("2026-10-04T12:00:00Z"));
        assert_eq!(parse_date("hace 2 semanas", TODAY).as_deref(), Some("2026-09-24T12:00:00Z"));
        assert_eq!(parse_date("hace 3 h", TODAY).as_deref(), Some("2026-10-08T12:00:00Z"));
        assert_eq!(parse_date("hace 1 año", TODAY).as_deref(), Some("2025-10-08T12:00:00Z"));
        assert_eq!(parse_date("214 K visualizaciones", TODAY), None);
        assert_eq!(civil_from_days(days_from_civil((2024, 2, 29))), (2024, 2, 29));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("51 min"), 51 * 60);
        assert_eq!(parse_duration("1 h 5 min"), 3900);
        assert_eq!(parse_duration("1 h"), 3600);
        assert_eq!(parse_duration("1:02:03"), 3723);
        assert_eq!(parse_duration("Reproducido"), 0);
    }

    fn show_item(browse_id: &str, title: &str, author: &str) -> Value {
        json!({ "musicResponsiveListItemRenderer": {
            "navigationEndpoint": { "browseEndpoint": { "browseId": browse_id } },
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": title }] } } },
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": author }] } } }
            ],
            "thumbnail": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [
                { "url": "https://i.ytimg.com/small.jpg" }, { "url": "https://i.ytimg.com/big.jpg" }
            ] } } }
        } })
    }

    #[test]
    fn search_results_are_podcast_shows_only() {
        let response = json!({ "contents": [
            show_item("MPSPPLVYKDE9WjKYQ", "NADIE SABE NADA | Temporada 14", "Podcast • Nadie Sabe Nada"),
            show_item("MPSPPLVYKDE9WjKYQ", "Repetido", "x"),
            show_item("UCxxxxxxxx", "Un canal, no un podcast", "x"),
            show_item("MPSP<script>", "Raro", "x"),
        ] });
        let shows = parse_search(&response);
        assert_eq!(shows.len(), 1);
        assert_eq!(shows[0].title, "NADIE SABE NADA | Temporada 14");
        assert_eq!(shows[0].author, "Nadie Sabe Nada");
        assert_eq!(shows[0].image.as_deref(), Some("https://i.ytimg.com/big.jpg"));
    }

    #[test]
    fn show_page_with_episodes_and_continuation() {
        let response = json!({
            "header": { "musicResponsiveHeaderRenderer": {
                "title": { "runs": [{ "text": "Temporada 5" }] },
                "straplineTextOne": { "runs": [{ "text": "Nadie Sabe Nada Podcast" }] },
                "description": { "musicDescriptionShelfRenderer": { "description": { "runs": [{ "text": "La quinta temporada." }] } } }
            } },
            "contents": [
                { "musicMultiRowListItemRenderer": {
                    "onTap": { "watchEndpoint": { "videoId": "aV8l7X7B3tU" } },
                    "title": { "runs": [{ "text": "Cargarlo todo" }] },
                    "description": { "runs": [{ "text": "Cargamos los móviles…" }] },
                    "subtitle": { "runs": [{ "text": "214 K visualizaciones" }, { "text": " • " }, { "text": "27 ago 2018" }] },
                    "playbackProgress": { "musicPlaybackProgressRenderer": { "durationText": { "runs": [{ "text": " • " }, { "text": "51 min" }] } } }
                } },
                { "musicMultiRowListItemRenderer": { "onTap": { "watchEndpoint": { "videoId": "malo" } } } }
            ],
            "continuations": [{ "nextContinuationData": { "continuation": "TOKEN" } }]
        });
        let page = parse_show("MPSPPLMuFXpsA8v", &response, TODAY).unwrap();
        assert_eq!(page.show.title, "Temporada 5");
        assert_eq!(page.show.author, "Nadie Sabe Nada Podcast");
        assert_eq!(page.description, "La quinta temporada.");
        assert_eq!(page.episodes.len(), 1);
        let e = &page.episodes[0];
        assert_eq!((e.video_id.as_str(), e.duration), ("aV8l7X7B3tU", 51 * 60));
        assert_eq!(e.published.as_deref(), Some("2018-08-27T12:00:00Z"));
        assert_eq!(continuation(&response).as_deref(), Some("TOKEN"));
        assert!(parse_show("MPSPx", &json!({}), TODAY).is_err());
    }

    /// Con red: `cargo test youtube_podcasts -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn real_search_and_show() {
        let ytm = YouTubeMusic::new();
        let shows = search(&ytm, "nadie sabe nada").await.unwrap();
        println!("{shows:#?}");
        assert!(!shows.is_empty());
        let page = show(&ytm, &shows[0].browse_id).await.unwrap();
        println!("{} episodios; el primero: {:?}", page.episodes.len(), page.episodes.first());
        assert!(!page.episodes.is_empty());
    }
}
