#!/bin/sh
# Runs inside the `backup` container: one dump at start-up, then one every 24 hours; old dumps are deleted.
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"
while true; do
  f="/backups/kiu_uscas-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  if pg_dump -h db -U kiu -d kiu_uscas --no-owner --no-privileges | gzip -9 > "$f.part"; then
    mv "$f.part" "$f"
    echo "backup ok: $f ($(wc -c < "$f") bytes)"
  else
    rm -f "$f.part"
    echo "BACKUP FAILED" >&2
  fi
  find /backups -name 'kiu_uscas-*.sql.gz' -mtime +"$KEEP" -delete
  sleep 86400
done
