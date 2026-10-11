# Calls & rooms: reconnection and TURN (Oct 10 2026)

## Reconnection
- 1:1 calls (already live since Oct 8: 71271d0, 57c6ad5, 1137086, 4e95295, 2b88c4a): 45 s server grace, LiveKit resume →
  fresh-token full rejoin, media-stall watchdog, online/offline/connection-type watch → ICE restart, peer "Reconnecting…"
  banner, timer kept, "Connection lost" end state, WS drop leaves media up.
- Rooms (this branch, `src/hooks/useLiveKitAudio.ts`): `reconnecting` status shown as "Reconnecting audio…" (room pill +
  drop-in status); when LiveKit gives up (`Disconnected`) or a mid-session connect fails, rejoin with a fresh token
  (backoff 1/2/4/8/10 s), immediately on `online` (Wi-Fi ↔ cellular). Not when removed / room closed / duplicate identity /
  token 403/404. Mic is republished by the existing mic effect when status returns to `connected`.
- Lab test: `tests/e2e/rooms-reconnect.lab.mjs` (needs the /workspace/calls netlab namespace + local LiveKit).

## TURN — decision: no TURN on the current Railway setup
Benchmark: /workspace/calls/turn-bench/RESULTS.md (lab shaped like production: force_tcp, ICE/TCP on one high port).
- LiveKit built-in TURN/TLS needs its own public TCP port. Railway gives one TCP proxy per service, already used by ICE/TCP,
  so `turn` in the Railway shape connected 0/35. It would need a second LiveKit-reachable TCP proxy.
- TURN/TLS on real 443 (the only variant that beats 443-only firewalls / CONNECT proxies, 10/10) is impossible on Railway:
  the TCP proxy port is random, 443 is the HTTP edge.
- A high-port TURN (coturn as a separate service) gives nothing the current ICE/TCP path doesn't: both pass UDP-blocked
  networks and both fail on 443-only networks.
- External relays: banned vendors / third-party / need signup → out.
So production keeps ICE/TCP, `iceServers: []` (no STUN, no open relay). Per-call credentials already exist: call LiveKit
tokens live 180 s and die with the call (2b88c4a). If TURN/TLS:443 is wanted later it needs a host with a real 443
(LiveKit `turn.tls_port: 443`, `turn.domain`, its own cert); LiveKit then mints per-participant TURN creds itself.
