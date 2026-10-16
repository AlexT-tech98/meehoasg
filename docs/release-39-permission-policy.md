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
