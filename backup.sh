#!/bin/bash

# Full backup of the docker compose deployment: database dump + uploaded files.
#
# Usage: ./backup.sh [target-dir]
#
#   target-dir    Where to store backups (default: ./backups, or $BACKUP_DIR)
#   BACKUP_KEEP   Number of backups to keep (default: 14, 0 = keep all)
#
# Each run creates <target-dir>/hortusfox_<timestamp>/ containing
#   database.sql.gz   Complete MariaDB dump (users, settings, plants, ...)
#   files.tar.gz      Images, attachments, themes and migration state
#
# Restore (stack running, from the repo root):
#   gunzip -c database.sql.gz | docker compose exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"'
#   docker compose exec -T app tar -C /var/www/html -xzf - < files.tar.gz
#   docker compose restart app

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_PATHS="public/img public/attachments public/themes app/migrations"

# Dumps contain password hashes and SMTP credentials
umask 077

name="hortusfox_$(date +%Y-%m-%d_%H-%M-%S)"
target="$BACKUP_DIR/$name"
partial="$BACKUP_DIR/.$name.partial"

mkdir -p "$partial"
trap 'rm -rf "$partial"' EXIT

echo "Dumping database..."
docker compose exec -T db sh -c \
    'exec mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --triggers "$MARIADB_DATABASE"' \
    | gzip > "$partial/database.sql.gz"

# mariadb-dump writes this trailer only if the dump ran to the end
if ! gunzip -c "$partial/database.sql.gz" | tail -n 1 | grep -q "Dump completed"; then
    echo "Error: Database dump is incomplete" >&2
    exit 1
fi

echo "Archiving files..."
docker compose exec -T app tar -C /var/www/html -czf - $BACKUP_PATHS > "$partial/files.tar.gz"
gzip -t "$partial/files.tar.gz"

mv "$partial" "$target"
echo "Backup created: $target ($(du -sh "$target" | cut -f1))"

if [ "$BACKUP_KEEP" -gt 0 ]; then
    find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'hortusfox_*' | sort -r | tail -n +$((BACKUP_KEEP + 1)) | while read -r old; do
        echo "Removing old backup: $old"
        rm -rf "$old"
    done
fi
