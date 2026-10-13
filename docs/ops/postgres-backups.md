# Encrypted Railway PostgreSQL backups

This runbook defines the **reviewed, not-yet-deployed** backup path for Open Lounge. It is intentionally independent of calls, LiveKit, coturn, Mediasoup, camera controls, media delivery, reactions, and stickers.

## Design

The backup job runs on `openlounge-media`, not on Railway. It uses a dedicated **20 GiB DigitalOcean Block Storage volume**, encrypted with LUKS2 as `/dev/mapper/openlounge-backups` and mounted only at `/srv/openlounge-backups`. The runner fails and emits a journal failure if that exact mapper is absent or a different mount is substituted. This separate mounted volume provides the hard storage boundary and keeps backup work off the droplet root filesystem.

Every daily job:

1. opens a read-only repeatable-read source transaction and exports its PostgreSQL snapshot;
2. uses that snapshot for `pg_dump --format=custom`, so the dump and source row-count inventory refer to the same logical database state;
3. encrypts the custom archive with `age` recipients before retaining it;
4. decrypts only inside the mounted encrypted volume;
5. restores into a temporary, loopback-only PostgreSQL 18 scratch cluster owned by the backup service user;
6. compares all user-table row counts against the exported source snapshot; and
7. stages archive/manifest pairs under the encrypted volume and promotes them only after all verification steps pass; and
8. deletes the scratch cluster and every plaintext temporary archive before exit.

The service keeps **7 daily** archives and copies Sunday’s verified encrypted archive into the weekly set, retaining **4 weekly** archives. Each retained archive has a mode-0600 manifest with its SHA-256 and a digest of the verified table-count inventory. A run reserves `max(1 GiB, source database size × 3 + 1 GiB)` before it begins, accounting for the custom dump, decrypted restore input, scratch restore data, encrypted output, and a safety margin. The systemd unit limits backup work to 20% CPU and 512 MiB memory, uses idle I/O priority, and writes both normal and failure output to the journal. A failed unit also invokes `logger` at `user.err` severity.

The archive volume is LUKS-encrypted at rest, and each archive is separately encrypted with `age`. The service must have a local age identity to perform its automated restore test, so these controls protect detached-volume/snapshot exposure and accidental file access; they do **not** protect against an active root compromise of the media host. Keep an additional recovery recipient/identity offline and outside the droplet.

## Required host material

No secret is committed in this repository. During a Chief-of-Staff-approved rollout, create these files outside the release tree:

| Path | Owner and mode | Purpose |
|---|---|---|
| `/etc/openlounge-backups/backup.env` | `root:openlounge-backup`, `0640` | Non-secret paths, retention settings, and the required `/dev/mapper/openlounge-backups` source; copy from `ops/db-backup/backup.env.example`. |
| `/etc/openlounge-backups/pg_service.conf` | `root:openlounge-backup`, `0640` | libpq service definition for the Railway public PostgreSQL endpoint, `sslmode=require`, and the dedicated backup role. |
| `/etc/openlounge-backups/.pgpass` | `openlounge-backup:openlounge-backup`, `0600` | The dedicated database role password. |
| `/etc/openlounge-backups/age-recipients.txt` | `root:openlounge-backup`, `0640` | At least one recovery recipient and the local restore-test recipient. |
| `/etc/openlounge-backups/age-identity.txt` | `root:openlounge-backup`, `0640` | The local restore-test identity. Do not put the offline recovery identity here. |

Use a dedicated Railway PostgreSQL role with only the read privileges required by `pg_dump`; do not reuse the application role. The database operator must validate the exact grants against Railway’s role model. At a minimum, it needs `CONNECT`, schema visibility, and read access to all Open Lounge data; it must not have application write privileges. The source connection is configured only through `PGSERVICEFILE` and `PGPASSFILE`, so a password never enters the process command line, logs, units, or repository.

PostgreSQL currently runs major version 18. The job fails closed unless `pg_dump` is major 18 or newer. The host also needs PostgreSQL 18 client and server binaries because it starts a temporary local scratch cluster for every restore test. That scratch server is not enabled as a persistent service.

## Rollout — Chief of Staff only

The following is a future deployment procedure. This PR **does not execute any of it**.

1. In DigitalOcean, create and attach a 20 GiB block volume to `openlounge-media`. Do not alter firewall rules.
2. On the host, create the LUKS2 mapping **named `/dev/mapper/openlounge-backups`** for the new volume, format it, mount it at `/srv/openlounge-backups`, and set owner `openlounge-backup:openlounge-backup`, mode `0700`. Persist the exact mapper/mount relation only after a reboot test. Record the LUKS recovery material in the approved secret store; never in Git, Railway, or the unit file.
3. Install only the required host packages: `age`, PostgreSQL 18 client/server binaries, and their dependencies. Disable any package-created persistent PostgreSQL cluster; the backup unit starts its own loopback scratch cluster and removes it after every run.
4. Create the system user `openlounge-backup` with `/usr/sbin/nologin`, its state directory, the five files in the previous table, and the restricted Railway database role. Confirm that the source connection uses TLS and has no write privilege.
5. Install `/opt/openlounge-backups/bin/openlounge-db-backup.sh`, the three unit files from `ops/db-backup/`, and the approved environment file. Run `systemd-analyze verify` before `daemon-reload`.
6. Run `systemctl start openlounge-db-backup.service` once while observing `journalctl -fu openlounge-db-backup.service`. Require a successful encrypted archive, successful scratch restore, equal row counts, a clean scratch-directory removal, no plaintext `.dump` file outside the mounted volume, and a free-space calculation that satisfies the capacity formula.
7. Before enabling the timer, temporarily stop or unmount the backup mapper and run the unit once. Require a failed unit and an `openlounge-db-backup` `user.err` journal entry; restore the exact mapper, then repeat the successful test. Enable `openlounge-db-backup.timer`; verify `systemctl list-timers openlounge-db-backup.timer`, its next run, and the journal failure path. The timer catches up one missed calendar run after a host outage because `Persistent=true` is set.
8. After seven daily and four weekly archives exist, review capacity and an offline recovery decrypt using the second recipient before treating the job as operationally complete.

## Failure response and revert

A failed run is visible in both `journalctl -u openlounge-db-backup.service` and the `openlounge-db-backup` `user.err` journal entry, including a missing/wrong backup mapper. Until the final commit point, the runner removes any newly promoted archive/manifest paths; a failed run is therefore never retained as a new daily or weekly copy. The previous verified archives remain unchanged.

To stop the schedule without deleting recoverable data:

```bash
systemctl disable --now openlounge-db-backup.timer
systemctl stop openlounge-db-backup.service
```

To revert the implementation after review, remove the backup units and `/opt/openlounge-backups` release directory, run `systemctl daemon-reload`, and leave the encrypted volume plus existing archives in place until an independent restore confirms they are no longer needed. Reverting this job does not alter Railway application variables, the Open Lounge application, or client software.

## Cross-platform compatibility matrix

This backup PR contains **no browser bundle, Expo source, native module, API route, or media/call change**. Client behavior is therefore unchanged; the compatibility requirement is recorded explicitly for release review.

| Surface | Change in this PR | Required release check | Revert impact |
|---|---|---|---|
| iOS Safari on every supported iOS/iPadOS version | None | Existing web smoke only; backup execution is not client-visible. | None; disable timer. |
| iOS Expo wrapper (`com.donnydey.openlounge`) | None | Existing sign-in, DM, room-chat, and upload smoke only; no new binary. | None; no App Store build or rollback. |
| Android Chrome and WebView on every supported Android version | None | Existing sign-in and messaging smoke only; no client TLS behavior changes. | None; no Play build or rollback. |
| Older Android TLS paths | None | The only new TLS path is media-host-to-Railway PostgreSQL and uses `sslmode=require`; it does not traverse an Android device. | None; disable timer. |
| Chrome, Firefox, Safari/WebKit, Edge web app | None | Existing web smoke only; no frontend asset or route changes. | None; disable timer. |
| Railway Postgres and media host | New host-only scheduled job | Check TLS source connection, restore counts, retention, journal failures, CPU/memory limits, and mount boundary. | Disable timer; retain encrypted archives. |

## Local validation

```bash
npm run test:db-backups
npm run test:db-backups:integration
```

The integration test starts only a disposable local PostgreSQL 16 source database and a disposable local scratch restore. It does not connect to Railway, DigitalOcean, or production.

**References**

[1]: https://www.postgresql.org/docs/current/app-pgdump.html "PostgreSQL pg_dump documentation"
[2]: https://www.postgresql.org/docs/current/functions-admin.html "PostgreSQL snapshot synchronization functions"
[3]: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html "systemd timer documentation"
[4]: https://github.com/FiloSottile/age "age encryption tool documentation"
