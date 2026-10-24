#!/usr/bin/env bash
# FFprobe 4.4/6.1 omit the first fragmented AAC packet's duration, and FFmpeg
# 4.4's setts filter lacks the duration option used by the tail regression.
# Build both test tools from immutable FFmpeg 8.1 source. They are not bundled:
# only Node/Rust test steps use this PATH; packaged playback uses Ubuntu's tools.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

# Official FFmpeg/FFmpeg annotated tag n8.1 resolves to this commit.
commit=9047fa1b084f76b1b4d065af2d743df1b40dfb56
source_sha256=d77341a08192916d4e7a3c5ba2481097b42747be8d61a03d897a537e4973702a
work=$(mktemp -d "$RUNNER_TEMP/pletina-test-ffmpeg.XXXXXX")
archive="$work/source.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 120 --max-filesize 33554432 \
  "https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/$commit" --output "$archive"
printf '%s  %s\n' "$source_sha256" "$archive" | sha256sum --check --strict
mkdir "$work/source" "$work/bin"
tar -xzf "$archive" -C "$work/source" --strip-components=1
cd "$work/source"
./configure \
  --disable-everything --disable-programs --enable-ffmpeg --enable-ffprobe \
  --enable-demuxer=mov,matroska --enable-decoder=aac,opus,pcm_s16le,pcm_f32le \
  --enable-libopus --enable-encoder=aac,libopus,pcm_f32le \
  --enable-indev=lavfi --enable-filter=sine,aresample,aformat,anull,atrim,asetpts \
  --enable-muxer=mov,mp4,ipod,matroska,webm,pcm_f32le --enable-bsf=setts \
  --enable-parser=aac,opus --enable-protocol=file,pipe \
  --disable-autodetect --disable-network --disable-doc --disable-debug \
  --disable-x86asm
make -j2 ffmpeg ffprobe
install -m755 ffmpeg ffprobe "$work/bin/"
"$work/bin/ffmpeg" -version
"$work/bin/ffprobe" -version
# Do not add these limited tools to GITHUB_PATH: packaged Linux playback tests
# intentionally probe more formats with Ubuntu's normal multimedia tools.
printf 'bin=%s\n' "$work/bin" >> "$GITHUB_OUTPUT"
