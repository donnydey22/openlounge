import { holdFrames, swapVideoTrack, videoFit, mirrorBackdrop } from "../../src/lib/calls/frameHold";
import { startRing, stopTones } from "../../src/lib/calls/tones";
import { installAudioUnlock } from "../../src/lib/audioUnlock";
Object.assign(window as object, { holdFrames, swapVideoTrack, videoFit, mirrorBackdrop, startRing, stopTones, installAudioUnlock });
