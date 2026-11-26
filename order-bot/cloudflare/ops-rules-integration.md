# OPS order rules — nguồn mã `cloudflare-migration/` và đề xuất tích hợp

Ngày lập: 2026-11-26 · Nhánh: `feat/meehoa-order-bot-v1` (Draft PR #65)

## 1. Dịch vụ OPS Staging mà bot đang gọi

| Hạng mục | Giá trị |
|---|---|
| Worker | `meehoasg-ops-staging` (`https://meehoasg-ops-staging.meehoasg.workers.dev`) |
| Mã nguồn triển khai | thư mục `cloudflare-migration/` (entry `runtime/entry.js`, assets `dist/`) |
| D1 | `meehoasg-ops-staging` (`16bf0134-64c6-43ea-8098-b40c95251667`) |
| R2 | `meehoasg-media-staging` |
| Bot gọi qua | Service binding `OPS_SERVICE` → `/api-core` |

## 2. Chủ sở hữu và lý do nằm ngoài Git

- Thư mục được tạo ngày 2026-10-14 trong đợt chuyển OPS sang Cloudflare (`HANDOFF_2026-10-14.md`), tài khoản Cloudflare của owner.
- Theo handoff: "Migration files are still untracked, not committed or pushed; no PR exists." Nhánh nguồn `codex/cloudflare-full-migration` chỉ có ở máy local, **không có trên `origin`** (kiểm tra `git ls-remote --heads origin` ngày 2026-11-26 không thấy).
- Thư mục chứa cả dữ liệu không được commit: `generated/` (dump/schema từ dữ liệu thật), `live-snapshot/`, `node_modules/`, file `.before-*`, script import dữ liệu.

## 3. Điểm vướng cụ thể

1. **Không review được qua PR #65**: mọi thay đổi quy tắc OPS (file dưới) hiện chỉ tồn tại trong thư mục untracked.
2. **Bẫy build**: `npm run build` chạy `build-backend.mjs`, script này **ghi đè** `runtime/core.js` và `runtime/legacy.js` từ `live-snapshot/`, xóa thay đổi quy tắc. Chỉ được chạy `node build-frontend.mjs` rồi `wrangler deploy`.
3. **Test của bot phụ thuộc thư mục untracked**: `tests/order-bot-ops-contract.test.cjs` (Contract 14–23) và `tests/helpers/conversation-benchmark.mjs` nạp `cloudflare-migration/runtime/core.js` và `cloudflare-migration/generated/schema.sql`. CI trên clone sạch sẽ thiếu các file này.
4. `generated/schema.sql` sinh từ dữ liệu thật; cần tách bản schema-only trước khi commit.
5. Handoff ghi `runtime/operations.js` chưa đạt parity đầy đủ với SQL production → Staging hợp lệ để nghiệm thu bot, **không** dùng làm căn cứ cutover Production.

## 4. Thay đổi quy tắc trong `cloudflare-migration/` (chưa có trong Git)

| File | Thay đổi |
|---|---|
| `runtime/order-rules.js` (mới) | `loadOrderRules(DB, env)` đọc D1 `sync_config` row `order_rules` (+ fallback `OPS_PHONE_REQUIRED`); `validateOrderRulesServer` chặn tiền hoa < 1, thiếu SĐT khi bắt buộc, cọc < 50% tiền hoa (không tính ship/phụ kiện, đúng 50% đạt) |
| `runtime/operation-service.js` | `createOrder`/`updateOrder` kiểm tra quy tắc trước khi ghi |
| `runtime/operations.js` | Kiểm tra lại trong lớp mutate (`mee_ops_mutate`) |
| `runtime/core.js` | `getOrderRules` trả `rules` + `caller.canAssignDefaultSale`; bootstrap trả `orderRules` |
| `runtime/legacy.js` | `getAppOptions` trả `rules` |
| `public/html` → `dist/html` | Form đọc `getOrderRules`, áp dụng SĐT bắt buộc / tiền hoa / ngưỡng cọc |
| `tests/order-rules.test.mjs` (mới) | 33 test cho quy tắc, cùng nguồn đọc, chặn API trực tiếp, bật/tắt `phone_required` và đối chiếu Form vs Bot |

## 5. Đề xuất tích hợp có thể review

1. Owner xác nhận `cloudflare-migration/` là nguồn chính thức của OPS Staging.
2. Tạo nhánh `feat/ops-cloudflare-runtime` từ `origin/main`, chỉ commit: `runtime/`, `public/`, `build-*.mjs`, `wrangler.toml`, `package*.json`, `tests/`, tài liệu. Thêm `.gitignore` cho `generated/`, `live-snapshot/`, `dist/`, `node_modules/`, `*.before-*`, `.dev.vars`, `private-backup/`.
3. Thêm `cloudflare-migration/schema/schema.sql` (chỉ DDL, không dữ liệu) và cho test của bot dùng file này.
4. Sửa `package.json`: tách `build:backend` (thao tác chủ động, có cảnh báo) khỏi `build` mặc định (= `build-frontend.mjs`), tránh ghi đè runtime.
5. Mở PR riêng cho OPS runtime; PR #65 phụ thuộc PR đó. Merge OPS trước, rồi rebase PR #65.
