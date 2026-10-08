#!/bin/sh
# Generates test/.fixture/src: 24 s 720p test video → faststart full.mp4, HLS fMP4 ladder 240/360/480/720 (4 s segments,
# keyframe every 2 s, relative URIs), master.m3u8, poster/thumb.webp — the layout in CACHE_CONTRACT.md §2.
set -e
F=$(cd "$(dirname "$0")" && pwd)/.fixture; rm -rf "$F"; mkdir -p "$F/src"; cd "$F/src"
ffmpeg -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 24 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart full.mp4
for h in 240 360 480 720; do mkdir -p hls/r$h; w=$(( (h*16/9+1)/2*2 )); b=$(( h*4 ))k
ffmpeg -loglevel error -i full.mp4 -vf scale=$w:$h -c:v libx264 -preset veryfast -b:v $b -maxrate $b -bufsize $b -g 60 -keyint_min 60 -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*2)" -c:a aac -b:a 64k -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename "hls/r$h/seg_%05d.m4s" hls/r$h/index.m3u8; done
ffmpeg -loglevel error -ss 1 -i full.mp4 -frames:v 1 -vf scale=640:-2 poster.webp
cp poster.webp thumb.webp
{ echo "#EXTM3U"; echo "#EXT-X-VERSION:7"; echo "#EXT-X-INDEPENDENT-SEGMENTS"; for h in 240 360 480 720; do w=$(( (h*16/9+1)/2*2 )); echo "#EXT-X-STREAM-INF:BANDWIDTH=$((h*4000+64000)),RESOLUTION=${w}x${h},CODECS=\"avc1.64001f,mp4a.40.2\""; echo "r$h/index.m3u8"; done; } > hls/master.m3u8
