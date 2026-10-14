import { holdFrames, swapVideoTrack, videoFit } from "../../src/lib/calls/frameHold";
import { startRing, stopTones } from "../../src/lib/calls/tones";
import { installAudioUnlock } from "../../src/lib/audioUnlock";
Object.assign(window as object, { holdFrames, swapVideoTrack, videoFit, startRing, stopTones, installAudioUnlock });
