/* Linux CI driver for the phone engine's SFU leg (ol_sfu.c, the same file the iOS/Android engines compile).
   usage: olsfu_cli <ip> <port> <txKeyB64> <rxKeyB64> <ssrc> <txPt> <rxPt> <seconds>  -> prints JSON stats. */
#include <pjsua-lib/pjsua.h>
#include <stdio.h>
#include <stdlib.h>
#include "ol_sfu.h"
int main(int c, char **v) {
  if (c < 9) return 2;
  pjsua_config cfg; pjsua_logging_config lc; pjsua_media_config mc; pjsua_config_default(&cfg); pjsua_logging_config_default(&lc); pjsua_media_config_default(&mc);
  lc.console_level = 0; lc.level = 5; lc.log_filename = pj_str("/tmp/olsfu.log"); mc.clock_rate = 48000; mc.no_vad = 1;
  if (pjsua_create() || pjsua_init(&cfg, &lc, &mc) || pjsua_start()) return 3;
  pjsua_set_null_snd_dev();
  int r = ol_sfu_audio_start(v[1], atoi(v[2]), v[3], v[4], (unsigned)strtoul(v[5], 0, 10), atoi(v[6]), atoi(v[7]), 440);
  if (r) { printf("{\"error\":%d}\n", r); return 4; }
  int secs = atoi(v[8]), maxl = 0; long sum = 0; int n = 0;
  for (int i = 0; i < secs * 10; i++) { pj_thread_sleep(100); int l = ol_sfu_rx_level(); if (i > 20) { sum += l; n++; if (l > maxl) maxl = l; } }
  unsigned rx = 0, lost = 0, tx = 0; ol_sfu_stats(&rx, &lost, &tx);
  printf("{\"rxPkt\":%u,\"rxLost\":%u,\"txPkt\":%u,\"avgLevel\":%.1f,\"maxLevel\":%d}\n", rx, lost, tx, n ? (double)sum / n : 0.0, maxl);
  ol_sfu_stop(); pjsua_destroy(); return 0;
}
