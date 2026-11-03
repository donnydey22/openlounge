// Open Lounge WASM call media core (PLAN §9, Donny t4465u): libopus encode/decode + RTP + SRTP (SDES,
// AES_CM_128_HMAC_SHA1_80 via libsrtp2 built-in crypto). getUserMedia is capture-only; everything else is here.
#include <emscripten.h>
#include <opus.h>
#include <srtp2/srtp.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>

#define OL_MTU 1200
#define OL_AU_MAX (1 << 20)
typedef struct { OpusEncoder *enc; OpusDecoder *dec; srtp_t tx, rx; uint16_t seq; uint32_t ts, ssrc; uint8_t pt;
  uint16_t vseq; uint32_t vssrc; uint8_t vpt; uint8_t *au; int aulen; int vlost; uint16_t vlastseq; int vhave; } ol_call;

static int mk_srtp(srtp_t *s, const uint8_t *key30, int inbound) {
  srtp_policy_t p; memset(&p, 0, sizeof p);
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&p.rtp);
  srtp_crypto_policy_set_aes_cm_128_hmac_sha1_80(&p.rtcp);
  p.ssrc.type = inbound ? ssrc_any_inbound : ssrc_any_outbound;
  p.key = (unsigned char *)key30; p.window_size = 1024; p.allow_repeat_tx = 0;
  return srtp_create(s, &p);
}
/* RTP header length incl. CSRCs + extension (SFUs add header extensions); strips padding from *len. */
static int rtp_payload(const uint8_t *p, int *len) {
  if (*len < 12) return -1; int hl = 12 + 4 * (p[0] & 0x0f);
  if (p[0] & 0x10) { if (*len < hl + 4) return -1; hl += 4 + 4 * (p[hl + 2] << 8 | p[hl + 3]); }
  if (p[0] & 0x20) *len -= p[*len - 1];
  return hl < *len ? hl : -1;
}
EMSCRIPTEN_KEEPALIVE int ol_init(void) { return srtp_init(); }
/* txKey/rxKey: 30-byte master key||salt decoded from a=crypto inline: (ours / peer's). */
EMSCRIPTEN_KEEPALIVE ol_call *ol_call_new(const uint8_t *txKey, const uint8_t *rxKey, uint32_t ssrc, int pt) {
  int e; ol_call *c = calloc(1, sizeof *c);
  c->enc = opus_encoder_create(48000, 1, OPUS_APPLICATION_VOIP, &e); if (e) return 0;
  opus_encoder_ctl(c->enc, OPUS_SET_INBAND_FEC(1)); opus_encoder_ctl(c->enc, OPUS_SET_PACKET_LOSS_PERC(20)); opus_encoder_ctl(c->enc, OPUS_SET_BITRATE(32000));
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
  int hl = rtp_payload(pkt, &len); if (hl < 0) return -101;
  return opus_decode(c->dec, pkt + hl, len - hl, pcm, 960, 0);
}
EMSCRIPTEN_KEEPALIVE void ol_call_free(ol_call *c) { if (!c) return; opus_encoder_destroy(c->enc); opus_decoder_destroy(c->dec); srtp_dealloc(c->tx); srtp_dealloc(c->rx); free(c); }

/* ---- Video (t4465u): H.264 RTP (RFC 6184 single NAL + FU-A; STAP-A on receive) + SRTP in WASM.
   Encode/decode is WebCodecs (not WebRTC); capture is getUserMedia only. One SRTP session per leg covers audio+video. */
EMSCRIPTEN_KEEPALIVE void ol_video_init(ol_call *c, uint32_t vssrc, int vpt) { c->vssrc = vssrc; c->vpt = (uint8_t)vpt; c->vseq = (uint16_t)(vssrc & 0xffff); c->au = malloc(OL_AU_MAX); }
static int vpkt(ol_call *c, uint8_t *o, uint32_t ts, int marker, const uint8_t *pl, int pll, const uint8_t *pre, int prel) {
  o[0] = 0x80; o[1] = (marker ? 0x80 : 0) | c->vpt; o[2] = c->vseq >> 8; o[3] = c->vseq; o[4] = ts >> 24; o[5] = ts >> 16; o[6] = ts >> 8; o[7] = ts;
  o[8] = c->vssrc >> 24; o[9] = c->vssrc >> 16; o[10] = c->vssrc >> 8; o[11] = c->vssrc;
  memcpy(o + 12, pre, prel); memcpy(o + 12 + prel, pl, pll); int len = 12 + prel + pll; c->vseq++;
  return srtp_protect(c->tx, o, &len) ? -100 : len;
}
/* Annex-B access unit -> SRTP packets written at out + i*1500; lens[i] = size. Returns packet count or <0. */
EMSCRIPTEN_KEEPALIVE int ol_video_send(ol_call *c, const uint8_t *au, int len, uint32_t ts, uint8_t *out, int *lens, int maxp) {
  int n = 0, cnt = 0; const uint8_t *nal[256]; int nl[256]; int scpos[257];
  for (int i = 0; i + 3 <= len && cnt < 256; ) {
    int sc = (au[i] == 0 && au[i + 1] == 0) ? (au[i + 2] == 1 ? 3 : (i + 4 <= len && au[i + 2] == 0 && au[i + 3] == 1 ? 4 : 0)) : 0;
    if (sc) { scpos[cnt] = i; nal[cnt++] = au + i + sc; i += sc; } else i++; }
  if (!cnt) return -1;
  scpos[cnt] = len; for (int k = 0; k < cnt; k++) nl[k] = (int)(au + scpos[k + 1] - nal[k]);
  for (int k = 0; k < cnt; k++) {
    const uint8_t *p = nal[k]; int l = nl[k]; if (l <= 0) continue; int last = k == cnt - 1;
    if (l <= OL_MTU) { if (n >= maxp) return -2; int r = vpkt(c, out + n * 1500, ts, last, p, l, 0, 0); if (r < 0) return r; lens[n++] = r; continue; }
    uint8_t hdr = p[0]; const uint8_t *q = p + 1; int rem = l - 1, first = 1;
    while (rem > 0) { int ch = rem > OL_MTU ? OL_MTU : rem; uint8_t fu[2] = { (uint8_t)((hdr & 0xe0) | 28), (uint8_t)((hdr & 0x1f) | (first ? 0x80 : 0) | (ch == rem ? 0x40 : 0)) };
      if (n >= maxp) return -2; int r = vpkt(c, out + n * 1500, ts, last && ch == rem, q, ch, fu, 2); if (r < 0) return r; lens[n++] = r; q += ch; rem -= ch; first = 0; }
  }
  return n;
}
static void au_put(ol_call *c, const uint8_t *p, int l, int sc) { if (c->aulen + l + 4 > OL_AU_MAX) { c->vlost = 1; return; }
  if (sc) { static const uint8_t s4[4] = { 0, 0, 0, 1 }; memcpy(c->au + c->aulen, s4, 4); c->aulen += 4; } memcpy(c->au + c->aulen, p, l); c->aulen += l; }
/* SRTP video packet -> when marker completes an AU: copies Annex-B to frame, returns its length (and *key=1 if IDR). 0 = need more. */
EMSCRIPTEN_KEEPALIVE int ol_video_recv(ol_call *c, uint8_t *pkt, int len, uint8_t *frame, int *key) {
  if (srtp_unprotect(c->rx, pkt, &len)) return -100;
  int hl = rtp_payload(pkt, &len); if (hl < 0) return -101;
  uint16_t seq = (uint16_t)(pkt[2] << 8 | pkt[3]); if (c->vhave && (uint16_t)(c->vlastseq + 1) != seq) c->vlost = 1; c->vlastseq = seq; c->vhave = 1;
  const uint8_t *p = pkt + hl; int l = len - hl; int t = p[0] & 0x1f;
  if (t == 28 && l > 2) { if (p[1] & 0x80) { uint8_t h = (p[0] & 0xe0) | (p[1] & 0x1f); au_put(c, &h, 1, 1); } au_put(c, p + 2, l - 2, 0); }
  else if (t == 24) { int o = 1; while (o + 2 < l) { int sz = p[o] << 8 | p[o + 1]; o += 2; if (o + sz > l) break; au_put(c, p + o, sz, 1); o += sz; } }
  else au_put(c, p, l, 1);
  if (!(pkt[1] & 0x80)) return 0;
  int out = c->vlost ? -102 : c->aulen; *key = 0;
  if (!c->vlost) { memcpy(frame, c->au, c->aulen); for (int i = 0; i + 4 < c->aulen; i++) if (c->au[i] == 0 && c->au[i+1] == 0 && c->au[i+2] == 0 && c->au[i+3] == 1 && (c->au[i+4] & 0x1f) == 5) { *key = 1; break; } }
  c->aulen = 0; c->vlost = 0; return out;
}
EMSCRIPTEN_KEEPALIVE int ol_mem(int n) { return (int)malloc(n); }
