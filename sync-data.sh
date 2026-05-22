#!/usr/bin/env bash
# sync-data.sh — pull accumulated parquets from a running instance into local busjs/data/.
#
# Usage:
#   ./sync-data.sh                                        # pull from production
#   ./sync-data.sh http://localhost:3000                  # pull from a local instance
#   ADMIN_PASSWORD=mypassword ./sync-data.sh              # with explicit password
#
# Admin password is read from (in order of priority):
#   1. ADMIN_PASSWORD env var
#   2. .env file in the same directory as this script
#
# Files already present locally are skipped. Today's live .jsonl is never
# downloaded (it changes every 40 s and will be rolled over by midnight anyway).

set -euo pipefail

SOURCE="${1:-https://buses.seevasantindran.com}"
DATA_DIR="$(cd "$(dirname "$0")" && pwd)/data"
TODAY="$(date -u +%Y-%m-%d)"   # UTC date; Railway runs UTC
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# Load ADMIN_PASSWORD from .env if not already set
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
  if [ -f "$ENV_FILE" ]; then
    ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')" || true
  fi
fi

# Log in and get the admin session cookie
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "Logging in to $SOURCE …"
  HTTP_LOGIN="$(curl -sf -w "%{http_code}" -o /dev/null \
    -c "$COOKIE_JAR" \
    -X POST "$SOURCE/api/admin/login" \
    -H "Content-Type: application/json" \
    -d "{\"password\":\"$ADMIN_PASSWORD\"}" || true)"
  if [ "$HTTP_LOGIN" != "200" ]; then
    echo "Login failed (HTTP $HTTP_LOGIN) — check ADMIN_PASSWORD"
    exit 1
  fi
  echo "  Authenticated."
  CURL_AUTH="-b $COOKIE_JAR"
else
  echo "No ADMIN_PASSWORD set — trying unauthenticated (will fail on secured servers)"
  CURL_AUTH=""
fi

mkdir -p "$DATA_DIR"

echo "Fetching date list from $SOURCE …"
DATES_JSON="$(curl -sf $CURL_AUTH "$SOURCE/api/dates")"
DATES="$(echo "$DATES_JSON" | grep -o '"[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}"' | tr -d '"')"

if [ -z "$DATES" ]; then
  echo "No dates returned — is the server running?"
  exit 1
fi

NEW=0
SKIP=0

for DATE in $DATES; do
  # Skip today's live file — it's incomplete and changes every tick
  if [ "$DATE" = "$TODAY" ]; then
    continue
  fi

  PARQUET="$DATA_DIR/$DATE.parquet"
  JSONL="$DATA_DIR/$DATE.jsonl"

  # Already have a local copy
  if [ -f "$PARQUET" ] || [ -f "$JSONL" ]; then
    SKIP=$((SKIP + 1))
    continue
  fi

  echo "  Downloading $DATE …"
  # Try parquet first (server prefers it); fall back gracefully on 404
  HTTP_CODE="$(curl -sf -w "%{http_code}" -o "$PARQUET.tmp" $CURL_AUTH "$SOURCE/api/data/$DATE" || true)"
  if [ "$HTTP_CODE" = "200" ]; then
    mv "$PARQUET.tmp" "$PARQUET"
    NEW=$((NEW + 1))
  else
    rm -f "$PARQUET.tmp"
    echo "    WARNING: $DATE returned HTTP $HTTP_CODE — skipping"
  fi
done

echo ""
echo "Done. $NEW new file(s) downloaded, $SKIP already present."
