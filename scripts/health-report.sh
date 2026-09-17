#!/bin/bash
# Periodic domain portfolio health report, sent to Telegram.
# Reads DB + Telegram config from the app's own .env file.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "$APP_DIR/.env"
set +a

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, skipping report" >&2
  exit 0
fi

export PGPASSWORD="$DL_PG_PASSWORD"

pg() {
  psql -h "${DL_PG_HOST:-localhost}" -p "${DL_PG_PORT:-5432}" \
    -U "$DL_PG_USER" -d "$DL_PG_NAME" -tA -c "$1"
}

TOTAL=$(pg "SELECT count(*) FROM domains;")

UP_COUNT=$(pg "
  WITH latest AS (
    SELECT DISTINCT ON (domain_id) domain_id, is_up
    FROM uptime ORDER BY domain_id, checked_at DESC
  )
  SELECT count(*) FROM latest WHERE is_up = true;
")

DOWN_COUNT=$(pg "
  WITH latest AS (
    SELECT DISTINCT ON (domain_id) domain_id, is_up
    FROM uptime ORDER BY domain_id, checked_at DESC
  )
  SELECT count(*) FROM latest WHERE is_up = false;
")

DOWN_LIST=$(pg "
  WITH latest AS (
    SELECT DISTINCT ON (u.domain_id) u.domain_id, u.is_up, d.domain_name
    FROM uptime u JOIN domains d ON d.id = u.domain_id
    ORDER BY u.domain_id, u.checked_at DESC
  )
  SELECT domain_name FROM latest WHERE is_up = false ORDER BY domain_name;
")

EXPIRING=$(pg "
  SELECT domain_name || ' (' || (expiry_date - CURRENT_DATE) || 'd)'
  FROM domains
  WHERE expiry_date IS NOT NULL AND expiry_date - CURRENT_DATE <= 30
  ORDER BY expiry_date;
")

RECENT_NOTIFS=$(pg "
  SELECT count(*) FROM notifications WHERE created_at > now() - interval '12 hours';
")

NOW="$(date '+%Y-%m-%d %H:%M %Z')"

MSG="🕐 *HiCheck 12-Hour Report* — ${NOW}
━━━━━━━━━━━━━━━
📊 Domains: *${TOTAL}* total
✅ Up: *${UP_COUNT}*   ❌ Down: *${DOWN_COUNT}*"

if [ -n "$DOWN_LIST" ]; then
  MSG="${MSG}

*Down:*
$(echo "$DOWN_LIST" | sed 's/^/• /')"
fi

if [ -n "$EXPIRING" ]; then
  MSG="${MSG}

*Expiring within 30 days:*
$(echo "$EXPIRING" | sed 's/^/• /')"
fi

MSG="${MSG}

🔔 Notifications (last 12h): *${RECENT_NOTIFS}*"

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${TELEGRAM_CHAT_ID}" \
  --data-urlencode text="$MSG" \
  -d parse_mode="Markdown")

if [[ "$RESPONSE" != *'"ok":true'* ]]; then
  echo "Telegram send failed: $RESPONSE" >&2
  exit 1
fi
