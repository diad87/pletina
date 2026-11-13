//! Read-only export of the native library into the portable PWA migration format.

use crate::db::Db;
use crate::library::{LibTrack, SavedAlbum, SavedArtist, TRACK_COLS, track_at};
use crate::local::LOCAL_BASE;
use crate::podcasts::Podcast;
use crate::youtube_tracks::YOUTUBE_BASE;
use reqwest::Url;
use rusqlite::{Connection, Row};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::State;

const SHOW_BASE: u64 = 500_000_000_000_000;
const EPISODE_BASE: u64 = 750_000_000_000_000;
const MAX_DATE: u64 = 32_503_680_000;
const MAX_SECONDS: f64 = 31.0 * 24.0 * 60.0 * 60.0;
const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const LIMIT_ERROR: &str = "La biblioteca supera el tamaño admitido por la PWA. No se ha guardado una copia parcial. Conserva Pletina y sus datos para recuperarlos.";

#[derive(Default, Serialize)]
struct Library {
    tracks: Vec<LibTrack>,
    likes: Vec<Value>,
    albums: Vec<Timed<SavedAlbum>>,
    artists: Vec<Timed<SavedArtist>>,
    podcasts: Vec<PortablePodcast>,
    playlists: Vec<Value>,
    entries: Vec<Value>,
    history: Vec<Value>,
    progress: Vec<Value>,
    youtube: Vec<Value>,
    sources: Vec<Value>,
    episodes: Vec<Value>,
}

#[derive(Serialize)]
struct Timed<T> {
    id: u64,
    value: T,
    at: u64,
    order: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PortablePodcast {
    #[serde(flatten)]
    data: Timed<Podcast>,
    saved: bool,
    episode_ids: Vec<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListeningProgress {
    position: f64,
    duration: f64,
    completed: bool,
    updated_at: u64,
}

impl ListeningProgress {
    fn valid(&self) -> bool {
        (0.0..=MAX_SECONDS).contains(&self.position)
            && (0.0..=MAX_SECONDS).contains(&self.duration)
            && (self.duration == 0.0 || self.position <= self.duration)
            && self.updated_at <= MAX_DATE
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingPodcastProgress {
    feed_url: String,
    guid: String,
    #[serde(flatten)]
    progress: ListeningProgress,
}

#[derive(Serialize)]
struct Source {
    platform: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Contents {
    source: Source,
    library: Library,
    downloads: Vec<Value>,
    exclusions: BTreeMap<&'static str, usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pending_podcast_progress: Vec<PendingPodcastProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preferences: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format: &'static str,
    version: u8,
    created_at: String,
    snapshot_id: String,
    #[serde(flatten)]
    contents: Contents,
}

type Exclusions = BTreeMap<&'static str, usize>;

fn count(exclusions: &mut Exclusions, key: &'static str, amount: usize) {
    if amount != 0 {
        *exclusions.entry(key).or_default() += amount;
    }
}

fn read_rows<T>(
    conn: &Connection,
    sql: &str,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    conn.prepare(sql)
        .and_then(|mut stmt| stmt.query_map([], map)?.collect())
        .map_err(database_error)
}

fn database_error(_: rusqlite::Error) -> String {
    "No se pudo leer la biblioteca. No se han modificado los datos de Pletina.".into()
}

trait UnsignedColumn {
    fn unsigned(&self, column: usize) -> rusqlite::Result<u64>;
}

impl UnsignedColumn for Row<'_> {
    fn unsigned(&self, column: usize) -> rusqlite::Result<u64> {
        self.get::<_, i64>(column).map(|value| value as u64)
    }
}

fn valid_text(value: &str, max: usize, empty: bool) -> bool {
    value.encode_utf16().count() <= max && (empty || !value.trim().is_empty())
}

fn video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn stable_url(value: &str) -> Option<Url> {
    let url = Url::parse(value.trim()).ok()?;
    let host = url.host_str()?.trim_end_matches('.');
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || host == "googlevideo.com"
        || host.ends_with(".googlevideo.com")
        || url.query_pairs().any(|(key, _)| {
            let key = key.to_ascii_lowercase();
            matches!(
                key.as_str(),
                "sig"
                    | "lsig"
                    | "signature"
                    | "token"
                    | "access_token"
                    | "authorization"
                    | "expire"
                    | "expires"
                    | "policy"
                    | "key-pair-id"
                    | "jwt"
                    | "hdnea"
                    | "hdnts"
                    | "auth"
                    | "auth_token"
                    | "hmac"
                    | "awsaccesskeyid"
                    | "googleaccessid"
            ) || key.starts_with("x-amz-")
                || key.starts_with("x-goog-")
        })
        || !valid_text(url.as_str(), 16_384, false)
    {
        return None;
    }
    Some(url)
}

fn portable_feed(value: &str) -> Option<String> {
    if let Some(id) = value.strip_prefix("youtube:") {
        return (!id.is_empty()
            && value.len() <= 8192
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
        .then(|| value.to_owned());
    }
    let mut url = stable_url(value)?;
    url.set_fragment(None);
    Some(url.into())
}

fn portable_audio(value: &str) -> Option<String> {
    if let Some(id) = value.strip_prefix("youtube:") {
        return video_id(id).then(|| value.to_owned());
    }
    stable_url(value).map(Into::into)
}

fn portable_guid(value: &str) -> bool {
    let value = value.trim();
    // RSS uses the enclosure URL as the GUID when a publisher supplies none.
    // Do not turn a signed URL or a local file path into an exported identifier.
    valid_text(value, 16_384, false)
        && !value.starts_with(['/', '\\'])
        && !value.as_bytes().get(1).is_some_and(|byte| *byte == b':')
        && if value.contains("://") || value.to_ascii_lowercase().starts_with("file:") {
            stable_url(value).is_some()
        } else {
            true
        }
}

fn image(value: Option<String>, exclusions: &mut Exclusions) -> Option<String> {
    let value = value.filter(|value| !value.trim().is_empty())?;
    let safe = stable_url(&value).map(Into::into);
    if safe.is_none() {
        count(exclusions, "invalidMetadataUrls", 1);
    }
    safe
}

fn export_podcasts(
    conn: &Connection,
    tracks: &HashMap<u64, LibTrack>,
    library: &mut Library,
    pending: &mut Vec<PendingPodcastProgress>,
    exclusions: &mut Exclusions,
) -> Result<HashSet<u64>, String> {
    let mut by_show = HashMap::new();
    let mut seen_feeds = HashSet::new();
    let shows = read_rows(
        conn,
        "SELECT p.id, p.title, p.author, p.description, p.image, p.feed_url, p.language,
                f.added_at, (SELECT count(*) FROM podcast_episodes e WHERE e.show_id=p.id)
         FROM podcast_shows p LEFT JOIN saved_podcasts f ON p.id=f.show_id
         WHERE f.show_id IS NOT NULL OR EXISTS (
            SELECT 1 FROM podcast_episodes e
            LEFT JOIN podcast_progress r ON r.episode_id=e.id
            LEFT JOIN tracks t ON t.id=e.id+750000000000000
            WHERE e.show_id=p.id AND (r.episode_id IS NOT NULL OR t.id IS NOT NULL)
         )
         ORDER BY f.added_at, p.id",
        |row| {
            Ok((
                Podcast {
                    id: SHOW_BASE.saturating_add(row.unsigned(0)?),
                    title: row.get(1)?,
                    author: row.get(2)?,
                    description: row.get(3)?,
                    image: row.get(4)?,
                    feed_url: row.get(5)?,
                    language: row.get(6)?,
                    episode_count: row.get::<_, u32>(8)? as usize,
                },
                row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
            ))
        },
    )?;
    for (mut show, at) in shows {
        let Some(feed) = portable_feed(&show.feed_url) else {
            count(exclusions, "unportablePodcasts", 1);
            count(exclusions, "invalidMetadataUrls", 1);
            continue;
        };
        if !(SHOW_BASE + 1..EPISODE_BASE).contains(&show.id)
            || !valid_text(&show.title, 4000, false)
            || !valid_text(&show.author, 4000, true)
            || !valid_text(&show.description, 200_000, true)
            || show
                .language
                .as_ref()
                .is_some_and(|v| !valid_text(v, 4000, true))
            || show.episode_count > 1_000_000
            || at.is_some_and(|at| at > MAX_DATE)
            || !seen_feeds.insert(feed.clone())
        {
            count(exclusions, "unportablePodcasts", 1);
            continue;
        }
        show.feed_url = feed;
        show.image = image(show.image, exclusions);
        by_show.insert(show.id, library.podcasts.len());
        library.podcasts.push(PortablePodcast {
            data: Timed {
                id: show.id,
                value: show,
                at: at.unwrap_or_default(),
                order: library.podcasts.len() + 1,
            },
            saved: at.is_some(),
            episode_ids: Vec::new(),
        });
    }

    let episodes = read_rows(
        conn,
        "SELECT e.id, e.show_id, e.guid, e.audio_url, p.position, p.duration, p.completed, p.updated_at
         FROM podcast_episodes e
         LEFT JOIN tracks t ON t.id=e.id+750000000000000
         LEFT JOIN podcast_progress p ON p.episode_id=e.id
         WHERE t.id IS NOT NULL OR p.episode_id IS NOT NULL ORDER BY e.id",
        |row| {
            let position: Option<f64> = row.get(4)?;
            Ok((
                EPISODE_BASE.saturating_add(row.unsigned(0)?),
                SHOW_BASE.saturating_add(row.unsigned(1)?),
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                if let Some(position) = position {
                    Some(ListeningProgress {
                        position,
                        duration: row.get(5)?,
                        completed: row.get(6)?,
                        updated_at: row.unsigned(7)?,
                    })
                } else {
                    None
                },
            ))
        },
    )?;
    let mut transferable = HashSet::new();
    let mut identities = HashSet::new();
    for (id, show_id, guid, audio, progress) in episodes {
        let track = tracks.get(&id);
        let show = by_show
            .get(&show_id)
            .map(|&index| &mut library.podcasts[index]);
        let progress = progress.filter(|value| {
            let valid = value.valid();
            if !valid {
                count(exclusions, "unportablePodcastProgress", 1);
            }
            valid
        });
        let Some(show) = show.filter(|_| {
            (EPISODE_BASE + 1..LOCAL_BASE).contains(&id)
                && portable_guid(&guid)
                && identities.insert((show_id, guid.trim().to_owned()))
        }) else {
            count(
                exclusions,
                "unportablePodcastEpisodes",
                usize::from(track.is_some()),
            );
            count(
                exclusions,
                "unportablePodcastProgress",
                usize::from(progress.is_some()),
            );
            continue;
        };
        let guid = guid.trim();
        let audio_url = portable_audio(&audio);
        if let (Some(track), Some(audio_url)) = (track, audio_url) {
            // SQLite retains the enclosure and GUID, while the library track supplies the
            // actual title and duration. Other episode fields are only in the RSS cache.
            library.episodes.push(json!({
                "id": id, "podcastId": show_id, "guid": guid,
                "value": {
                    "id": id, "title": track.title, "description": "", "publishedAt": null,
                    "duration": track.duration, "audioUrl": audio_url, "image": track.cover,
                    "explicit": track.explicit
                }
            }));
            show.episode_ids.push(id);
            transferable.insert(id);
            if let Some(progress) = progress {
                library.progress.push(json!({
                    "id": id, "position": progress.position, "duration": progress.duration,
                    "completed": progress.completed, "updatedAt": progress.updated_at
                }));
            }
        } else {
            count(
                exclusions,
                "unportablePodcastEpisodes",
                usize::from(track.is_some()),
            );
            if let Some(progress) = progress {
                pending.push(PendingPodcastProgress {
                    feed_url: show.data.value.feed_url.clone(),
                    guid: guid.to_owned(),
                    progress,
                });
            }
        }
    }
    Ok(transferable)
}

fn note_missing_track(
    exclusions: &mut Exclusions,
    id: u64,
    local: &'static str,
    other: &'static str,
) {
    count(exclusions, if id >= LOCAL_BASE { local } else { other }, 1);
}

fn pin_preferences(
    pins: Option<Value>,
    playlists: &HashSet<u64>,
    albums: &[Timed<SavedAlbum>],
    exclusions: &mut Exclusions,
) -> Option<Value> {
    let pins = pins?;
    let Some(pins) = pins.as_array() else {
        count(exclusions, "unportablePins", 1);
        return None;
    };
    let album_ids: HashSet<_> = albums.iter().map(|album| album.id).collect();
    let mut seen = HashSet::new();
    let mut portable = Vec::new();
    for pin in pins {
        let valid = match (pin["kind"].as_str(), pin["id"].as_u64()) {
            (Some("playlist"), Some(id)) if playlists.contains(&id) => Some(("playlist", id)),
            (Some("album"), Some(id)) if album_ids.contains(&id) => Some(("album", id)),
            _ => None,
        };
        match valid {
            Some((kind, id)) if seen.insert((kind, id)) => {
                portable.push(json!({ "kind": kind, "id": id }));
            }
            _ => count(exclusions, "unportablePins", 1),
        }
    }
    (!portable.is_empty()).then(|| json!({ "pins": portable }))
}

fn export_contents(conn: &Connection, pins: Option<Value>) -> Result<Contents, String> {
    let mut contents = Contents {
        source: Source {
            platform: std::env::consts::OS,
            version: env!("CARGO_PKG_VERSION"),
        },
        library: Library::default(),
        downloads: Vec::new(),
        exclusions: Exclusions::new(),
        pending_podcast_progress: Vec::new(),
        preferences: None,
    };
    let library = &mut contents.library;
    let exclusions = &mut contents.exclusions;
    let tracks_sql = format!("SELECT {TRACK_COLS} FROM tracks t ORDER BY t.id");
    let mut tracks = HashMap::new();
    for mut track in read_rows(conn, &tracks_sql, |r| track_at(r, 0))? {
        if track.id >= LOCAL_BASE {
            count(exclusions, "localTracks", 1);
        } else if track.id == 0
            || [track.artist_id, track.album_id, track.album_artist_id]
                .iter()
                .any(|&id| id >= LOCAL_BASE)
            || !valid_text(&track.title, 4000, false)
            || !valid_text(&track.artist_name, 4000, true)
            || !valid_text(&track.album_title, 4000, true)
            || f64::from(track.duration) > MAX_SECONDS
        {
            count(exclusions, "unportableTracks", 1);
        } else {
            track.cover = image(track.cover, exclusions);
            tracks.insert(track.id, track);
        }
    }

    let mut videos = HashMap::new();
    let youtube = read_rows(
        conn,
        "SELECT track_id,video_id,added_at,saved FROM youtube_tracks ORDER BY added_at,track_id",
        |r| {
            Ok((
                r.unsigned(0)?,
                r.get::<_, String>(1)?,
                r.unsigned(2)?,
                r.get::<_, bool>(3)?,
            ))
        },
    )?;
    for (id, video, at, saved) in youtube {
        if (YOUTUBE_BASE + 1..SHOW_BASE).contains(&id)
            && tracks.contains_key(&id)
            && video_id(&video)
            && at <= MAX_DATE
        {
            library.youtube.push(json!({
                "trackId": id, "videoId": video, "at": at, "saved": saved, "order": library.youtube.len() + 1
            }));
            videos.insert(id, video);
        } else {
            count(exclusions, "unportableYouTube", 1);
        }
    }

    let episodes = export_podcasts(
        conn,
        &tracks,
        library,
        &mut contents.pending_podcast_progress,
        exclusions,
    )?;
    let mut ordered_tracks: Vec<_> = tracks.into_values().collect();
    ordered_tracks.sort_unstable_by_key(|track| track.id);
    let mut portable_tracks = HashSet::new();
    for track in ordered_tracks {
        let id = track.id;
        if id < YOUTUBE_BASE || videos.contains_key(&id) || episodes.contains(&id) {
            portable_tracks.insert(id);
            library.tracks.push(track);
        } else {
            count(exclusions, "unportableTracks", 1);
        }
    }

    for (id, at) in read_rows(
        conn,
        "SELECT track_id,added_at FROM liked_tracks ORDER BY added_at,track_id",
        |r| Ok((r.unsigned(0)?, r.unsigned(1)?)),
    )? {
        if portable_tracks.contains(&id) && at <= MAX_DATE {
            library
                .likes
                .push(json!({ "trackId": id, "at": at, "order": library.likes.len() + 1 }));
        } else {
            note_missing_track(exclusions, id, "localLikes", "unportableLikes");
        }
    }

    let albums = read_rows(
        conn,
        "SELECT id,title,artist_id,artist_name,cover,release_date,record_type,added_at
         FROM saved_albums ORDER BY added_at,id",
        |r| {
            Ok((
                SavedAlbum {
                    id: r.unsigned(0)?,
                    title: r.get(1)?,
                    artist_id: r.unsigned(2)?,
                    artist_name: r.get(3)?,
                    cover: r.get(4)?,
                    release_date: r.get(5)?,
                    record_type: r.get(6)?,
                },
                r.unsigned(7)?,
            ))
        },
    )?;
    for (mut album, at) in albums {
        if !(1..YOUTUBE_BASE).contains(&album.id)
            || album.artist_id >= LOCAL_BASE
            || !valid_text(&album.title, 4000, false)
            || !valid_text(&album.artist_name, 4000, true)
            || [&album.release_date, &album.record_type]
                .iter()
                .any(|value| {
                    value
                        .as_ref()
                        .is_some_and(|text| !valid_text(text, 4000, true))
                })
            || at > MAX_DATE
        {
            note_missing_track(exclusions, album.id, "localAlbums", "unportableAlbums");
            continue;
        }
        album.cover = image(album.cover, exclusions);
        library.albums.push(Timed {
            id: album.id,
            value: album,
            at,
            order: library.albums.len() + 1,
        });
    }

    let artists = read_rows(
        conn,
        "SELECT id,name,picture,added_at FROM saved_artists ORDER BY added_at,id",
        |r| {
            Ok((
                SavedArtist {
                    id: r.unsigned(0)?,
                    name: r.get(1)?,
                    picture: r.get(2)?,
                },
                r.unsigned(3)?,
            ))
        },
    )?;
    for (mut artist, at) in artists {
        if !(1..YOUTUBE_BASE).contains(&artist.id)
            || !valid_text(&artist.name, 4000, false)
            || at > MAX_DATE
        {
            note_missing_track(exclusions, artist.id, "localArtists", "unportableArtists");
            continue;
        }
        artist.picture = image(artist.picture, exclusions);
        library.artists.push(Timed {
            id: artist.id,
            value: artist,
            at,
            order: library.artists.len() + 1,
        });
    }

    let mut playlists = HashSet::new();
    for (id, name) in read_rows(
        conn,
        "SELECT id,name FROM playlists ORDER BY updated_at,id",
        |r| Ok((r.unsigned(0)?, r.get::<_, String>(1)?)),
    )? {
        if (1..LOCAL_BASE).contains(&id)
            && !name.trim().is_empty()
            && name.trim().chars().count() <= 100
        {
            playlists.insert(id);
            library
                .playlists
                .push(json!({ "id": id, "name": name, "order": library.playlists.len() + 1 }));
        } else {
            count(exclusions, "unportablePlaylists", 1);
        }
    }
    let mut positions = HashMap::<u64, usize>::new();
    for (id, playlist, track, at) in read_rows(
        conn,
        "SELECT id,playlist_id,track_id,added_at FROM playlist_tracks ORDER BY playlist_id,position,id",
        |r| {
            Ok((
                r.unsigned(0)?,
                r.unsigned(1)?,
                r.unsigned(2)?,
                r.unsigned(3)?,
            ))
        },
    )? {
        if portable_tracks.contains(&track)
            && playlists.contains(&playlist)
            && (1..LOCAL_BASE).contains(&id)
            && at <= MAX_DATE
        {
            let position = positions.entry(playlist).or_default();
            library.entries.push(json!({
                "entryId": id, "playlistId": playlist, "trackId": track, "position": *position, "at": at
            }));
            *position += 1;
        } else {
            note_missing_track(
                exclusions,
                track,
                "localPlaylistEntries",
                "unportablePlaylistEntries",
            );
        }
    }

    for (id, track, at) in read_rows(
        conn,
        "SELECT id,track_id,played_at FROM history ORDER BY played_at,id",
        |r| Ok((r.unsigned(0)?, r.unsigned(1)?, r.unsigned(2)?)),
    )? {
        if portable_tracks.contains(&track) && (1..LOCAL_BASE).contains(&id) && at <= MAX_DATE {
            library
                .history
                .push(json!({ "entryId": id, "trackId": track, "at": at }));
        } else {
            note_missing_track(exclusions, track, "localHistory", "unportableHistory");
        }
    }

    let sources = read_rows(
        conn,
        "SELECT track_id,video_id,title,channel,duration,score,verified FROM sources ORDER BY track_id",
        |r| {
            Ok((
                r.unsigned(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<u32>>(4)?,
                r.get::<_, i32>(5)?,
                r.get::<_, bool>(6)?,
            ))
        },
    )?;
    for (id, video, title, channel, duration, score, verified) in sources {
        if portable_tracks.contains(&id)
            && video_id(&video)
            && videos.get(&id).is_none_or(|expected| *expected == video)
            && valid_text(&title, 4000, true)
            && valid_text(&channel, 4000, true)
            && duration.is_none_or(|duration| f64::from(duration) <= MAX_SECONDS)
            && (-1_000_000..=1_000_000).contains(&score)
        {
            library.sources.push(json!({
                "trackId": id, "choice": { "videoId": video, "title": title, "channel": channel,
                "duration": duration, "score": score, "verified": verified }
            }));
        } else if verified || portable_tracks.contains(&id) {
            count(exclusions, "unportableSources", 1);
        }
    }

    // No paths, direct audio URLs or bytes. The user can decide which files to download again.
    for (id, title, artist) in read_rows(
        conn,
        "SELECT d.track_id,t.title,t.artist_name FROM downloads d JOIN tracks t ON t.id=d.track_id
         ORDER BY d.downloaded_at,d.track_id",
        |r| {
            Ok((
                r.unsigned(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )? {
        if (1..LOCAL_BASE).contains(&id)
            && valid_text(&title, 4000, false)
            && valid_text(&artist, 4000, true)
        {
            contents
                .downloads
                .push(json!({ "trackId": id, "title": title, "artistName": artist }));
        } else {
            count(exclusions, "unportableDownloads", 1);
        }
    }
    let settings = conn
        .query_row("SELECT count(*) FROM settings", [], |row| {
            row.get::<_, u32>(0)
        })
        .map_err(database_error)?;
    count(exclusions, "nativeSettings", settings as usize);
    contents.preferences = pin_preferences(pins, &playlists, &library.albums, exclusions);
    Ok(contents)
}

fn check_limits(contents: &Contents) -> Result<(), String> {
    let library = &contents.library;
    let limits = [
        (library.tracks.len(), 20_000),
        (library.likes.len(), 20_000),
        (library.albums.len(), 10_000),
        (library.artists.len(), 10_000),
        (library.podcasts.len(), 5_000),
        (library.playlists.len(), 1_000),
        (library.entries.len(), 20_000),
        (library.history.len(), 50_000),
        (library.progress.len(), 20_000),
        (library.youtube.len(), 20_000),
        (library.sources.len(), 20_000),
        (library.episodes.len(), 20_000),
        (contents.pending_podcast_progress.len(), 20_000),
        (contents.downloads.len(), 20_000),
    ];
    if limits.iter().any(|&(count, max)| count > max)
        || limits.iter().map(|&(count, _)| count).sum::<usize>() > MAX_ROWS
    {
        return Err(LIMIT_ERROR.into());
    }
    Ok(())
}

fn export(db: &Db, pins: Option<Value>) -> Result<String, String> {
    // A transaction takes one consistent snapshot, including commits still in the WAL.
    // All file I/O and JSON encoding happen after dropping the database lock.
    let (created_at, contents) = {
        let mut conn =
            db.0.lock()
                .map_err(|_| "La biblioteca no está disponible.")?;
        let tx = conn.transaction().map_err(database_error)?;
        let contents = export_contents(&tx, pins)?;
        let created_at = tx
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
                r.get(0)
            })
            .map_err(database_error)?;
        tx.commit().map_err(database_error)?;
        (created_at, contents)
    };
    check_limits(&contents)?;
    let encoding_error = |_| "No se pudo preparar la copia de la biblioteca.".to_owned();
    let payload = serde_json::to_vec(&contents).map_err(encoding_error)?;
    if payload.len() > MAX_BYTES {
        return Err(LIMIT_ERROR.into());
    }
    // The creation time is deliberately absent: exporting the same data again is a retry.
    let snapshot_id = format!("{:x}", Sha256::digest(&payload));
    let encoded = serde_json::to_string(&Envelope {
        format: "pletina-native-migration",
        version: 1,
        created_at,
        snapshot_id,
        contents,
    })
    .map_err(encoding_error)?;
    if encoded.len() > MAX_BYTES {
        return Err(LIMIT_ERROR.into());
    }
    Ok(encoded)
}

pub async fn export_native_migration(
    db: State<'_, Db>,
    pins: Option<Value>,
) -> Result<String, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export(&db, pins))
        .await
        .map_err(|_| "No se pudo preparar la copia de la biblioteca.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn populated_library() -> Db {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.0.lock().unwrap().execute_batch(
            "INSERT INTO tracks VALUES
                 (101,'Volver',196,0,52,'Música',80,'Sesiones',52,'https://example.org/cover'),
                 (250000000000001,'Vídeo',270,0,0,'Canal',250000000000001,'YouTube',0,NULL),
                 (750000000000001,'Un episodio',600,0,500000000000001,'Radio',500000000000001,'Radio',500000000000001,NULL),
                 (1000000000000001,'Mi archivo',192,0,0,'Artista',0,'Local',0,'file:///data/user/0/private.jpg');
             INSERT INTO liked_tracks VALUES (101,101), (1000000000000001,102);
             INSERT INTO saved_albums VALUES (80,'Sesiones',52,'Música',NULL,'2020',NULL,103);
             INSERT INTO saved_artists VALUES (52,'Música','https://example.org/photo?token=remove-me',104);
             INSERT INTO playlists VALUES (1,'Viaje',100,102), (2,'Al llegar',100,101);
             INSERT INTO playlist_tracks VALUES
                 (1,1,101,0,110), (2,1,1000000000000001,1,111), (3,1,101,2,112), (4,2,250000000000001,0,113);
             INSERT INTO history VALUES (1,101,120), (2,101,120);
             INSERT INTO youtube_tracks VALUES (250000000000001,'TestVideo01',100,1);
             INSERT INTO sources VALUES (101,'ChosenID123','Grabación','Canal',196,100,1,130);
             INSERT INTO sources VALUES (999,'Unknown001A','No hay pista','Canal',196,100,1,130);
             INSERT INTO podcast_shows VALUES
                 (1,'https://example.org/feed','Radio','Radio','Una descripción',NULL,'es'),
                 (2,'https://example.org/feed?access_token=remove-me','Privado','Privado','Otra descripción',NULL,'es');
             INSERT INTO saved_podcasts VALUES (1,100), (2,100);
             INSERT INTO podcast_episodes VALUES
                 (1,1,'regular-guid','https://example.org/episode'),
                 (2,1,'pending-guid','https://example.org/next?X-Amz-Signature=remove-me'),
                 (3,1,'https://example.org/third?token=remove-me','https://example.org/third'),
                 (4,2,'private-guid','https://example.org/episode');
             INSERT INTO podcast_progress VALUES
                 (1,120,600,0,104), (2,10.25,350,0,105), (3,10,0,0,106), (4,33,42,0,110);
             INSERT INTO downloads VALUES (101,'/data/user/0/private.webm',1024,'ChosenID123',130);
             INSERT INTO settings VALUES ('download_dir','/data/user/0/private-folder');",
        ).unwrap();
        db
    }

    #[test]
    fn exports_references_and_retries_without_exposing_private_data() {
        let db = populated_library();
        let pins = json!([
            {"kind": "playlist", "id": 1},
            {"kind": "album", "id": 80},
            {"kind": "album", "id": 800},
            {"kind": "playlist", "id": 1}
        ]);
        let encoded = export(&db, Some(pins.clone())).unwrap();
        assert!(!encoded.contains("remove-me"));
        assert!(!encoded.contains("private.webm"));
        assert!(!encoded.contains("private-folder"));
        assert!(!encoded.contains("file:///"));
        let value: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["format"], "pletina-native-migration");
        assert_eq!(value["library"]["tracks"].as_array().unwrap().len(), 3);
        assert_eq!(value["library"]["playlists"][0]["id"], 2);
        assert_eq!(value["library"]["entries"][1]["position"], 1);
        assert_eq!(value["library"]["entries"][1]["entryId"], 3);
        assert_eq!(value["library"]["history"].as_array().unwrap().len(), 2);
        assert_eq!(value["library"]["episodes"][0]["guid"], "regular-guid");
        assert_eq!(value["library"]["progress"][0]["position"], 120.0);
        assert_eq!(
            value["library"]["sources"][0]["choice"]["videoId"],
            "ChosenID123"
        );
        assert_eq!(
            value["library"]["artists"][0]["value"]["picture"],
            Value::Null
        );
        assert_eq!(
            value["downloads"],
            json!([{"trackId":101, "title":"Volver", "artistName":"Música"}])
        );
        assert_eq!(value["pendingPodcastProgress"][0]["position"], 10.25);
        assert_eq!(
            value["pendingPodcastProgress"][0]["feedUrl"],
            "https://example.org/feed"
        );
        assert_eq!(value["pendingPodcastProgress"][0]["guid"], "pending-guid");
        assert_eq!(value["preferences"]["pins"].as_array().unwrap().len(), 2);
        assert_eq!(value["exclusions"]["unportablePins"], 2);
        assert_eq!(value["exclusions"]["unportablePodcastProgress"], 2);
        assert_eq!(value["exclusions"]["unportableSources"], 1);
        assert_eq!(value["exclusions"]["localPlaylistEntries"], 1);
        assert_eq!(value["exclusions"]["localTracks"], 1);
        assert_eq!(value["exclusions"]["localLikes"], 1);
        assert_eq!(value["exclusions"]["nativeSettings"], 1);
        assert_eq!(value["snapshotId"].as_str().unwrap().len(), 64);
        let repeated: Value = serde_json::from_str(&export(&db, Some(pins)).unwrap()).unwrap();
        assert_eq!(repeated["snapshotId"], value["snapshotId"]);
        let retained_rows: u32 =
            db.0.lock()
                .unwrap()
                .query_row("SELECT count(*) FROM playlist_tracks", [], |r| r.get(0))
                .unwrap();
        assert_eq!(retained_rows, 4);
        if let Some(path) = std::env::var_os("PLETINA_NATIVE_MIGRATION_FIXTURE") {
            std::fs::write(path, encoded).unwrap();
        }
    }

    #[test]
    fn checks_collection_limits_before_serializing() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.0.lock()
            .unwrap()
            .execute_batch(
                "WITH RECURSIVE ids(id) AS (
                 SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<1001
             ) INSERT INTO playlists (id,name) SELECT id,'Lista' FROM ids;",
            )
            .unwrap();
        assert_eq!(export(&db, None).unwrap_err(), LIMIT_ERROR);
    }
}
