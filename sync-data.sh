#!/usr/bin/env bash
# sync-data.sh — pull accumulated parquets from a running instance into local busjs/data/.
#
# Usage:
#   ./sync-data.sh                              # pull from production
#   ./sync-data.sh http://localhost:3000        # pull from a local instance
#
# Files already present locally are skipped. Today's live .jsonl is never
# downloaded (it changes every 40 s and will be rolled over by midnight anyway).

set -euo pipefail

SOURCE="${1:-https://buses.seevasantindran.com}"
DATA_DIR="$(cd "$(dirname "$0")" && pwd)/data"
TODAY="$(date -u +%Y-%m-%d)"   # UTC date; Railway runs UTC

mkdir -p "$DATA_DIR"

echo "Fetching date list from $SOURCE …"
DATES_JSON="$(curl -sf "$SOURCE/api/dates")"
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
  HTTP_CODE="$(curl -sf -w "%{http_code}" -o "$PARQUET.tmp" "$SOURCE/api/data/$DATE" || true)"
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
