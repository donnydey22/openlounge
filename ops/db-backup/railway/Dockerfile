# Dedicated one-shot Railway Cron image. It is intentionally separate from the Open Lounge web image.
# Digest pins the official PostgreSQL 18.6 Bookworm client image reviewed for this release.
FROM postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c

RUN apt-get update \
 && apt-get install -y --no-install-recommends age minisign openssh-client ca-certificates bash coreutils util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /var/lib/openlounge-backup --shell /usr/sbin/nologin openlounge-backup

COPY --chmod=0755 ops/db-backup/railway/export-backup.sh /usr/local/bin/openlounge-railway-backup
USER openlounge-backup
WORKDIR /tmp

# Railway Cron starts this one-shot command at 03:30 UTC and expects it to exit when export is complete.
ENTRYPOINT ["/usr/local/bin/openlounge-railway-backup"]
