//! Búsqueda de canciones en YouTube Music y elección del vídeo que corresponde
//! a una canción de Deezer.
//!
//! La búsqueda usa directamente la API interna de YouTube Music (la misma que usa su web):
//! tarda menos de un segundo y devuelve artista, disco y duración, que es lo que permite
//! acertar con la versión buena.

use serde::Deserialize;
use serde_json::{Value, json};

const SEARCH_URL: &str = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
const CLIENT_VERSION: &str = "1.20260901.01.00";
/// Filtro "Canciones" de YouTube Music.
const SONGS_PARAMS: &str = "EgWKAQIIAWoKEAkQBRAKEAMQBA==";
pub const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// Puntuación mínima para dar un vídeo por bueno.
pub const MIN_SCORE: i32 = 45;
/// Por debajo de esta puntuación se busca también en YouTube normal.
pub const CONFIDENT_SCORE: i32 = 70;

/// La canción tal como la conocemos por Deezer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackQuery {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: u32,
}

impl TrackQuery {
    pub fn search_text(&self) -> String {
        format!("{} {}", self.artist, strip_brackets(&self.title))
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub video_id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration: Option<u32>,
}

pub struct YouTubeMusic {
    http: reqwest::Client,
}

impl YouTubeMusic {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(BROWSER_UA)
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("cliente HTTP");
        Self { http }
    }

    pub async fn search_songs(&self, query: &str) -> Result<Vec<Candidate>, String> {
        let body = json!({
            "context": { "client": { "clientName": "WEB_REMIX", "clientVersion": CLIENT_VERSION, "hl": "es", "gl": "ES" } },
            "query": query,
            "params": SONGS_PARAMS,
        });
        let res = self
            .http
            .post(SEARCH_URL)
            .header("Content-Type", "application/json")
            .header("Origin", "https://music.youtube.com")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("No se pudo conectar con YouTube Music: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("YouTube Music respondió {}", res.status()));
        }
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;

        let sections = v
            .pointer("/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        Ok(sections
            .iter()
            .filter_map(|s| s.pointer("/musicShelfRenderer/contents").and_then(Value::as_array))
            .flatten()
            .filter_map(parse_song)
            .collect())
    }
}

fn parse_song(item: &Value) -> Option<Candidate> {
    let r = item.get("musicResponsiveListItemRenderer")?;
    let video_id = r
        .pointer("/playlistItemData/videoId")
        .or_else(|| {
            r.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId")
        })?
        .as_str()?
        .to_string();
    let columns = r.get("flexColumns")?.as_array()?;
    let runs = |i: usize| {
        columns
            .get(i)
            .and_then(|c| c.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
    };

    let title: String = runs(0).iter().filter_map(|run| run.get("text")?.as_str()).collect();
    let mut artists = Vec::new();
    let mut album = None;
    let mut duration = None;
    let mut plain = Vec::new();
    for run in runs(1) {
        let Some(text) = run.get("text").and_then(Value::as_str) else { continue };
        let page = run
            .pointer("/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
            .and_then(Value::as_str);
        match page {
            Some("MUSIC_PAGE_TYPE_ARTIST") => artists.push(text.to_string()),
            Some("MUSIC_PAGE_TYPE_ALBUM") => album = Some(text.to_string()),
            _ => match parse_duration(text) {
                Some(d) => duration = Some(d),
                None if text.trim() != "•" && !text.trim().is_empty() => plain.push(text.to_string()),
                None => {}
            },
        }
    }
    // Artistas sin enlace (p. ej. colaboraciones): el primer texto suelto.
    if artists.is_empty() {
        artists.extend(plain.into_iter().next());
    }
    Some(Candidate { video_id, title, artists, album, duration })
}

/// "4:48" → 288, "1:02:03" → 3723.
pub fn parse_duration(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    parts.iter().try_fold(0u32, |acc, p| Some(acc * 60 + p.parse::<u32>().ok()?))
}

/// Palabras que indican otra versión de la canción. Solo penalizan si no están en el título original.
const OTHER_VERSIONS: &[&str] = &[
    "live", "en vivo", "en directo", "directo", "concierto", "concert", "cover", "karaoke", "instrumental",
    "remix", "acoustic", "acustico", "sped up", "slowed", "nightcore", "8d", "reverb", "tribute", "tributo",
];

/// Cuánto se parece un vídeo a la canción buscada. Cuanto más alto, mejor.
pub fn score(q: &TrackQuery, c: &Candidate, rank: usize) -> i32 {
    let mut score = 0;

    // Duración: la mejor señal para distinguir la versión del disco de directos y remezclas.
    score += match c.duration {
        Some(d) => match d.abs_diff(q.duration) {
            0..=3 => 40,
            4..=7 => 30,
            8..=15 => 10,
            16..=60 => -30,
            _ => -60,
        },
        None => 0,
    };

    let want = base_title(&q.title);
    let got = base_title(&c.title);
    score += if want == got {
        // Mismo título completo, paréntesis incluidos ("Remastered 2009" frente a "2019 Mix").
        if normalize(&q.title) == normalize(&c.title) { 34 } else { 30 }
    } else if !want.is_empty() && !got.is_empty() && (got.contains(&want) || want.contains(&got)) {
        18
    } else {
        match jaccard(&want, &got) {
            j if j >= 0.5 => 10,
            // Otra canción (aunque sea del mismo grupo y dure lo mismo).
            _ => -40,
        }
    };

    let artist = normalize(&q.artist);
    let artists: Vec<String> = c.artists.iter().map(|a| normalize(a)).collect();
    score += if artists.iter().any(|a| *a == artist) {
        25
    } else if artists.iter().any(|a| !a.is_empty() && (a.contains(&artist) || artist.contains(a.as_str()))) {
        18
    } else {
        -15
    };

    if let Some(album) = &c.album {
        if base_title(album) == base_title(&q.album) {
            score += 8;
        }
    }

    let original = format!(" {} ", normalize(&q.title));
    let candidate = format!(" {} ", normalize(&c.title));
    for word in OTHER_VERSIONS {
        let word = format!(" {word} ");
        if candidate.contains(&word) && !original.contains(&word) {
            score -= 35;
        }
    }

    // YouTube Music ya ordena bien: un pequeño empujón a los primeros resultados.
    score + 5 - (rank as i32).min(5)
}

/// Minúsculas, sin tildes ni signos, espacios simples.
pub fn normalize(s: &str) -> String {
    let mapped: String = s
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'ø' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Quita lo que va entre paréntesis o corchetes: "Airbag (Remastered)" → "Airbag".
pub fn strip_brackets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Título "de base" para comparar: sin paréntesis ni sufijos tipo " - Remastered 2009".
fn base_title(s: &str) -> String {
    let stripped = strip_brackets(s);
    normalize(stripped.split(" - ").next().unwrap_or_default())
}

fn jaccard(a: &str, b: &str) -> f32 {
    let a: std::collections::HashSet<&str> = a.split(' ').collect();
    let b: std::collections::HashSet<&str> = b.split(' ').collect();
    let union = a.union(&b).count();
    if union == 0 { 0.0 } else { a.intersection(&b).count() as f32 / union as f32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> TrackQuery {
        TrackQuery {
            id: 1,
            title: "Airbag".into(),
            artist: "Radiohead".into(),
            album: "OK Computer".into(),
            duration: 287,
        }
    }

    fn cand(title: &str, artist: &str, duration: u32) -> Candidate {
        Candidate {
            video_id: "x".into(),
            title: title.into(),
            artists: vec![artist.into()],
            album: None,
            duration: Some(duration),
        }
    }

    #[test]
    fn prefers_album_version_over_live() {
        let q = query();
        let studio = score(&q, &cand("Airbag", "Radiohead", 288), 1);
        let live = score(&q, &cand("Airbag (Live)", "Radiohead", 301), 0);
        assert!(studio >= CONFIDENT_SCORE, "{studio}");
        assert!(live < MIN_SCORE, "{live}");
    }

    #[test]
    fn rejects_other_song_same_artist_same_length() {
        let q = TrackQuery {
            id: 1,
            title: "Spoiler!".into(),
            artist: "Berri Txarrak".into(),
            album: "Infrasoinuak".into(),
            duration: 217,
        };
        assert!(score(&q, &cand("Spoiler!", "Berri Txarrak", 218), 0) >= CONFIDENT_SCORE);
        assert!(score(&q, &cand("Bakarrik Egoteko", "Berri Txarrak", 217), 1) < MIN_SCORE);
    }

    #[test]
    fn rejects_other_artist() {
        let q = query();
        assert!(score(&q, &cand("Airbag", "Someone Else", 200), 0) < MIN_SCORE);
    }

    #[test]
    fn helpers() {
        assert_eq!(parse_duration("4:48"), Some(288));
        assert_eq!(parse_duration("1:02:03"), Some(3723));
        assert_eq!(parse_duration("19 M"), None);
        assert_eq!(normalize("Canción Ñandú!"), "cancion nandu");
        assert_eq!(base_title("Help! (Remastered 2009) - Mono"), "help");
    }
}
