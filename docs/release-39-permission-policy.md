# Approved operational permission policy

Owner approval received in this conversation on 16 October 2026 (Asia/Saigon): **“Đồng ý phạm vi toàn bộ như PR #39 đang đề xuất.”**

The approved question explicitly stated the following matrix. This is authorization for the release policy; it is not authorization to merge/deploy or alter production data.

| Capability | ADMIN active | SALE active | THO_OPS active | Inactive/anonymous |
|---|---|---|---|---|
| View all eligible shop debts | Yes | Yes | Yes | No |
| Submit settlement on any eligible order | Yes | Yes | Yes | No |
| Approve/reject settlement | Yes | No | No | No |
| Edit an unlocked Sale-owned order | Yes | Own orders only | Yes, existing operations policy | No |

Eligible debt still requires delivered status, unverified payment and debt > 0. Submission still requires current order version, bill evidence, confirmed shop shipping fee when applicable, and no conflicting pending/approved request. Full Paid and settled orders remain excluded. Cross-Sale submission does not grant cross-Sale editing or approval. Current API/RPC code and authenticated local/CI role tests enforce these rules.

## Superseding owner correction — 16 October 2026

The owner clarified after deployment: **“Đơn sale phụ trách là Tiên -> công nợ phải là Tiên và chỉ tiên gửi tất toán được đơn của tiên.”** This explicitly supersedes the earlier all-shop submission approval above.

Active staff, including THO_OPS, see only eligible debts assigned to their own username/display name. Caller-supplied Sale filters cannot widen that scope. ADMIN retains shop-wide review/filtering and Admin-only approval/rejection. **Every role, including ADMIN, may submit a new settlement only for an order assigned to that account.** The database enforces ownership, the shared API rejects foreign submissions before bill upload, and both core/legacy readers suppress foreign submission controls. Unknown owners fail closed. Existing financial amounts and historical requests are not rewritten by this policy correction.

Rollback must retain these owner-scoped backend/SQL checks. The packaged compatible fallback is frontend-only; older all-shop API readers are prohibited.
