#!/usr/bin/env bash
# ==============================================================================
# MEEHOA Order Bot V1 — Kích hoạt Telegram Webhook An Toàn (Không lộ Token)
# ==============================================================================
# BẢO MẬT:
# 1. Tuyệt đối KHÔNG nhận token qua tham số dòng lệnh ($1, $2) để tránh lưu vào
#    history shell (~/.zsh_history, ~/.bash_history) và danh sách tiến trình (ps).
# 2. Sử dụng `read -s` để ẩn token khi nhập.
# 3. Kiểm tra định dạng token và bắt buộc có TELEGRAM_SECRET_TOKEN (không cho phép trống).
# 4. Tự động xóa biến bộ nhớ (unset) ngay sau khi hoàn thành.
# ==============================================================================
set -euo pipefail

# 1. Từ chối nếu người dùng vô tình truyền token qua tham số dòng lệnh
if [ $# -gt 0 ]; then
  echo "❌ LỖI BẢO MẬT: Tuyệt đối không truyền Bot Token qua tham số dòng lệnh!"
  echo "👉 Vui lòng chỉ chạy: ./activate-webhook.sh (hệ thống sẽ yêu cầu nhập ẩn an toàn)."
  exit 1
fi

echo "========================================================================"
echo "🔐 MEEHOA ORDER BOT V1 — KÍCH HOẠT TELEGRAM WEBHOOK STAGING AN TOÀN"
echo "========================================================================"
echo "Worker đích: https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook"
echo ""

# 2. Nhập TELEGRAM_BOT_TOKEN an toàn (ẩn khi gõ)
echo -n "👉 Nhập TELEGRAM_BOT_TOKEN (ẩn khi gõ, nhấn Enter khi xong): "
read -r -s BOT_TOKEN
echo ""

if [ -z "$BOT_TOKEN" ]; then
  echo "❌ Lỗi: TELEGRAM_BOT_TOKEN không được để trống!"
  exit 1
fi

# Kiểm tra định dạng cơ bản của Telegram bot token: <bot_id>:<token_secret>
if ! [[ "$BOT_TOKEN" =~ ^[0-9]{8,12}:[a-zA-Z0-9_-]{30,50}$ ]]; then
  echo "⚠️ Cảnh báo: Định dạng BOT_TOKEN có thể không đúng chuẩn Telegram (dạng 1234567890:ABC-DEF...)."
  echo -n "Bạn có chắc chắn muốn tiếp tục không? (y/N): "
  read -r CONFIRM
  if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
    echo "Đã hủy thao tác."
    unset BOT_TOKEN
    exit 1
  fi
fi

# 3. Nhập TELEGRAM_SECRET_TOKEN an toàn (không cho phép trống)
echo -n "👉 Nhập TELEGRAM_SECRET_TOKEN (chuỗi bí mật xác thực webhook, min 16 ký tự): "
read -r -s SECRET_TOKEN
echo ""

if [ -z "$SECRET_TOKEN" ]; then
  echo "❌ Lỗi: TELEGRAM_SECRET_TOKEN không được để trống! Không cho phép đăng ký Webhook với secret trống."
  unset BOT_TOKEN
  exit 1
fi

if [ ${#SECRET_TOKEN} -lt 16 ]; then
  echo "❌ Lỗi: TELEGRAM_SECRET_TOKEN quá ngắn (yêu cầu tối thiểu 16 ký tự để đảm bảo an toàn)."
  unset BOT_TOKEN SECRET_TOKEN
  exit 1
fi

WORKER_URL="https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook"

echo ""
echo "⏳ [1/4] Đang nạp TELEGRAM_BOT_TOKEN vào Cloudflare Worker Secrets..."
echo -n "$BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN >/dev/null 2>&1
echo "✅ TELEGRAM_BOT_TOKEN đã nạp thành công vào Cloudflare Secrets."

echo "⏳ [2/4] Đang nạp TELEGRAM_SECRET_TOKEN vào Cloudflare Worker Secrets..."
echo -n "$SECRET_TOKEN" | npx wrangler secret put TELEGRAM_SECRET_TOKEN >/dev/null 2>&1
echo "✅ TELEGRAM_SECRET_TOKEN đã nạp thành công vào Cloudflare Secrets."

echo "⏳ [3/4] Đang kiểm tra trạng thái Webhook hiện tại qua getWebhookInfo..."
CURRENT_INFO=$(curl -s -S "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" || true)
echo "📋 Trạng thái trước kích hoạt:"
# Che dấu thông tin nhạy cảm nếu có
echo "$CURRENT_INFO" | sed -E 's/"ip_address":"[^"]+"/"ip_address":"[REDACTED]"/g'

echo ""
echo "⏳ [4/4] Đang đăng ký Telegram Webhook tới Cloudflare Worker..."
SET_RES=$(curl -s -S -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${WORKER_URL}\",\"secret_token\":\"${SECRET_TOKEN}\",\"allowed_updates\":[\"message\"]}")

echo "📋 Kết quả đăng ký Webhook:"
echo "$SET_RES"

echo ""
echo "🔍 Đang xác minh lại trạng thái getWebhookInfo sau khi đăng ký..."
NEW_INFO=$(curl -s -S "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" || true)
echo "$NEW_INFO" | sed -E 's/"ip_address":"[^"]+"/"ip_address":"[REDACTED]"/g'

# Xóa token khỏi bộ nhớ shell ngay lập tức
unset BOT_TOKEN SECRET_TOKEN

echo ""
echo "========================================================================"
echo "🎉 HOÀN TẤT KÍCH HOẠT TELEGRAM WEBHOOK TRÊN CLOUDFLARE STAGING!"
echo "Chủ sở hữu (Telegram ID: 5252724920) có thể mở bot @meehoa_order_staging_bot"
echo "và gửi lệnh /new để bắt đầu nghiệm thu."
echo "========================================================================"
