#!/usr/bin/env python3
"""Exercise the packaged Linux WebKit player with isolated audio and application data.

Requires ffmpeg, Xvfb, pulseaudio, WebKitWebDriver and tauri-driver. No Python
packages or external media services are needed. See README.md, Desarrollo.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


FORMATS = ("wav", "mp3", "flac", "ogg", "m4a", "opus")
DOWNLOAD_ID = 999999124


def require(name):
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Missing test dependency: {name}")
    return path


def port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def wait_for(predicate, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    raise TimeoutError("Test service did not become ready")


class Driver:
    def __init__(self, address):
        self.address = address
        self.session = None
        # Ignore shell proxy variables for our private WebDriver connection.
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, path, data=None):
        request = urllib.request.Request(
            self.address + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json"}, method=method,
        )
        try:
            with self.http.open(request, timeout=120) as response:
                result = json.load(response)["value"]
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
        return result

    def start(self, application):
        result = self.request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "tauri:options": {"application": str(application)},
        }}})
        self.session = result["sessionId"]
        self.request("POST", f"/session/{self.session}/timeouts", {"script": 110000})
        return result["capabilities"]

    def stop(self):
        if self.session:
            self.request("DELETE", f"/session/{self.session}")
            self.session = None

    def execute(self, script, args=None, asynchronous=False):
        kind = "async" if asynchronous else "sync"
        return self.request("POST", f"/session/{self.session}/execute/{kind}", {
            "script": script, "args": args or [],
        })

    def screenshot(self, destination):
        encoded = self.request("GET", f"/session/{self.session}/screenshot")
        destination.write_bytes(base64.b64decode(encoded))


PLAYBACK = r"""
const done=arguments[arguments.length-1];
(async()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async predicate=>{
    for(let i=0;i<100;i++){if(predicate())return;await wait(200);}
    throw new Error('UI did not reach expected state');
  };
  const original=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(...args){
    window.__linuxTestAudio=this;this.muted=true;return original.apply(this,args);
  };
  await until(()=>[...document.querySelectorAll('.sidebar button')].some(b=>b.innerText.includes('Tu música')));
  [...document.querySelectorAll('.sidebar button')].find(b=>b.innerText.includes('Tu música')).click();
  await until(()=>document.querySelector('.grid .card button.hit[title="Linux audio fixtures"]'));
  document.querySelector('.grid .card button.hit[title="Linux audio fixtures"]').click();
  await until(()=>document.querySelectorAll('.tracks .row[role="button"]').length===6);

  async function check(title, seekTo){
    const row=[...document.querySelectorAll('.tracks .row[role="button"]')].find(r=>r.querySelector('.name')?.textContent===title);
    if(!row)throw new Error('Missing track: '+title);
    const previous=window.__linuxTestAudio;
    row.click();
    await until(()=>window.__linuxTestAudio&&window.__linuxTestAudio!==previous);
    await until(()=>window.__linuxTestAudio.error||(window.__linuxTestAudio.readyState>=3&&window.__linuxTestAudio.currentTime>.5&&!window.__linuxTestAudio.paused));
    const a=window.__linuxTestAudio;
    const result={title,currentTime:a?.currentTime,readyState:a?.readyState,error:a?.error?.message??null,
      sourceHost:a?.src?new URL(a.src).hostname:null,playingIndicator:!!document.querySelector('.tracks .current [aria-label="Sonando"]')};
    const seek=document.querySelector('input[aria-label="Posición"]');
    seek.value=String(seekTo);seek.dispatchEvent(new Event('input',{bubbles:true}));seek.dispatchEvent(new Event('change',{bubbles:true}));
    await until(()=>a.currentTime>seekTo+.3&&!a.seeking);result.seekTime=a?.currentTime;
    document.querySelector('.transport button.play').click();await until(()=>a.paused);result.pauseWorks=a?.paused===true;
    const pausedTime=a?.currentTime;await wait(300);result.pauseHolds=Math.abs((a?.currentTime??0)-pausedTime)<.1;
    document.querySelector('.transport button.play').click();await until(()=>!a.paused&&a.currentTime>pausedTime+.3);result.resumeWorks=true;
    result.pass=result.currentTime>.5&&result.readyState>=3&&!result.error&&result.playingIndicator&&result.sourceHost==='127.0.0.1'
      &&result.seekTime>seekTo+.3&&result.pauseWorks&&result.pauseHolds&&result.resumeWorks;
    return result;
  }
  const local=[];
  for(const ext of ['wav','mp3','flac','ogg','m4a','opus'])local.push(await check('Fixture '+ext,6));
  [...document.querySelectorAll('.sidebar button')].find(b=>b.innerText.startsWith('Descargas')).click();
  await until(()=>[...document.querySelectorAll('.tracks .row .name')].some(n=>n.textContent==='Downloaded WebM fixture'));
  const download=await check('Downloaded WebM fixture',6);
  document.querySelector('.transport button.play').click();
  done({local,download,pass:local.every(r=>r.pass)&&download.pass,body:document.body.innerText});
})().catch(error=>done({pass:false,error:String(error),body:document.body.innerText}));
"""


def run(image, output):
    binaries = {name: require(name) for name in (
        "ffmpeg", "Xvfb", "pulseaudio", "WebKitWebDriver", "tauri-driver",
    )}
    processes, logs = [], []
    driver = None
    report = {"appimage": str(image), "sha256": hashlib.sha256(image.read_bytes()).hexdigest()}
    with tempfile.TemporaryDirectory(prefix="pletina-linux-playback-") as temporary:
        root = Path(temporary)

        def launch(name, command, env, **options):
            log = (output / f"{name}.log").open("wb")
            logs.append(log)
            child = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, **options)
            processes.append(child)
            return child

        try:
            subprocess.run([str(image), "--appimage-extract"], cwd=root, check=True, stdout=subprocess.DEVNULL)
            appdir = root / "squashfs-root"
            fixture = root / "music with spaces"
            fixture.mkdir()
            for extension in (*FORMATS, "webm"):
                subprocess.run([
                    binaries["ffmpeg"], "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=12", "-metadata", f"title=Fixture {extension}",
                    "-metadata", "artist=Pletina QA", "-metadata", "album=Linux audio fixtures",
                    str(fixture / f"tone.{extension}"),
                ], check=True)

            env = os.environ.copy()
            for key, directory in (("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"),
                                   ("XDG_CONFIG_HOME", "config"), ("XDG_RUNTIME_DIR", "runtime")):
                path = root / directory
                path.mkdir(mode=0o700)
                env[key] = str(path)
            # The wrapper needs these utilities; no host JavaScript runtime is exposed.
            command_path = root / "path"
            command_path.mkdir()
            for name in ("bash", "dirname", "readlink", "realpath", "dbus-send", "gsettings", "tail", "cut", "env", "WebKitWebDriver"):
                (command_path / name).symlink_to(require(name))
            env["PATH"] = str(command_path)
            assert shutil.which("node", path=env["PATH"]) is None
            env["APPDIR"] = str(appdir)  # Set by the AppImage runtime during ordinary launches.
            env["GDK_BACKEND"] = "x11"
            env["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
            env.pop("WAYLAND_DISPLAY", None)
            if os.geteuid() == 0:
                env["WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"] = "1"
            node = next(appdir.glob("usr/lib/*/bin/node"))
            report["bundledNode"] = subprocess.check_output([str(node), "--version"], env=env, text=True).strip()
            report["nodeOnPath"] = False

            display_number = next(number for number in range(90, 1000) if not Path(f"/tmp/.X{number}-lock").exists())
            env["DISPLAY"] = f":{display_number}"
            display_env = {**env, "PATH": os.defpath}
            display = launch("xvfb", [binaries["Xvfb"], env["DISPLAY"], "-screen", "0", "1440x960x24", "-nolisten", "tcp"], display_env)
            wait_for(lambda: Path(f"/tmp/.X{display_number}-lock").exists() and display.poll() is None)

            pulse_socket = root / "pulse.sock"
            env["PULSE_SERVER"] = "unix:" + str(pulse_socket)
            launch("pulseaudio", [binaries["pulseaudio"], "-n", "--daemonize=no", "--exit-idle-time=-1", "--disable-shm=yes",
                                 "--load=module-null-sink sink_name=pletina_test",
                                 f"--load=module-native-protocol-unix socket={pulse_socket} auth-anonymous=1"], env)
            wait_for(pulse_socket.exists)

            driver_port = port()
            launch("webdriver", [binaries["tauri-driver"], "--port", str(driver_port), "--native-port", str(port()),
                                 "--native-driver", binaries["WebKitWebDriver"]], env)
            driver = Driver(f"http://127.0.0.1:{driver_port}")

            def ready():
                try:
                    return driver.request("GET", "/status")["ready"]
                except (OSError, RuntimeError):
                    return False
            wait_for(ready)
            report["webview"] = driver.start(appdir / "AppRun")
            database = Path(env["XDG_DATA_HOME"]) / "dev.musify.desktop" / "musify.db"
            wait_for(database.exists)
            driver.stop()
            with sqlite3.connect(database) as connection:
                connection.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)", ("local_folders", json.dumps([str(fixture)])))
                connection.execute("INSERT OR REPLACE INTO tracks(id,title,duration,explicit,artist_id,artist_name,album_id,album_title,album_artist_id,cover) VALUES (?,?,?,?,?,?,?,?,?,?)",
                                   (DOWNLOAD_ID, "Downloaded WebM fixture", 12, 0, DOWNLOAD_ID, "Pletina QA", DOWNLOAD_ID, "Offline QA", DOWNLOAD_ID, None))
                connection.execute("INSERT OR REPLACE INTO downloads(track_id,path,size,video_id) VALUES (?,?,?,?)",
                                   (DOWNLOAD_ID, str(fixture / "tone.webm"), (fixture / "tone.webm").stat().st_size, "fixture"))
            driver.start(appdir / "AppRun")
            report["playback"] = driver.execute(PLAYBACK, asynchronous=True)
            driver.screenshot(output / "playback.png")
            if not report["playback"]["pass"]:
                raise AssertionError("Packaged WebKit playback regression failed")
            report["pass"] = True
        except Exception as error:
            report["pass"] = False
            report["error"] = str(error)
            if driver and driver.session:
                try:
                    driver.screenshot(output / "failure.png")
                except Exception:
                    pass
            raise
        finally:
            (output / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
            if driver:
                try:
                    driver.stop()
                except Exception:
                    pass
            for child in reversed(processes):
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            for log in logs:
                log.close()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appimage", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("target/linux-playback-test"))
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary = run(args.appimage.resolve(), args.output_dir.resolve())
    print(f"Linux packaged playback PASS: 6 local formats + downloaded WebM, seek, pause and resume. Evidence: {args.output_dir}")
