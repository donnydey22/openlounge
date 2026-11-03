#!/usr/bin/env bash
# Builds dist/olwasm.{js,wasm} with emscripten: libopus 1.5.2 + libsrtp 2.6.0 (built-in AES/HMAC, no OpenSSL) + openh264 2.4.1 encoder (C, no asm) + olwasm.c + ol_venc.cpp
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build dist; P=$PWD/build/prefix
( cd build && [ -d opus ] || git clone -q --depth 1 -b v1.5.2 https://github.com/xiph/opus.git )
( cd build/opus && emcmake cmake -B b -DCMAKE_INSTALL_PREFIX=$P -DOPUS_BUILD_PROGRAMS=OFF -DBUILD_TESTING=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build b -j4 >/dev/null && cmake --install b >/dev/null )
( cd build && [ -d libsrtp ] || git clone -q --depth 1 -b v2.6.0 https://github.com/cisco/libsrtp.git )
( cd build/libsrtp && emcmake cmake -B b -DCMAKE_INSTALL_PREFIX=$P -DLIBSRTP_TEST_APPS=OFF -DENABLE_OPENSSL=OFF -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build b -j4 >/dev/null && cmake --install b >/dev/null )
( cd build && [ -d openh264 ] || git clone -q --depth 1 -b v2.4.1 https://github.com/cisco/openh264.git )
( cd build/openh264 && [ -f libolh264enc.a ] || { mkdir -p o; I="-Icodec/api/wels -Icodec/common/inc -Icodec/encoder/core/inc -Icodec/encoder/plus/inc -Icodec/processing/interface"; for d in common adaptivequantization downsample scrolldetection vaacalc backgrounddetection complexityanalysis denoise imagerotate scenechangedetection; do I="$I -Icodec/processing/src/$d"; done
  { ls codec/common/src/*.cpp codec/encoder/core/src/*.cpp codec/encoder/plus/src/welsEncoderExt.cpp; find codec/processing/src -name '*.cpp' -not -path '*/x86/*' -not -path '*/arm*' -not -path '*/mips/*' -not -path '*/loongarch/*'; } \
    | xargs -P4 -n1 sh -c 'em++ -O3 -c "$1" '"$I"' -o o/$(echo "$1" | tr / _).o' _; emar rcs libolh264enc.a o/*.o; } )
em++ -O3 -c src/ol_venc.cpp -Ibuild/openh264/codec/api/wels -o build/ol_venc.o
emcc -O3 src/olwasm.c build/ol_venc.o build/openh264/libolh264enc.a -I$P/include -I$P/include/opus $P/lib/libopus.a $P/lib/libsrtp2.a \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_ol_init,_ol_call_new,_ol_send,_ol_recv,_ol_call_free,_ol_video_init,_ol_video_send,_ol_video_recv,_ol_venc_new,_ol_venc_encode,_ol_venc_free,_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAP32 \
  -o dist/olwasm.mjs
ls -l dist
