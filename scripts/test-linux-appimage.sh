#!/usr/bin/env bash
# Decode actual files with the libraries and plugins carried by the AppImage.
# Host plugins are deliberately excluded: otherwise missing bundle files can pass CI.
set -euo pipefail
if [[ $# != 1 ]]; then
  echo "Usage: $0 path/to/Pletina.AppImage" >&2
  exit 2
fi
appimage=$(realpath "$1")
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
chmod +x "$appimage"
(cd "$scratch" && "$appimage" --appimage-extract >/dev/null)
appdir="$scratch/squashfs-root"
plugins=$(find "$appdir/usr" -type d -name gstreamer-1.0 | paste -sd:)
scanner=$(find "$appdir/usr" -type f -name gst-plugin-scanner -print -quit)
node=$(find "$appdir/usr" -type f -path '*/bin/node' -print -quit)
[[ -n "$plugins" && -n "$scanner" && -n "$node" ]] || {
  echo 'AppImage is missing GStreamer plugins, its scanner, or the Node runtime' >&2
  exit 1
}
# Use FFmpeg only to create fixtures; playback below uses the bundled GStreamer.
for ext in wav mp3 flac ogg m4a webm; do
  ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:duration=1' "$scratch/tone.$ext"
done
export LD_LIBRARY_PATH="$appdir/usr/lib:$appdir/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GST_PLUGIN_PATH="$plugins" GST_PLUGIN_PATH_1_0="$plugins"
export GST_PLUGIN_SYSTEM_PATH='' GST_PLUGIN_SYSTEM_PATH_1_0=''
export GST_PLUGIN_SCANNER="$scanner" GST_PLUGIN_SCANNER_1_0="$scanner"
export GST_REGISTRY_1_0="$scratch/registry.bin"
# The CLI helpers are test tools from the build host, but their multimedia
# libraries must resolve inside the package too (not silently fall back to apt).
for tool in gst-launch-1.0 gst-inspect-1.0; do
  ldd "$(command -v "$tool")" | awk -v bundle="$appdir/" '
    /libgst/ { found = 1; if (index($3, bundle) != 1) { print "Host GStreamer dependency: " $0; bad = 1 } }
    END { if (!found || bad) exit 1 }
  '
done
"$node" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1); console.log("Bundled Node: " + process.version)'
for element in playbin decodebin uridecodebin filesrc typefind audioconvert audioresample autoaudiosink souphttpsrc; do
  gst-inspect-1.0 "$element" >/dev/null
done
for ext in wav mp3 flac ogg m4a webm; do
  timeout 30s gst-launch-1.0 -q uridecodebin "uri=file://$scratch/tone.$ext" ! audioconvert ! audioresample ! fakesink
  echo "AppImage decode OK: $ext"
done
