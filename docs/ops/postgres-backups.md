# Railway-private, signed, encrypted PostgreSQL backups

> **Status: review source only.** This PR does not create a Railway service, database role, SSH account/key, or droplet file; set a production variable; deploy; merge; touch the public database proxy; or change calls, LiveKit, coturn, Mediasoup, media, reactions, or stickers.

## Objective and boundary

Railway Postgres is reachable only as `postgres.railway.internal`. The backup source therefore runs as a **separate Railway Cron service in the same project/environment**, not on the media droplet. It makes a logical custom-format `pg_dump`, an exact application-table row-count inventory from the same PostgreSQL snapshot, encrypts both to two age recipients, signs the manifest, and SFTPs ciphertext only to the existing 20 GiB LUKS volume at `/srv/openlounge-backups` on `openlounge-media` (`165.232.137.71`).

The receiver never has a Railway URL, database role/password, exporter signing key, or ability to connect to Railway. It verifies the signature and hashes, decrypts to a temporary volume-only workspace, restores into a loopback Unix-socket scratch PostgreSQL cluster, compares row counts, then retains only verified ciphertext.

```text
Railway Cron at 03:30 UTC
  postgres.railway.internal (TLS verify-full; read-only role)
  ├─ consistent snapshot holder + parallel pg_dump/inventory (bounded)
  ├─ age: recovery recipient + droplet restore-test recipient
  ├─ minisign: signed canonical manifest of ciphertext hashes
  └─ host-key-pinned SFTP: openlounge-backup@165.232.137.71
                                      │ encrypted, signed receipt only
                                      ▼
openlounge-media 20 GiB LUKS volume
  openlounge-backup (SFTP ingress): incoming/ only
  openlounge-backup-verify (systemd verifier): quarantine/ → scratch restore → daily/weekly/
```

## Guarantees and limits

- The fixed offline recovery recipient is `age1nnl9tv0w5tjk3kttljyflzllrhna99l6jnzt5dw5ctuhefz2n3gqcel5j2`. A separate droplet-only **public** age recipient is supplied at rollout. Neither age private identity is committed.
- The Railway service holds the private Minisign signing key as a sealed variable. The droplet holds only the matching public verification key. A transport attacker cannot create a valid receipt by replacing ciphertext and hashes.
- The receiver has two principals. `openlounge-backup` can SFTP only into `incoming`; `openlounge-backup-verify` alone can read the age identity and retention paths. The uploader cannot read or alter retained archives.
- The exporter uses `PGSSLMODE=verify-full` with a sealed private-host CA PEM. It fails closed without authenticated database TLS. A disposable local test may use `disable` only under `BACKUP_TEST_MODE=1`.
- The system is intentionally log-alerted, as requested: Railway failures exit nonzero in the Cron deployment log; receiver failures emit `user.err` to the droplet journal. There is no new notification vendor or paid monitoring service.

## Read-only source role — Chief of Staff only

Run through an approved administrative connection inside Railway. Replace the database name and password through an approved secrets workflow; never commit, print, or paste them in chat.

```sql
CREATE ROLE openlounge_backup_ro
  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 4
  PASSWORD '<generated-secret>';

GRANT CONNECT ON DATABASE openlounge TO openlounge_backup_ro;
GRANT pg_read_all_data TO openlounge_backup_ro;
```

Four connections accommodate the snapshot holder, parallel row-count inventory, `pg_dump`, and PostgreSQL client behavior while remaining bounded. Do not grant any write, server-file, execute-program, signal, replication, `BYPASSRLS`, role-management, database-creation, or superuser privilege. The exporter fails closed when any application table has row-level security rather than silently producing a partial backup.

## Railway Cron rollout — Chief of Staff only

1. Create a new one-shot Railway service in the existing Open Lounge project/environment. It is **not** the web service and uses the Dockerfile below rather than the root `railway.json`.

   ```text
   RAILWAY_DOCKERFILE_PATH=/build/ops/db-backup/railway/Dockerfile
   Cron Schedule: 30 3 * * *
   ```

   Railway Cron uses UTC. Its bounded exporter exits nonzero on any phase failure; Railway skips a scheduled execution that overlaps an active one.

2. Build a dedicated restricted SFTP key pair and a Minisign key pair offline. Put the SFTP public key and Minisign public key on the droplet. Put only the SFTP **private** key and Minisign **private** key in sealed Railway variables. Generate the Minisign key without a passphrase only because the sealed Railway Cron variable is the access control; protect it equivalently to a service password.

3. Set only these sealed variables (the templates contain no secret values):

   | Variable | Required value | Purpose |
   |---|---|---|
   | `BACKUP_PGHOST` | `postgres.railway.internal` | Enforced private network address |
   | `BACKUP_PGPORT` | `5432` | Private Postgres port |
   | `BACKUP_PGDATABASE` | application database name | Source database |
   | `BACKUP_PGUSER` | `openlounge_backup_ro` | Enforced read-only role |
   | `BACKUP_PGPASSWORD` | generated role password | Sealed only |
   | `BACKUP_PGSSLMODE` | `verify-full` | Authenticated TLS required |
   | `BACKUP_PGSSLROOTCERT_PEM` | approved private-host CA PEM | Sealed multiline CA material |
   | `BACKUP_AGE_RESTORE_RECIPIENT` | droplet restore-test `age1...` public recipient | Enables restore verification |
   | `BACKUP_MANIFEST_SIGNING_KEY` | Minisign private key | Signs hashes and manifest |
   | `BACKUP_SSH_PRIVATE_KEY` | restricted SFTP private key | Sealed multiline key |
   | `BACKUP_SSH_KNOWN_HOSTS` | verified `165.232.137.71` host-key line | Host-key pin |
   | `BACKUP_EXPORT_TIMEOUT_SEC` | `3600` | Maximum dump/inventory phase |
   | `BACKUP_SNAPSHOT_HOLD_SEC` | `3900` | Must exceed export timeout; holder is killed immediately after both consumers finish |
   | `BACKUP_SFTP_TIMEOUT_SEC` | `600` | Maximum transfer phase |

   The service requires no public domain, persistent volume, inbound port, public Railway Postgres TCP proxy, or app `DATABASE_URL`.

4. Before enabling the schedule, manually execute one Cron run. Require exit 0 and the log line `export complete: signed encrypted dump and inventory uploaded`. Confirm no log contains passwords, private keys, plaintext dump data, or count inventory data.

## Droplet receiver rollout — Chief of Staff only

### 1. Preserve the LUKS boundary

```bash
findmnt /srv/openlounge-backups
# must show /dev/mapper/openlounge-backups
```

Do not alter coturn, SFU, firewall rules, or the root filesystem. The backup receiver writes only to the existing dedicated 20 GiB LUKS volume.

### 2. Create separated ingress and verification principals

```bash
sudo groupadd --system openlounge-backup-ingress
sudo groupadd --system openlounge-backup-verify
sudo useradd --system --home-dir /srv/openlounge-backups --shell /usr/sbin/nologin --gid openlounge-backup-ingress openlounge-backup
sudo useradd --system --home-dir /var/lib/openlounge-backup-verify --shell /usr/sbin/nologin --gid openlounge-backup-verify openlounge-backup-verify
sudo usermod -a -G openlounge-backup-ingress openlounge-backup-verify
sudo chown root:openlounge-backup-ingress /srv/openlounge-backups
sudo chmod 0750 /srv/openlounge-backups
sudo install -d -o openlounge-backup -g openlounge-backup-ingress -m 2770 /srv/openlounge-backups/incoming
sudo install -d -o openlounge-backup-verify -g openlounge-backup-verify -m 0700 \
  /srv/openlounge-backups/daily /srv/openlounge-backups/weekly /srv/openlounge-backups/.tmp \
  /srv/openlounge-backups/.scratch /srv/openlounge-backups/.receipt-stage /srv/openlounge-backups/quarantine \
  /var/lib/openlounge-backup-verify
```

Create the key directory, install only the dedicated SFTP public key, and add the approved `sshd` policy:

```bash
sudo install -d -o root -g root -m 0755 /etc/ssh/authorized_keys
sudo install -o root -g root -m 0600 /dev/stdin /etc/ssh/authorized_keys/openlounge-backup
sudo tee /etc/ssh/sshd_config.d/openlounge-backup.conf >/dev/null <<'EOF'
Match User openlounge-backup
    ChrootDirectory /srv/openlounge-backups
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    ForceCommand internal-sftp -d /incoming -u 0007
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
EOF
sudo sshd -t
sudo sshd -T -C user=openlounge-backup,host=165.232.137.71,addr=127.0.0.1 | grep -E 'authorizedkeysfile|forcecommand|chrootdirectory'
sudo systemctl reload ssh
```

The setgid `incoming` directory and `-u 0007` result in ingress-group-readable, non-public upload files for the verifier. `daily`, `weekly`, staging, scratch, state, keys, and quarantine remain verifier-only; the ingress account is **not** in the verifier group. Before enabling the Cron schedule, validate with a dedicated test key that SFTP can upload into `incoming`, cannot obtain a shell, cannot access `daily`, and cannot forward ports.

The receiver unit runs with primary group `openlounge-backup-verify` and an explicit supplemental `openlounge-backup-ingress` group solely to atomically take files from `incoming`; it never grants the ingress account membership in the verifier group.

### 3. Install verifier requirements and public keys

Install `age`, `minisign`, and PostgreSQL 18 client/server packages. Do not enable a persistent PostgreSQL service. The systemd unit creates a temporary Unix-socket-only scratch cluster for each receipt.

```bash
sudo install -d -o root -g openlounge-backup-verify -m 0750 /etc/openlounge-backups
sudo age-keygen -o /etc/openlounge-backups/restore-test-age-identity.txt
sudo chown openlounge-backup-verify:openlounge-backup-verify /etc/openlounge-backups/restore-test-age-identity.txt
sudo chmod 0600 /etc/openlounge-backups/restore-test-age-identity.txt
sudo -u openlounge-backup-verify age-keygen -y /etc/openlounge-backups/restore-test-age-identity.txt
sudo install -o root -g openlounge-backup-verify -m 0640 /dev/stdin /etc/openlounge-backups/manifest-verify.pub
```

`manifest-verify.pub` must be the trusted public key corresponding to the sealed Railway `BACKUP_MANIFEST_SIGNING_KEY`. Keep the recovery identity matching the compiled recovery recipient **off the droplet**.

Install the receiver environment as `/etc/openlounge-backups/backup.env` with owner `root:openlounge-backup-verify` and mode `0640`. Then install the exact executable and units:

```bash
sudo install -D -m 0755 ops/db-backup/openlounge-db-restore-verify.sh /opt/openlounge-db-backups/bin/openlounge-db-restore-verify.sh
sudo install -D -m 0755 ops/db-backup/run-failure-drill.sh /opt/openlounge-db-backups/bin/run-failure-drill.sh
sudo install -D -m 0644 ops/db-backup/openlounge-db-restore-verify.service /etc/systemd/system/openlounge-db-restore-verify.service
sudo install -D -m 0644 ops/db-backup/openlounge-db-restore-verify.path /etc/systemd/system/openlounge-db-restore-verify.path
sudo install -D -m 0644 ops/db-backup/openlounge-db-restore-verify-failure@.service /etc/systemd/system/openlounge-db-restore-verify-failure@.service
sudo systemd-analyze verify /etc/systemd/system/openlounge-db-restore-verify.{service,path}
sudo systemctl daemon-reload
sudo systemctl enable --now openlounge-db-restore-verify.path
```

The path unit has both `PathChanged` and `PathExistsGlob`: an already-received manifest is reconciled after reboot or path-unit restart. The verifier has `RestrictAddressFamilies=AF_UNIX` and `IPAddressDeny=any`; it cannot initiate IP network connections.

### 4. Receiver operation and failure handling

- The uploader transfers partial names, renames archive/count/signature, then publishes the manifest last. Stale partials are removed after six hours; valid manifests are never accepted from partial names.
- A failing or unsigned receipt is moved to the verifier-only `quarantine/` directory with a timestamp and reason, emits `user.err`, and does not block later valid manifests. Inspect it before deletion.
- The verifier stores the latest accepted signed receipt timestamp under its private state directory and rejects a replay or stale receipt.
- Retention is **7 daily** and **4 weekly** verified receipt quartets: encrypted dump, encrypted counts, signed manifest, and signature. A Sunday weekly copy keeps its original signed names and signature intact.

## Acceptance, restore, and failure drill

1. Run one manual Cron export. Verify `journalctl -u openlounge-db-restore-verify.service -n 200 --no-pager` contains `restore verification passed`, `daily/` has one `.dump.age`, `.counts.age`, `.manifest`, and `.manifest.minisig`, and `find /srv/openlounge-backups -type f -name '*.dump'` prints nothing.
2. Run the non-destructive root-only drill:

   ```bash
   sudo /opt/openlounge-db-backups/bin/run-failure-drill.sh
   ```

   It writes an unsigned synthetic manifest, requires verifier failure, waits for the exact `user.err` alert, quarantines the synthetic receipt, and resets the unit state. It never contacts Railway or changes a retained archive.
3. Validate a real restricted SFTP login and a representative-size restore under the unit’s `20%` CPU, `512 MiB` memory, idle I/O, and six-hour aggregate timeout while coturn/SFU load is observed. Do not call the system operational until this is successful.
4. After seven daily and four weekly verified receipts, inspect LUKS volume headroom and review journals for any failed Cron, partial cleanup, or quarantined receipt.

## Cost and revert

- **No new paid service is added.** This uses existing Railway Cron capability, the existing `openlounge-media` droplet, and the existing LUKS volume. Railway may meter daily Cron compute and outbound SFTP under the existing plan; there is no new storage vendor, bucket, public proxy, or DigitalOcean resource.
- Banned vendors are absent: Cloudflare, Twilio, Bunny, Mux, and Cloudinary.
- To revert safely: disable/remove only the dedicated Railway Cron service, disable the receiver path/service, then revoke the dedicated SFTP key after no approved exports remain. Keep the LUKS volume, verified ciphertext, public verification key, and recovery material intact until an independent restore confirms retention is no longer required. Later remove the role, units, `/opt/openlounge-db-backups`, and dedicated accounts through a reviewed change.

## Local validation

```bash
npm run test:db-backups
npm run test:db-backups:integration
```

The integration test runs a disposable PostgreSQL source and maps the private hostname only inside the test. It proves signed encrypted export, receipt signature rejection/quarantine while a later valid receipt succeeds, restore/count comparison, weekly retention signature preservation, and stale partial cleanup. It uses a fake SFTP transport; the real key-only chroot, host-key, and access-boundary checks remain explicit production rollout gates above.

**References:** [Railway Cron Jobs](https://docs.railway.com/guides/cron-jobs), [Railway Private Networking](https://docs.railway.com/guides/private-networking), [PostgreSQL snapshots](https://www.postgresql.org/docs/current/functions-admin.html), [PostgreSQL `pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html), [age](https://github.com/FiloSottile/age), and [Minisign](https://jedisct1.github.io/minisign/).
