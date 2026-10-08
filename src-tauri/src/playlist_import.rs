//! Lectura y búsqueda de listas externas. La biblioteca solo cambia al guardar la revisión.

use crate::deezer::Deezer;
use crate::library::LibTrack;
use crate::spotify::{self, ImportSource, ImportTrack};
use tauri::State;

const MAX_CSV_BYTES: usize = 10 * 1024 * 1024;
const MAX_TRACKS: usize = 10_000;

#[tauri::command]
pub async fn read_spotify_playlist(url: String) -> Result<ImportSource, String> {
    spotify::read_playlist(&url).await
}

#[tauri::command]
pub fn read_playlist_csv(content: String, name: String) -> Result<ImportSource, String> {
    parse_csv(&content, &name)
}

#[tauri::command]
pub async fn match_import_track(track: ImportTrack, deezer: State<'_, Deezer>) -> Result<Option<LibTrack>, String> {
    if track.title.trim().is_empty() || track.title.len() > 2000 || track.artists.is_empty()
        || track.artists.len() > 100 || track.artists.iter().any(|a| a.trim().is_empty() || a.len() > 1000)
        || track.isrc.as_ref().is_some_and(|code| code.len() > 100)
    {
        return Err("Los datos de la canción no son válidos".into());
    }
    deezer.match_import_track(&track.title, &track.artists, track.duration_ms, track.isrc.as_deref()).await
}

fn header(value: &str) -> String {
    value.trim_start_matches('\u{feff}').chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn column(headers: &[String], names: &[&str]) -> Option<usize> {
    names.iter().find_map(|name| headers.iter().position(|h| h == name))
}

fn parse_csv(content: &str, name: &str) -> Result<ImportSource, String> {
    if content.len() > MAX_CSV_BYTES {
        return Err("El CSV supera los 10 MB. Divide la lista en varios archivos.".into());
    }
    let content = content.trim_start_matches('\u{feff}');
    // El formato habitual de Exportify y otros exportadores usa coma; Excel puede usar punto y coma.
    let mut selected = None;
    for delimiter in [b',', b';', b'\t'] {
        let mut reader = csv::ReaderBuilder::new().delimiter(delimiter).from_reader(content.as_bytes());
        let Ok(raw) = reader.headers() else { continue };
        let headers: Vec<_> = raw.iter().map(header).collect();
        let title = column(&headers, &["trackname", "songname", "title", "name", "título", "titulo", "canción", "cancion"]);
        let artist = column(&headers, &["artistnames", "artistname", "artists", "artist", "artistas", "artista"]);
        if let (Some(title), Some(artist)) = (title, artist) {
            selected = Some((reader, headers, title, artist));
            break;
        }
    }
    let Some((mut reader, headers, title, artist)) = selected else {
        return Err("El CSV debe incluir las columnas «Track Name» y «Artist Name(s)» (también «Title» y «Artist»).".into());
    };
    let duration = column(&headers, &["durationms", "trackdurationms"]);
    let isrc = column(&headers, &["isrc"]);
    let uri = column(&headers, &["trackuri", "spotifyuri", "uri", "trackurl"]);
    let local = column(&headers, &["islocal", "local"]);
    let mut tracks = Vec::new();
    let mut skipped = 0;
    let mut missing_duration = 0;
    for (index, row) in reader.records().enumerate() {
        if index >= MAX_TRACKS {
            return Err("El CSV supera las 10.000 filas. Divide la lista en varios archivos.".into());
        }
        let row = row.map_err(|_| format!("No se pudo leer la fila {} del CSV. Comprueba las comillas y el número de columnas.", index + 2))?;
        let value = |index: Option<usize>| index.and_then(|i| row.get(i)).unwrap_or("").trim();
        let title = value(Some(title));
        let artist = value(Some(artist));
        let uri = value(uri);
        if title.is_empty() || artist.is_empty() || uri.starts_with("spotify:episode:")
            || uri.contains("open.spotify.com/episode/") || uri.starts_with("spotify:local:")
            || value(local).eq_ignore_ascii_case("true")
        {
            skipped += 1;
            continue;
        }
        if title.len() > 2000 || artist.len() > 10_000 {
            return Err(format!("El título o los artistas de la fila {} son demasiado largos.", index + 2));
        }
        // Exportify separa artistas con ';'. Una coma puede ser parte del nombre de un artista.
        let artists: Vec<_> = artist.split(';').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
        if artists.is_empty() || artists.len() > 100 || artists.iter().any(|a| a.len() > 1000) {
            skipped += 1;
            continue;
        }
        let duration_text = value(duration);
        let duration_ms = duration_text.parse::<u64>().ok().filter(|n| *n > 0 && *n <= 86_400_000);
        if !duration_text.is_empty() && duration_ms.is_none() { missing_duration += 1; }
        let isrc = value(isrc);
        if isrc.len() > 100 {
            return Err(format!("El ISRC de la fila {} es demasiado largo. Corrígelo o vacía esa celda.", index + 2));
        }
        tracks.push(ImportTrack {
            title: title.into(), artists, duration_ms,
            isrc: if isrc.is_empty() { None } else { Some(isrc.into()) },
        });
    }
    if tracks.is_empty() {
        return Err("El CSV no contiene canciones con título y artista. Los episodios y archivos locales no se importan.".into());
    }
    let mut warnings = Vec::new();
    if skipped > 0 {
        warnings.push(format!("Se han omitido {skipped} filas sin título o artista, episodios o archivos locales."));
    }
    if missing_duration > 0 {
        warnings.push(format!("{missing_duration} canciones tienen una duración no válida; se buscarán por título y artista."));
    }
    let name = name.trim();
    let name = name.strip_suffix(".csv").or_else(|| name.strip_suffix(".CSV")).unwrap_or(name).trim();
    Ok(ImportSource {
        name: if name.is_empty() { "Importada de Spotify".into() } else { name.chars().take(100).collect() },
        tracks, skipped, warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exportify_preserves_order_duplicates_quotes_and_artist_commas() {
        let csv = "\u{feff}Track URI,Track Name,Artist Name(s),Duration (ms),ISRC\r\nspotify:track:a,\"Song, \"\"one\"\"\",\"Tyler, The Creator;Guest\",180500,USABC1234567\r\nspotify:track:b,Other,Band,190000,\r\nspotify:track:a,\"Song, \"\"one\"\"\",\"Tyler, The Creator;Guest\",180500,USABC1234567\r\n";
        let source = parse_csv(csv, "Mi lista.csv").unwrap();
        assert_eq!(source.name, "Mi lista");
        assert_eq!(source.tracks.len(), 3);
        assert_eq!(source.tracks[0].title, "Song, \"one\"");
        assert_eq!(source.tracks[0].artists, ["Tyler, The Creator", "Guest"]);
        assert_eq!(source.tracks[0].duration_ms, Some(180500));
        assert_eq!(source.tracks[0].isrc.as_deref(), Some("USABC1234567"));
        assert_eq!(source.tracks[1].title, "Other");
        assert_eq!(source.tracks[2].title, source.tracks[0].title);
    }

    #[test]
    fn alternative_delimiters_and_multiline_titles() {
        for csv in ["Title;Artist\n\"One\nTwo\";Björk\n", "Title\tArtist\n\"One\nTwo\"\tBjörk\n"] {
            let source = parse_csv(csv, "").unwrap();
            assert_eq!(source.tracks[0].title, "One\nTwo");
            assert_eq!(source.tracks[0].artists, ["Björk"]);
            assert_eq!(source.tracks[0].duration_ms, None);
        }
    }

    #[test]
    fn reports_unsupported_rows_and_invalid_duration() {
        let source = parse_csv("Track URI,Track Name,Artist Name(s),Duration (ms)\nspotify:track:a,Yes,Band,invalid\nspotify:episode:b,Episode,Host,120000\nspotify:local:c,Local,Me,1000\nspotify:track:d,,Band,123\n", "test").unwrap();
        assert_eq!(source.tracks.len(), 1);
        assert_eq!(source.skipped, 3);
        assert_eq!(source.warnings.len(), 2);
    }

    #[test]
    fn rejects_missing_headers_empty_malformed_and_oversize_csv() {
        for csv in ["", "Track URI\nspotify:track:a", "Title,Artist\n", "Title,Artist\nMissing,Artist,Extra\n"] {
            assert!(parse_csv(csv, "test").is_err());
        }
        assert!(parse_csv(&"x".repeat(MAX_CSV_BYTES + 1), "test").is_err());
        assert!(parse_csv(&format!("Title,Artist\n{}", "a,b\n".repeat(MAX_TRACKS + 1)), "test").is_err());
        assert!(parse_csv(&format!("Title,Artist,ISRC\na,b,{}\n", "x".repeat(101)), "test").is_err());
    }
}
