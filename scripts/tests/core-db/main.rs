//! Audit executable, linked directly against cached rusqlite. No product changes, no Tauri.
//! Db::open and every Db helper below are compiled from the current product source.
#[path = "../../../src-tauri/src/db.rs"]
mod db;

use db::{Db, Source};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::{Arc, Barrier}, time::Duration};

fn source(video: &str) -> Source {
    Source { video_id: video.into(), title: "Audit fixture".into(), channel: "Fixture".into(), duration: Some(180), score: 99, verified: true }
}
fn fixture(root: &Path, label: &str, schema: &str) -> PathBuf {
    let dir = root.join(label);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("musify.db");
    assert!(!path.exists(), "Each execution requires a fresh fixture directory");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&std::fs::read_to_string(root.join(schema)).unwrap()).unwrap();
    conn.execute_batch(&std::fs::read_to_string(root.join("seed.sql")).unwrap()).unwrap();
    path
}
fn value(conn: &Connection, sql: &str) -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() }
fn snapshot(conn: &Connection) -> BTreeMap<String, Vec<Vec<String>>> {
    let names = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap().map(Result::unwrap).collect::<Vec<_>>();
    names.into_iter().map(|name| {
        let mut statement = conn.prepare(&format!("SELECT * FROM \"{name}\"")).unwrap();
        let count = statement.column_count();
        let mut rows = statement.query_map([], |row| (0..count).map(|i| row.get_ref(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<Vec<_>>>()).unwrap().map(Result::unwrap).collect::<Vec<_>>();
        rows.sort();
        (name, rows)
    }).collect()
}
fn check_integrity(conn: &Connection) {
    assert_eq!(conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
    assert_eq!(conn.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none(), true);
}
fn migration(root: &Path, version: &str, label: &str) -> Value {
    let path = fixture(root, label, version);
    let before = snapshot(&Connection::open(&path).unwrap());
    let mut tables_checked = 0;
    for _ in 0..3 {
        let db = Db::open(&path).unwrap();
        let conn = db.0.lock().unwrap();
        assert_eq!(value(&conn, "PRAGMA user_version"), 7);
        let after = snapshot(&conn);
        for (table, contents) in &before { assert_eq!(&after[table], contents, "All values of {table} must survive"); tables_checked += 1; }
        check_integrity(&conn);
        assert_eq!(value(&conn, "SELECT COUNT(*) FROM saved_artists"), 0);
        assert_eq!(value(&conn, "SELECT COUNT(*) FROM youtube_tracks"), 0);
        assert_eq!(value(&conn, "SELECT COUNT(*) FROM saved_podcasts"), 0);
    }
    let backup = Connection::open(path.with_extension("db.antes-de-v7")).unwrap();
    assert_eq!(value(&backup, "PRAGMA user_version"), 5);
    assert_eq!(snapshot(&backup), before);
    json!({"reopens":3,"oldTables":before.len(),"tableComparisons":tables_checked,"backupSchema":5,"integrity":"ok"})
}

fn run(tests: &mut Vec<Value>, id: &str, name: &str, action: impl FnOnce() -> Value) {
    let start = std::time::Instant::now();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action));
    let row = match outcome {
        Ok(details) => json!({"id":id,"test":name,"status":"pass","details":details,"milliseconds":start.elapsed().as_millis()}),
        Err(error) => {
            let message = error.downcast_ref::<String>().cloned().or_else(|| error.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into());
            json!({"id":id,"test":name,"status":"fail","error":message,"milliseconds":start.elapsed().as_millis()})
        }
    };
    println!("{row}");
    tests.push(row);
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).is_some_and(|s| s == "--wal-child") {
        let conn = Connection::open(&args[2]).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            INSERT INTO settings VALUES ('wal-committed', 'survives');
            BEGIN IMMEDIATE; INSERT INTO settings VALUES ('wal-uncommitted', 'must-disappear');").unwrap();
        // Intentionally skips destructors/Connection::drop: emulates process loss with live WAL.
        std::process::exit(0);
    }
    let root = PathBuf::from(args.get(1).expect("fixture root required"));
    let mut tests = Vec::new();
    run(&mut tests, "CORE-DB-001", "v0.9.0 schema5 ->7 preserves every value, backup and three reopenings", || migration(&root, "schema-v0.9.0.sql", "migration-090"));
    run(&mut tests, "CORE-DB-001", "v0.9.1 schema5 ->7 preserves every value, backup and three reopenings", || migration(&root, "schema-v0.9.1.sql", "migration-091"));

    run(&mut tests, "CORE-DB-003", "committed WAL survives abrupt child exit and is included in the pre-migration backup", || {
        let path = fixture(&root, "wal-recovery", "schema-v0.9.1.sql");
        assert!(std::process::Command::new(std::env::current_exe().unwrap()).arg("--wal-child").arg(&path).status().unwrap().success());
        let wal = PathBuf::from(format!("{}-wal", path.display()));
        let wal_bytes = std::fs::metadata(&wal).unwrap().len();
        assert!(wal_bytes > 32);
        let db = Db::open(&path).unwrap();
        assert_eq!(db.setting("wal-committed").as_deref(), Some("survives"));
        assert_eq!(db.setting("wal-uncommitted"), None);
        check_integrity(&db.0.lock().unwrap());
        let backup = Connection::open(path.with_extension("db.antes-de-v7")).unwrap();
        assert_eq!(value(&backup, "PRAGMA user_version"), 5);
        assert_eq!(value(&backup, "SELECT COUNT(*) FROM settings WHERE key='wal-committed'"), 1);
        assert_eq!(value(&backup, "SELECT COUNT(*) FROM settings WHERE key='wal-uncommitted'"), 0);
        json!({"walBytesBeforeRecovery":wal_bytes,"committedPreserved":true,"uncommittedAbsent":true,"backupIncludesCommitted":true})
    });

    run(&mut tests, "CORE-DB-003", "backup destination failure prevents migration without modifying existing data", || {
        let path = fixture(&root, "backup-failure", "schema-v0.9.1.sql");
        let before = snapshot(&Connection::open(&path).unwrap());
        std::fs::create_dir(path.with_extension("db.antes-de-v7")).unwrap();
        let error = Db::open(&path).err().expect("backup directory collision must be rejected");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(value(&conn, "PRAGMA user_version"), 5);
        assert_eq!(snapshot(&conn), before);
        check_integrity(&conn);
        json!({"error":error.to_string(),"schemaUnchanged":5,"allDataUnchanged":true})
    });

    run(&mut tests, "CORE-DB-003", "failed schema migration rolls back its SQL and can be retried", || {
        let path = fixture(&root, "migration-failure", "schema-v0.9.1.sql");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE saved_artists (sentinel TEXT); INSERT INTO saved_artists VALUES ('collision fixture');").unwrap();
        }
        let error = Db::open(&path).err().expect("migration collision must fail");
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(value(&conn, "PRAGMA user_version"), 5);
            assert_eq!(value(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name='youtube_tracks'"), 0);
            assert_eq!(value(&conn, "SELECT COUNT(*) FROM liked_tracks"), 1);
            conn.execute_batch("DROP TABLE saved_artists;").unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(value(&db.0.lock().unwrap(), "PRAGMA user_version"), 7);
        json!({"firstError":error.to_string(),"partialMigrationAbsent":true,"retrySchema":7})
    });

    run(&mut tests, "CORE-DB-004", "corrupt existing database returns an error and preserves file bytes", || {
        let path = root.join("corrupt.db");
        let bytes = vec![0x7fu8; 8192];
        std::fs::write(&path, &bytes).unwrap();
        let error = Db::open(&path).err().expect("corruption must fail");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        json!({"error":error.to_string(),"bytesUnchanged":true})
    });

    run(&mut tests, "CORE-DB-004", "REGRESSION readonly source/settings/download helpers must not silently return success", || {
        let path = fixture(&root, "readonly-writes", "schema-v0.9.1.sql");
        let db = Db::open(&path).unwrap();
        db.0.lock().unwrap().execute_batch("PRAGMA query_only=ON;").unwrap();
        let control = db.0.lock().unwrap().execute("UPDATE settings SET value='changed' WHERE key='keep'", []).unwrap_err();
        assert_eq!(control.sqlite_error_code(), Some(rusqlite::ErrorCode::ReadOnly));
        let results = [
            ("set_setting", format!("{:?}", db.set_setting("keep", "changed"))),
            ("save_source", format!("{:?}", db.save_source(7, &source("replacement")))),
            ("forget_download", format!("{:?}", db.forget_download(7))),
            ("delete_source", format!("{:?}", db.delete_source(8))),
        ];
        let observed = json!({"controlError":control.to_string(),"returns":results,"setting":db.setting("keep"),"sourceVideo":db.source(7).unwrap().video_id,"download":db.download_path(7),"deletedSourceStillExists":db.source(8).is_some()});
        println!("OBSERVATION {observed}");
        assert!(results.iter().all(|(_, result)| result.starts_with("Err(")), "Rejected SQLite writes must report failure to the caller, rather than silently return (): {observed}");
        observed
    });

    run(&mut tests, "CORE-DB-004", "REGRESSION SQLITE_FULL is swallowed by the actual settings writer", || {
        let path = fixture(&root, "full-writes", "schema-v0.9.1.sql");
        let db = Db::open(&path).unwrap();
        let large = "x".repeat(1024 * 1024);
        let control;
        {
            let conn = db.0.lock().unwrap();
            let pages = value(&conn, "PRAGMA page_count");
            conn.execute_batch(&format!("PRAGMA max_page_count={pages};")).unwrap();
            control = conn.execute("INSERT INTO settings VALUES ('full-control', ?1)", params![large]).unwrap_err();
            assert_eq!(control.sqlite_error_code(), Some(rusqlite::ErrorCode::DiskFull));
        }
        let result = format!("{:?}", db.set_setting("full-product-call", &large));
        println!("OBSERVATION {}", json!({"controlError":control.to_string(),"returned":result,"persisted":db.setting("full-product-call").is_some()}));
        assert!(result.starts_with("Err("), "set_setting must report SQLITE_FULL; returned {result} while persistence failed");
        json!({})
    });

    run(&mut tests, "CORE-DB-004", "REGRESSION busy database is swallowed by the actual source writer", || {
        let path = fixture(&root, "busy-writes", "schema-v0.9.1.sql");
        let db = Db::open(&path).unwrap();
        db.0.lock().unwrap().busy_timeout(Duration::from_millis(20)).unwrap();
        let other = Connection::open(&path).unwrap();
        other.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let control = db.0.lock().unwrap().execute("UPDATE sources SET video_id='control' WHERE track_id=7", []).unwrap_err();
        assert_eq!(control.sqlite_error_code(), Some(rusqlite::ErrorCode::DatabaseBusy));
        let result = format!("{:?}", db.save_source(7, &source("replacement")));
        other.execute_batch("ROLLBACK;").unwrap();
        println!("OBSERVATION {}", json!({"controlError":control.to_string(),"returned":result,"videoId":db.source(7).unwrap().video_id}));
        assert!(result.starts_with("Err("), "save_source must report SQLITE_BUSY; returned {result} while persistence failed");
        json!({})
    });

    run(&mut tests, "CORE-DB-005", "shared Db connection serializes concurrent settings and selected-source writes", || {
        let path = fixture(&root, "concurrent-writes", "schema-v0.9.1.sql");
        let db = Db::open(&path).unwrap();
        let barrier = Arc::new(Barrier::new(5));
        let jobs = (0..4).map(|worker| {
            let db = db.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for n in 0..50 {
                    let id = 1000 + worker * 50 + n;
                    db.set_setting(&format!("concurrent-{id}"), &format!("value-{id}")).unwrap();
                    db.save_source(id, &source(&format!("video-{id}"))).unwrap();
                }
            })
        }).collect::<Vec<_>>();
        barrier.wait();
        for job in jobs { job.join().unwrap(); }
        drop(db);
        let reopened = Db::open(&path).unwrap();
        for id in 1000..1200 {
            assert_eq!(reopened.setting(&format!("concurrent-{id}")), Some(format!("value-{id}")));
            assert_eq!(reopened.source(id).unwrap().video_id, format!("video-{id}"));
        }
        check_integrity(&reopened.0.lock().unwrap());
        json!({"threads":4,"writes":400,"allValuesVerifiedAfterReopen":true,"scope":"Db helpers only; not the Tauri command transactions"})
    });
    let failures = tests.iter().filter(|row| row["status"] == "fail").count();
    let report = json!({"schemaVersion":1,"scope":"Actual db.rs and SQLite; synthetic profiles, no user data, no full Tauri app","tests":tests,"pass":tests.len()-failures,"fail":failures});
    std::fs::write(root.join("db-results.json"), serde_json::to_string_pretty(&report).unwrap()).unwrap();
    if failures > 0 { std::process::exit(1); }
}
