#!/usr/bin/env bash
# One-command build: frames (headless Chromium) → score (numpy) → loudness-normalised H.264 MP4 → checks.
# usage: ./build.sh [frames_dir] [out.mp4]          (relative paths, FILM included, are taken from where you run it)
# env:   FILM=film.html   SUB=4 (motion-blur sub-frames; film.blur raises it in fast moves)   WORKERS=4
#        CRF=15   FMT=png|jpeg (frame files)   NO_AUDIO=1 (silent film)
#        VENUE=screen|projector|phone (check thresholds and sound profile; phone also sets LUFS=-14)
#        LUFS=-16 (integrated loudness target)   SYNC=pops,hits (cues to check for sync)
#        FROM=n TO=m (re-render only frames n..m-1)   SKIP_RENDER=1 (reuse existing frames)
#        DRAFT=1 (fast full pass with every check: 1 sub-frame, JPEG frames, quick encode)
# Frames = FPS × DUR; expect 150–500 ms each at 1080p (more inside film.blur windows). In an agent,
# run long builds in the background or with a long timeout; render.mjs prints progress and an ETA.
set -euo pipefail
abs() { case "$1" in /*) echo "$1";; *) echo "$PWD/$1";; esac; }
HERE=$(cd "$(dirname "$0")" && pwd)
FR=$(abs "${1:-frames}"); OUT=$(abs "${2:-film.mp4}")
if [[ -n "${FILM:-}" ]]; then FILM=$(abs "$FILM"); else FILM="$HERE/film.html"; fi
cd "$HERE"
SUB=${SUB:-4}; WORKERS=${WORKERS:-4}; CRF=${CRF:-15}; FMT=${FMT:-png}; PRESET=slow
VENUE=${VENUE:-}; LUFS_SET=${LUFS:-}
if [[ "${DRAFT:-0}" == "1" ]]; then SUB=1; FMT=jpeg; CRF=23; PRESET=veryfast; fi
EXT=png; [[ "$FMT" == "png" ]] || EXT=jpg
export VENUE

if [[ "${SKIP_RENDER:-0}" != "1" ]]; then
  RANGE=(); [[ -n "${FROM:-}" ]] && RANGE+=(--from "$FROM"); [[ -n "${TO:-}" ]] && RANGE+=(--to "$TO")
  node render.mjs --film "$FILM" --frames "$FR" --sub "$SUB" --workers "$WORKERS" --fmt "$FMT" ${RANGE[@]+"${RANGE[@]}"}
fi
read -r FPS TOTAL VERT < <(python3 -c "import json;c=json.load(open('$FR/cues.json'));print(c['fps'], round(c['fps']*c['dur']), int(c.get('H',0)>c.get('W',1)))")
# Loudness: −14 LUFS for phones (VENUE=phone or a vertical film), else −16, unless LUFS was set.
if [[ -n "$LUFS_SET" ]]; then LUFS=$LUFS_SET; elif [[ "$VENUE" == "phone" || "$VERT" == "1" ]]; then LUFS=-14; else LUFS=-16; fi
[[ -f "$FR/f00000.$EXT" ]] || { echo "no .$EXT frames in $FR (rendered with a different FMT/DRAFT setting?)"; exit 1; }
VIDEO=(-c:v libx264 -preset "$PRESET" -crf "$CRF" -tune film -pix_fmt yuv420p -profile:v high -movflags +faststart)

if [[ "${NO_AUDIO:-0}" == "1" ]]; then
  ffmpeg -loglevel error -y -framerate "$FPS" -i "$FR/f%05d.$EXT" -frames:v "$TOTAL" "${VIDEO[@]}" "$OUT"
else
  python3 score.py "$FR/cues.json" "$FR/soundtrack.wav"
  # Two-pass loudnorm: measure, then apply linearly (no pumping) to the target.
  M=$(ffmpeg -hide_banner -i "$FR/soundtrack.wav" -af "loudnorm=I=$LUFS:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
  LN=$(echo "$M" | python3 -c "import json,sys;d=json.load(sys.stdin);print('' if d['input_i'] in ('-inf','inf') else f\"measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}:measured_thresh={d['input_thresh']}:offset={d['target_offset']}\")")
  if [[ -z "$LN" ]]; then echo "the soundtrack is silent: encoding it without loudness normalisation"; AF=aresample=48000
  else AF="loudnorm=I=$LUFS:TP=-1.5:LRA=11:$LN:linear=true,aresample=48000"; fi
  ffmpeg -loglevel error -y -framerate "$FPS" -i "$FR/f%05d.$EXT" -i "$FR/soundtrack.wav" -frames:v "$TOTAL" \
    -af "$AF" "${VIDEO[@]}" -c:a aac -b:a 256k -shortest "$OUT"
fi
ffmpeg -loglevel error -y -i "$FR/f$(printf %05d $((TOTAL - 1))).$EXT" "${OUT%.*}-poster.png"
CHECK=(); [[ -n "${SYNC:-}" ]] && CHECK+=(--sync "$SYNC"); [[ -n "$VENUE" ]] && CHECK+=(--venue "$VENUE")
python3 tools/check.py "$OUT" "$FR/cues.json" ${CHECK[@]+"${CHECK[@]}"} || echo "check.py reported high findings (see above); the MP4 was still written."
