#!/usr/bin/env bash
# ==============================================================================
# MEEHOA Order Bot V1 — Kích hoạt Telegram Webhook An Toàn (Không lộ Token)
# ==============================================================================
# BẢO MẬT TUYỆT ĐỐI:
# 1. KHÔNG nhận token qua tham số dòng lệnh ($1, $2, ...) để tránh lưu vào
#    history shell (~/.zsh_history, ~/.bash_history) và danh sách tiến trình (ps aux).
# 2. Sử dụng `read -s` để che dấu token hoàn toàn khi nhập.
# 3. Sử dụng `curl --config -` để truyền URL có chứa bot token qua stdin cấu hình,
#    ngăn chặn tuyệt đối việc token xuất hiện trong command line arguments / ps.
# 4. Kiểm tra bắt buộc TELEGRAM_SECRET_TOKEN (tối thiểu 16 ký tự, không cho phép trống).
# 5. Trap EXIT tự động unset toàn bộ biến bí mật khỏi bộ nhớ shell khi kết thúc.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_CONFIG="$SCRIPT_DIR/wrangler.toml"
WORKER_URL="https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook"

# Đảm bảo xóa biến bộ nhớ khi thoát (kể cả khi bị ngắt bởi Ctrl+C hoặc gặp lỗi)
cleanup() {
  unset BOT_TOKEN SECRET_TOKEN GEN_SECRET 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. Từ chối nếu người dùng vô tình truyền token qua tham số dòng lệnh
if [ $# -gt 0 ]; then
  echo "❌ LỖI BẢO MẬT: Tuyệt đối không truyền Bot Token qua tham số dòng lệnh!"
  echo "👉 Vui lòng chỉ chạy: ./activate-webhook.sh (hệ thống sẽ yêu cầu nhập ẩn an toàn)."
  exit 1
fi

echo "========================================================================"
echo "🔐 MEEHOA ORDER BOT V1 — KÍCH HOẠT TELEGRAM WEBHOOK STAGING AN TOÀN"
echo "========================================================================"
echo "🎯 Worker đích : $WORKER_URL"
echo "📁 Config file  : $WORKER_CONFIG"
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
  echo "⚠️ Cảnh báo: Định dạng BOT_TOKEN có thể không đúng chuẩn Telegram (thường là 1234567890:ABC-DEF...)."
  echo -n "Bạn có chắc chắn muốn tiếp tục không? (y/N): "
  read -r CONFIRM
  if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
    echo "Đã hủy thao tác."
    exit 1
  fi
fi

# Hàm gọi Telegram API an toàn: truyền URL qua curl --config - để tránh lộ token trong ps aux
call_telegram_api() {
  local method="$1"
  shift
  printf "url = \"https://api.telegram.org/bot%s/%s\"\n" "$BOT_TOKEN" "$method" | curl -s -S --config - "$@"
}

# 3. Nhập hoặc sinh TELEGRAM_SECRET_TOKEN an toàn (không cho phép trống)
echo -n "👉 Nhập TELEGRAM_SECRET_TOKEN (min 16 ký tự, hoặc nhấn Enter để tự động tạo): "
read -r -s SECRET_TOKEN
echo ""

if [ -z "$SECRET_TOKEN" ]; then
  echo "ℹ️ Đang tự động tạo khóa bí mật an toàn (32 ký tự hex ngẫu nhiên)..."
  if command -v openssl >/dev/null 2>&1; then
    SECRET_TOKEN=$(openssl rand -hex 16)
  elif command -v node >/dev/null 2>&1; then
    SECRET_TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
  else
    SECRET_TOKEN=$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 32)
  fi
  echo "✅ Đã tạo TELEGRAM_SECRET_TOKEN an toàn thành công."
fi

if [ ${#SECRET_TOKEN} -lt 16 ] || [ ${#SECRET_TOKEN} -gt 256 ]; then
  echo "❌ Lỗi: TELEGRAM_SECRET_TOKEN phải có độ dài từ 16 đến 256 ký tự (hiện tại: ${#SECRET_TOKEN} ký tự)."
  exit 1
fi

# Chú ý: macOS libc regcomp giới hạn {m,n} tối đa 255 (RE_DUP_MAX).
# Do đó kiểm tra độ dài bằng ${#SECRET_TOKEN} và kiểm tra tập ký tự bằng ^[a-zA-Z0-9_-]+$
if ! [[ "$SECRET_TOKEN" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "❌ Lỗi: TELEGRAM_SECRET_TOKEN chỉ được chứa các ký tự A-Z, a-z, 0-9, _ và - theo chuẩn Telegram."
  exit 1
fi

echo ""
echo "⏳ [1/4] Đang nạp TELEGRAM_BOT_TOKEN vào Cloudflare Worker Secrets..."
if ! printf "%s" "$BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN --config "$WORKER_CONFIG" >/dev/null; then
  echo "❌ Thất bại khi nạp TELEGRAM_BOT_TOKEN vào Cloudflare Secrets. Vui lòng kiểm tra quyền Cloudflare."
  exit 1
fi
echo "✅ TELEGRAM_BOT_TOKEN đã nạp thành công vào Cloudflare Secrets."

echo "⏳ [2/4] Đang nạp TELEGRAM_SECRET_TOKEN vào Cloudflare Worker Secrets..."
if ! printf "%s" "$SECRET_TOKEN" | npx wrangler secret put TELEGRAM_SECRET_TOKEN --config "$WORKER_CONFIG" >/dev/null; then
  echo "❌ Thất bại khi nạp TELEGRAM_SECRET_TOKEN vào Cloudflare Secrets. Vui lòng kiểm tra quyền Cloudflare."
  exit 1
fi
echo "✅ TELEGRAM_SECRET_TOKEN đã nạp thành công vào Cloudflare Secrets."

echo ""
echo "⏳ [3/4] Đang kiểm tra trạng thái Webhook hiện tại qua getWebhookInfo..."
CURRENT_INFO=$(call_telegram_api "getWebhookInfo" || true)
echo "📋 Trạng thái trước kích hoạt:"
echo "$CURRENT_INFO" | sed -E 's/"ip_address":"[^"]+"/"ip_address":"[REDACTED]"/g'

echo ""
echo "⏳ [4/4] Đang đăng ký Telegram Webhook tới Cloudflare Worker..."
SET_PAYLOAD=$(printf '{"url":"%s","secret_token":"%s","allowed_updates":["message","callback_query"]}' "$WORKER_URL" "$SECRET_TOKEN")
SET_RES=$(call_telegram_api "setWebhook" \
  -H "Content-Type: application/json" \
  -d "$SET_PAYLOAD")

echo "📋 Kết quả đăng ký Webhook:"
echo "$SET_RES"

echo ""
echo "🔍 Xác minh lại trạng thái getWebhookInfo sau khi đăng ký:"
NEW_INFO=$(call_telegram_api "getWebhookInfo" || true)
echo "$NEW_INFO" | sed -E 's/"ip_address":"[^"]+"/"ip_address":"[REDACTED]"/g'

echo ""
echo "========================================================================"
echo "🎉 HOÀN TẤT KÍCH HOẠT TELEGRAM WEBHOOK TRÊN CLOUDFLARE STAGING!"
echo "Chủ sở hữu (Telegram ID: 5252724920) có thể mở bot @meehoa_order_staging_bot"
echo "và gửi lệnh /new để bắt đầu nghiệm thu."
echo "========================================================================"
