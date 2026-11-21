#!/usr/bin/env bash
# MEEHOA Order Bot V1 — Kích hoạt Telegram Webhook an toàn
# Tuyệt đối không log hoặc in token ra màn hình.
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "⚠️ Vui lòng cung cấp TELEGRAM_BOT_TOKEN làm tham số thứ nhất."
  exit 1
fi

BOT_TOKEN="$1"
SECRET_TOKEN="${2:-}"
WORKER_URL="https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook"

echo "1. Đang nạp TELEGRAM_BOT_TOKEN vào Cloudflare Worker Secrets..."
echo -n "$BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN

if [ -n "$SECRET_TOKEN" ]; then
  echo "2. Đang cập nhật TELEGRAM_SECRET_TOKEN vào Cloudflare Worker Secrets..."
  echo -n "$SECRET_TOKEN" | npx wrangler secret put TELEGRAM_SECRET_TOKEN
fi

echo "3. Đang đăng ký Telegram Webhook tới Cloudflare Worker..."
SET_RES=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${WORKER_URL}\",\"secret_token\":\"${SECRET_TOKEN}\",\"allowed_updates\":[\"message\"]}")

echo "Kết quả đăng ký Webhook: $SET_RES"

echo "4. Đang kiểm tra getWebhookInfo từ Telegram..."
INFO_RES=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo")
echo "Trạng thái Webhook hiện tại: $INFO_RES"
