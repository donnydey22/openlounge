// Open Lounge WASM call media core (PLAN §9, Donny t4465u): libopus encode/decode + RTP + SRTP (SDES,
// AES_CM_128_HMAC_SHA1_80 via libsrtp2 built-in crypto). getUserMedia is capture-only; everything else is here.
#include <emscripten.h>
#include <opus.h>
#include <srtp2/srtp.h>
#include <string.h>
#include <stdlib.h>

typedef struct { OpusEncoder *enc; OpusDecoder *dec; srtp_t tx, rx; uint16_t seq; uint32_t ts, ssrc; uint8_t pt; } ol_call;

static int mk_srtp(srtp_t *s, const uint8_t *key30, int inbound) {
  srtp_policy_t p; memset(&p, 0, sizeof p);
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&p.rtp);
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&p.rtcp);
  p.ssrc.type = inbound ? ssrc_any_inbound : ssrc_any_outbound;
  p.key = (unsigned char *)key30; p.window_size = 1024; p.allow_repeat_tx = 0;
  return srtp_create(s, &p);
}
EMSCRIPTEN_KEEPALIVE int ol_init(void) { return srtp_init(); }
/* txKey/rxKey: 30-byte master key||salt decoded from a=crypto inline: (ours / peer's). */
EMSCRIPTEN_KEEPALIVE ol_call *ol_call_new(const uint8_t *txKey, const uint8_t *rxKey, uint32_t ssrc, int pt) {
  int e; ol_call *c = calloc(1, sizeof *c);
  c->enc = opus_encoder_create(48000, 1, OPUS_APPLICATION_VOIP, &e); if (e) return 0;
  opus_encoder_ctl(c->enc, OPUS_SET_INBAND_FEC(1)); opus_encoder_ctl(c->enc, OPUS_SET_PACKET_LOSS_PERC(10)); opus_encoder_ctl(c->enc, OPUS_SET_BITRATE(32000));
  c->dec = opus_decoder_create(48000, 1, &e); if (e) return 0;
  if (mk_srtp(&c->tx, txKey, 0) || mk_srtp(&c->rx, rxKey, 1)) return 0;
  c->ssrc = ssrc; c->pt = (uint8_t)pt; c->seq = (uint16_t)(ssrc & 0xffff); return c;
}
/* 20 ms (960 samples) PCM in -> SRTP packet out (returns length, <0 on error). out needs >= 1500 bytes. */
EMSCRIPTEN_KEEPALIVE int ol_send(ol_call *c, const int16_t *pcm, uint8_t *out) {
  uint8_t *h = out; h[0] = 0x80; h[1] = c->pt; h[2] = c->seq >> 8; h[3] = c->seq; h[4] = c->ts >> 24; h[5] = c->ts >> 16; h[6] = c->ts >> 8; h[7] = c->ts;
  h[8] = c->ssrc >> 24; h[9] = c->ssrc >> 16; h[10] = c->ssrc >> 8; h[11] = c->ssrc;
  int n = opus_encode(c->enc, pcm, 960, out + 12, 1200); if (n < 0) return n;
  int len = 12 + n; c->seq++; c->ts += 960;
  return srtp_protect(c->tx, out, &len) ? -100 : len;
}
/* SRTP packet in (in place) -> 960 PCM samples out; lost=1 runs Opus PLC. Returns samples or <0. */
EMSCRIPTEN_KEEPALIVE int ol_recv(ol_call *c, uint8_t *pkt, int len, int16_t *pcm, int lost) {
  if (lost) return opus_decode(c->dec, 0, 0, pcm, 960, 0);
  if (srtp_unprotect(c->rx, pkt, &len)) return -100;
  if (len < 12) return -101;
  int hl = 12 + 4 * (pkt[0] & 0x0f);
  return opus_decode(c->dec, pkt + hl, len - hl, pcm, 960, 0);
}
EMSCRIPTEN_KEEPALIVE void ol_call_free(ol_call *c) { if (!c) return; opus_encoder_destroy(c->enc); opus_decoder_destroy(c->dec); srtp_dealloc(c->tx); srtp_dealloc(c->rx); free(c); }
