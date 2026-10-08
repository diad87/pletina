// Real release source, without Tauri/UI. Uses the bundled recipe, no user database.
#![allow(dead_code, unexpected_cfgs)]
#[path = "../../../../src-tauri/src/native.rs"]
mod native;
#[path = "../../../../src-tauri/src/youtube.rs"]
mod youtube;
#[path = "../../../../src-tauri/src/ytdlp.rs"]
mod ytdlp;
mod extractors {
    pub fn bundled_recipe() -> &'static str {
        include_str!("../../../../src-tauri/recipe/youtube.json")
    }
}

use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::main]
async fn main() {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap();
    let mut rows = Vec::new();
    let ytm = youtube::YouTubeMusic::new();
    let mut ids: Vec<String> = ["jNY_wLukVW0", "nV-F1WSpJIA", "q9IjQAef8VI", "oolpPmuK2I8"].iter().map(|s| s.to_string()).collect();
    for query in ["Radiohead Airbag", "Estopa Sucede", "Berri Txarrak Zuri", "Rosalía Malamente"] {
        let start = Instant::now();
        let row = match ytm.search_songs(query).await {
            Ok(songs) => {
                if let Some(s) = songs.first() { if !ids.contains(&s.video_id) { ids.push(s.video_id.clone()); } }
                json!({"kind":"search", "query":query, "count":songs.len(), "first":songs.first().map(|s| (&s.title, &s.video_id)), "ok":!songs.is_empty(), "ms":start.elapsed().as_millis()})
            },
            Err(e) => json!({"kind":"search", "query":query, "ok":false, "error":e, "ms":start.elapsed().as_millis()}),
        };
        println!("{row}"); rows.push(row);
    }
    for id in ids {
        let start = Instant::now();
        let row = match native::resolve(&id, true).await {
            Ok(audio) => {
                let len = ytdlp::query_param(&audio.url,"clen").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                let mut probes = Vec::new();
                for percent in [0u64, 50, 80, 95] {
                    let at = len * percent / 100;
                    let sample = match http.get(&audio.url).header("Range",format!("bytes={at}-{}",at+4095)).send().await {
                        Ok(response) => {
                            let status = response.status().as_u16();
                            let content_type = response.headers().get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("").to_string();
                            match response.bytes().await {
                                Ok(bytes) => json!({"percent":percent,"status":status,"bytes":bytes.len(),"type":content_type,"ok":matches!(status,200|206)&&!bytes.is_empty()}),
                                Err(e) => json!({"percent":percent,"ok":false,"error":e.to_string()}),
                            }
                        },
                        Err(e) => json!({"percent":percent,"ok":false,"error":e.to_string()}),
                    };
                    probes.push(sample);
                }
                let cached = native::resolve(&id,false).await.is_ok();
                json!({"kind":"stream", "video":id,"title":audio.title,"client":audio.client,"mime":audio.mime,"length":len,"ok":cached&&probes.iter().all(|p|p["ok"]==true),"cached_ok":cached,"probes":probes,"ms":start.elapsed().as_millis()})
            },
            Err(e) => json!({"kind":"stream", "video":id,"ok":false,"error":e.to_string(),"ms":start.elapsed().as_millis()}),
        };
        println!("{row}"); rows.push(row);
    }
    let start = Instant::now();
    let unavailable = native::resolve("xxxxxxxxxxx",true).await;
    let row = json!({"kind":"unavailable", "ok":unavailable.is_err(),"error":unavailable.err().map(|e|e.to_string()),"ms":start.elapsed().as_millis()});
    println!("{row}"); rows.push(row);
    if let Some(path) = std::env::args().nth(1) { std::fs::write(path, serde_json::to_string_pretty(&rows).unwrap()).unwrap(); }
    if rows.iter().any(|r|r["ok"]!=true) { std::process::exit(1); }
}
