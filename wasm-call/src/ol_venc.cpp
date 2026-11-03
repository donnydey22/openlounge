// Browser WASM H.264 encoder (Video spec v2, PLAN §14): openh264 compiled to WASM, single layer, 720p cap.
// I420 in -> Annex-B access unit out (fed to ol_video_send for RTP/SRTP). No WebCodecs / Chrome WebRTC encode.
#include <emscripten.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "codec_api.h"
struct ol_venc { ISVCEncoder *e; int w, h; };
extern "C" {
EMSCRIPTEN_KEEPALIVE ol_venc *ol_venc_new(int w, int h, int bps, int fps, int keyIntervalFrames) {
  if (w > 1280 || h > 720) return nullptr; // browser cap: 720p, single layer
  ol_venc *v = (ol_venc *)calloc(1, sizeof(ol_venc)); if (WelsCreateSVCEncoder(&v->e) || !v->e) { free(v); return nullptr; }
  SEncParamExt p; v->e->GetDefaultParams(&p);
  p.iUsageType = CAMERA_VIDEO_REAL_TIME; p.iPicWidth = w; p.iPicHeight = h; p.fMaxFrameRate = (float)fps;
  p.iTargetBitrate = bps; p.iMaxBitrate = bps; p.iRCMode = RC_BITRATE_MODE; p.bEnableFrameSkip = false;
  p.iSpatialLayerNum = 1; p.iTemporalLayerNum = 1; p.uiIntraPeriod = keyIntervalFrames; p.iMultipleThreadIdc = 1;
  p.eSpsPpsIdStrategy = CONSTANT_ID; p.bEnableDenoise = false; p.bEnableBackgroundDetection = false; p.bEnableAdaptiveQuant = false;
  p.sSpatialLayers[0].iVideoWidth = w; p.sSpatialLayers[0].iVideoHeight = h; p.sSpatialLayers[0].fFrameRate = (float)fps;
  p.sSpatialLayers[0].iSpatialBitrate = bps; p.sSpatialLayers[0].iMaxSpatialBitrate = bps; p.sSpatialLayers[0].uiProfileIdc = PRO_BASELINE;
  p.sSpatialLayers[0].sSliceArgument.uiSliceMode = SM_SINGLE_SLICE; // ol_video_send FU-A fragments
  if (v->e->InitializeExt(&p)) { WelsDestroySVCEncoder(v->e); free(v); return nullptr; }
  int fmt = videoFormatI420, lvl = WELS_LOG_ERROR; v->e->SetOption(ENCODER_OPTION_DATAFORMAT, &fmt); v->e->SetOption(ENCODER_OPTION_TRACE_LEVEL, &lvl);
  v->w = w; v->h = h; return v;
}
/** returns AU byte length in out (Annex-B), 0 if frame skipped, <0 on error; *key = 1 for IDR */
EMSCRIPTEN_KEEPALIVE int ol_venc_encode(ol_venc *v, uint8_t *i420, uint32_t tsMs, int forceKey, uint8_t *out, int max, int *key) {
  if (forceKey) v->e->ForceIntraFrame(true);
  SSourcePicture pic; memset(&pic, 0, sizeof pic); pic.iPicWidth = v->w; pic.iPicHeight = v->h; pic.iColorFormat = videoFormatI420;
  pic.iStride[0] = v->w; pic.iStride[1] = pic.iStride[2] = v->w / 2; pic.pData[0] = i420; pic.pData[1] = i420 + v->w * v->h; pic.pData[2] = pic.pData[1] + v->w * v->h / 4; pic.uiTimeStamp = tsMs;
  SFrameBSInfo info; memset(&info, 0, sizeof info);
  if (v->e->EncodeFrame(&pic, &info) != cmResultSuccess) return -1;
  if (info.eFrameType == videoFrameTypeSkip || info.eFrameType == videoFrameTypeInvalid) return 0;
  int n = 0;
  for (int l = 0; l < info.iLayerNum; l++) { const SLayerBSInfo &L = info.sLayerInfo[l]; int sz = 0; for (int i = 0; i < L.iNalCount; i++) sz += L.pNalLengthInByte[i];
    if (n + sz > max) return -2; memcpy(out + n, L.pBsBuf, sz); n += sz; }
  *key = info.eFrameType == videoFrameTypeIDR; return n;
}
EMSCRIPTEN_KEEPALIVE void ol_venc_free(ol_venc *v) { if (!v) return; v->e->Uninitialize(); WelsDestroySVCEncoder(v->e); free(v); }
}
