// Audit-only runner: compile actual db.rs with existing dependency artifacts, without Cargo/Tauri.
// node scripts/tests/audit-db.mjs <output-dir> <existing-cargo-target>
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const output = resolve(process.argv[2])
const target = resolve(process.argv[3])
await mkdir(output, { recursive: true })
const hash = (value) => createHash('sha256').update(value).digest('hex')
const git = (...args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
}
const manifest = { commit: git('rev-parse', 'HEAD').trim(), fixtureSchemas: [], source: {} }
manifest.source.dbSha256 = hash(await readFile(join(root, 'src-tauri/src/db.rs')))
for (const tag of ['v0.9.0', 'v0.9.1']) {
  const source = git('show', `${tag}:src-tauri/src/db.rs`)
  const block = source.slice(source.indexOf('const MIGRATIONS'), source.indexOf('\n];') + 3)
  const migrations = [...block.matchAll(/^\s*"([\s\S]*?)",?\s*$/gm)].map((m) => m[1])
  assert.equal(migrations.length, 5, `Expected historical schema5 in ${tag}`)
  const sql = 'PRAGMA foreign_keys=ON;\n' + migrations.join('\n') + '\nPRAGMA user_version=5;\n'
  await writeFile(join(output, `schema-${tag}.sql`), sql)
  manifest.fixtureSchemas.push({ tag, migrations: migrations.length, sourceSha256: hash(source), sqlSha256: hash(sql) })
}
await writeFile(join(output, 'fixture.webm'), Buffer.from('Synthetic download bytes preserved during migration; not an audio decoder fixture.'))
const download = join(output, 'fixture.webm').replaceAll("'", "''")
await writeFile(join(output, 'seed.sql'), `
INSERT INTO sources (track_id,video_id,title,channel,duration,score,verified,updated_at) VALUES
 (7,'chosen-video','Track 7','Fixture',180,99,1,1700000001), (8,'other-video','Track 8','Fixture',200,70,0,1700000002);
INSERT INTO tracks (id,title,duration,explicit,artist_id,artist_name,album_id,album_title,album_artist_id,cover) VALUES
 (7,'Track 7',180,0,1,'Fixture artist',2,'Fixture album',1,'https://example.invalid/cover'),
 (8,'Track 8',200,1,1,'Fixture artist',2,'Fixture album',1,NULL);
INSERT INTO liked_tracks VALUES (7,1700000000);
INSERT INTO saved_albums VALUES (2,'Fixture album',1,'Fixture artist',NULL,'2020-01-01','album',1700000000);
INSERT INTO playlists VALUES (1,'Repeated entries',1700000000,1700000001);
INSERT INTO playlist_tracks VALUES (10,1,7,0,1700000000),(11,1,8,1,1700000000),(12,1,7,2,1700000000);
INSERT INTO history VALUES (3,7,1700000000),(4,7,1700000001),(5,8,1700000002);
INSERT INTO downloads VALUES (7,'${download}',80,'chosen-video',1700000000);
INSERT INTO settings VALUES ('keep','value'),('volume','0.42'),('download_dir','fixture-directory');
INSERT INTO local_artists (id,name,key) VALUES (1,'Fixture local artist','fixture-local-artist');
INSERT INTO local_albums (id,title,artist_id,key) VALUES (1,'Fixture local album',1,'fixture-local-album');
INSERT INTO local_tracks (id,path,title,artist_id,album_id,track_no,disc_no,duration,mtime,size) VALUES (1,'fixture-local.flac','Fixture local',1,1,2,1,100,1700000000,1024);
INSERT INTO podcast_shows VALUES (1,'https://example.invalid/feed.xml','Fixture RSS program','Fixture author','Description',NULL,'es'),
 (2,'youtube:fixture-playlist','Fixture YouTube program','Fixture author','Description',NULL,NULL);
INSERT INTO podcast_episodes VALUES (1,1,'fixture-guid','https://example.invalid/audio.mp3'),(2,2,'fixture-video','youtube:fixture-video');
`)
manifest.downloadBeforeSha256 = hash(await readFile(join(output, 'fixture.webm')))
const deps = join(target, 'debug/deps')
const depFiles = await readdir(deps)
const find = (name) => {
  const values = depFiles.filter((file) => file.startsWith(`lib${name}-`) && file.endsWith('.rlib')).sort()
  assert.ok(values.length, `Compiled dependency missing: ${name}`)
  return join(deps, values.at(-1))
}
const native = []
const build = join(target, 'debug/build')
for (const file of await readdir(build)) if (file.startsWith('libsqlite3-sys-') && existsSync(join(build, file, 'out/sqlite3.lib'))) native.push(join(build, file, 'out'))
assert.equal(native.length, 1, 'Expected one cached SQLite native build')
const rustc = join(homedir(), '.cargo/bin/rustc.exe')
const binary = join(output, 'audit-db.exe')
const compileArgs = ['--edition=2024', join(root, 'scripts/tests/core-db/main.rs'), '-L', `dependency=${deps}`, '-L', `native=${native[0]}`, '--extern', `rusqlite=${find('rusqlite')}`, '--extern', `serde_json=${find('serde_json')}`, '-o', binary]
const compiled = spawnSync(rustc, compileArgs, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 })
await writeFile(join(output, 'db-build.log'), (compiled.stdout ?? '') + (compiled.stderr ?? ''))
manifest.compile = { executable: rustc, args: compileArgs, status: compiled.status, error: compiled.error?.message }
await writeFile(join(output, 'db-manifest.json'), JSON.stringify(manifest, null, 2))
assert.equal(compiled.status, 0, compiled.stderr)
const result = spawnSync(binary, [output], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 })
await writeFile(join(output, 'db.log'), (result.stdout ?? '') + (result.stderr ?? ''))
manifest.execute = { status: result.status, error: result.error?.message }
manifest.downloadAfterSha256 = hash(await readFile(join(output, 'fixture.webm')))
assert.equal(manifest.downloadBeforeSha256, manifest.downloadAfterSha256)
await writeFile(join(output, 'db-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(result.stdout)
console.log(`DB harness exit: ${result.status}; logs: ${output}`)
process.exitCode = result.status ?? 2
