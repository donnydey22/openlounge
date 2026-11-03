/* Linux CI driver for the phone engine's SFU leg (ol_sfu.c, the same file the iOS/Android engines compile).
   usage: olsfu_cli <ip> <port> <txKeyB64> <rxKeyB64> <ssrc> <txPt> <rxPt> <seconds>  -> prints JSON stats. */
#include <pjsua-lib/pjsua.h>
#include <stdio.h>
#include <stdlib.h>
#include "ol_sfu.h"
#include "ol_sfu_video.h"
#include <string.h>
/* video sanity (OL_VIP set): echo every received browser AU back on all 3 simulcast layers (exercises both packetizer paths) */
static void echo(void *u, const unsigned char *a, int n, int key, unsigned ts) { (void)u; for (int l = 0; l < 3; l++) ol_sfu_video_send(l, a, n, ts, key); }
int main(int c, char **v) {
  if (c < 9) return 2;
  pjsua_config cfg; pjsua_logging_config lc; pjsua_media_config mc; pjsua_config_default(&cfg); pjsua_logging_config_default(&lc); pjsua_media_config_default(&mc);
  lc.console_level = 0; lc.level = 5; lc.log_filename = pj_str("/tmp/olsfu.log"); mc.clock_rate = 48000; mc.no_vad = 1;
  if (pjsua_create() || pjsua_init(&cfg, &lc, &mc) || pjsua_start()) return 3;
  pjsua_set_null_snd_dev();
  int r = ol_sfu_audio_start(v[1], atoi(v[2]), v[3], v[4], (unsigned)strtoul(v[5], 0, 10), atoi(v[6]), atoi(v[7]), 440);
  if (r) { printf("{\"error\":%d}\n", r); return 4; }
  const char *vip = getenv("OL_VIP"); int vr = 1;
  if (vip) { unsigned ss[3] = { 0 }; sscanf(getenv("OL_VSSRCS"), "%u,%u,%u", &ss[0], &ss[1], &ss[2]); ol_sfu_video_set_sink(echo, NULL);
    vr = ol_sfu_video_start(vip, atoi(getenv("OL_VPORT")), getenv("OL_VTX"), getenv("OL_VRX"), ss, 3, atoi(getenv("OL_VPT"))); }
  int secs = atoi(v[8]), maxl = 0; long sum = 0; int n = 0;
  for (int i = 0; i < secs * 10; i++) { pj_thread_sleep(100); int l = ol_sfu_rx_level(); if (i > 20) { sum += l; n++; if (l > maxl) maxl = l; } }
  unsigned rx = 0, lost = 0, tx = 0; ol_sfu_stats(&rx, &lost, &tx);
  char vj[384] = ""; if (vip) { unsigned vrp, va, vk, vg, vtp, ta[3], tk[3]; ol_sfu_video_stats(&vrp, &va, &vk, &vg, &vtp, ta, tk); unsigned pr, pt, td; ol_sfu_video_fb_stats(&pr, &pt, &td);
    snprintf(vj, sizeof vj, ",\"videoError\":%d,\"vRxPkt\":%u,\"rxAu\":%u,\"rxKey\":%u,\"rxGap\":%u,\"vTxPkt\":%u,\"txAu\":[%u,%u,%u],\"pliRx\":%u,\"pliTx\":%u,\"txDrop\":%u", vr, vrp, va, vk, vg, vtp, ta[0], ta[1], ta[2], pr, pt, td); ol_sfu_video_stop(); }
  printf("{\"rxPkt\":%u,\"rxLost\":%u,\"txPkt\":%u,\"avgLevel\":%.1f,\"maxLevel\":%d%s}\n", rx, lost, tx, n ? (double)sum / n : 0.0, maxl, vj);
  ol_sfu_stop(); pjsua_destroy(); return 0;
}
