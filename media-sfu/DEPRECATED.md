# DEPRECATED (RingRTC hard cut, ringrtc-bindings)

No client or server code routes calls through this unit any more. Calls are 1:1 P2P WebRTC with sealed rc:* signaling
(server/calls/rcRelay.ts). This directory is the droplet deploy unit; stopping/removing it on the droplet is Cos's call.
Nothing here was deployed or changed by the hard cut.
