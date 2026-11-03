#!/usr/bin/env bash
# Builds dist/olwasm.{js,wasm} with emscripten: libopus 1.5.2 + libsrtp 2.6.0 (built-in AES/HMAC, no OpenSSL) + olwasm.c
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build dist; P=$PWD/build/prefix
( cd build && [ -d opus ] || git clone -q --depth 1 -b v1.5.2 https://github.com/xiph/opus.git )
( cd build/opus && emcmake cmake -B b -DCMAKE_INSTALL_PREFIX=$P -DOPUS_BUILD_PROGRAMS=OFF -DBUILD_TESTING=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build b -j4 >/dev/null && cmake --install b >/dev/null )
( cd build && [ -d libsrtp ] || git clone -q --depth 1 -b v2.6.0 https://github.com/cisco/libsrtp.git )
( cd build/libsrtp && emcmake cmake -B b -DCMAKE_INSTALL_PREFIX=$P -DLIBSRTP_TEST_APPS=OFF -DENABLE_OPENSSL=OFF -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build b -j4 >/dev/null && cmake --install b >/dev/null )
emcc -O3 src/olwasm.c -I$P/include -I$P/include/opus $P/lib/libopus.a $P/lib/libsrtp2.a \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_ol_init,_ol_call_new,_ol_send,_ol_recv,_ol_call_free,_ol_video_init,_ol_video_send,_ol_video_recv,_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAP32 \
  -o dist/olwasm.mjs
ls -l dist
