#!/bin/sh
set -eu

mkdir -p /app/data /app/web/data /app/secrets

# Railway volume mounted at /app/data starts empty on first deploy.
# Seed it with the Excel/database files bundled with the image.
if [ ! -d /app/data/input ] || [ -z "$(find /app/data/input -maxdepth 1 -type f -name '*.xlsx' -print -quit 2>/dev/null || true)" ]; then
  echo "[startup] Seeding /app/data from bundled data..."
  cp -a /app/seed-data/. /app/data/
fi
mkdir -p /app/data/inbox /app/data/logs

# Railway variable GOOGLE_SA_JSON can contain the whole Google service-account JSON.
if [ -n "${GOOGLE_SA_JSON:-}" ]; then
  printf '%s' "$GOOGLE_SA_JSON" > /app/secrets/service-account.json
  export GOOGLE_SA_FILE="${GOOGLE_SA_FILE:-/app/secrets/service-account.json}"
fi

# dashboard.json là dữ liệu vận hành. Khi Volume chưa có bản riêng (deploy đầu
# tiên hoặc nâng cấp từ phiên bản cũ), dựng nó từ Excel trên Volume một lần.
# Nếu dữ liệu nguồn chưa đạt, vẫn copy bản dự phòng để web khởi động được.
if [ ! -s /app/data/dashboard.json ]; then
  echo "[startup] Creating persistent dashboard from Railway Volume..."
  if ! python3 /app/pipeline/run.py --build-only; then
    echo "[startup] Initial dashboard build failed; using bundled fallback."
    cp /app/web/data/dashboard.json /app/data/dashboard.json
  fi
fi

# Không chạy pipeline nặng ở mọi lần boot: khi một nguồn ngoài lỗi, Railway vẫn
# có thể đưa web lên với dashboard hợp lệ đã có. Bật REBUILD_ON_BOOT=true chỉ
# cho lần deploy mà operator chủ động muốn dựng lại từ dữ liệu trên Volume.
if [ "${REBUILD_ON_BOOT:-false}" = "true" ]; then
  echo "[startup] Rebuilding dashboard.json on operator request..."
  if ! python3 /app/pipeline/run.py --build-only; then
    echo "[startup] Pipeline rebuild failed; starting the web server with the last valid dashboard."
  fi
else
  echo "[startup] Skipping rebuild (REBUILD_ON_BOOT=false)."
fi

exec node /app/server/index.js
