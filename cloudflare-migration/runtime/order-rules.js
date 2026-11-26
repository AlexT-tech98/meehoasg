const clean = v => String(v ?? '').trim();

export const BASE_ORDER_VALIDATION_RULES = {
  schemaVersion: '2026-11-26.v3',
  saleDefault: 'cmui',
  saleDefaultName: 'C Mụi',
  required: ['customer', 'flower', 'date', 'time', 'shipping', 'flowerTotal'],
  requireFlowerTotal: true,
  minFlowerTotal: 1,
  minDepositRatio: 0.5,
  depositBase: 'flowerTotal',
  conditionalRequired: [],
  conditionalReminders: [
    { field: 'address', when: { field: 'shipping', equals: 'Shop book ship' }, rejectPending: true }
  ],
  accessoryPrices: {
    cardUnitFee: 10000,
    bannerUnitFee: 35000
  },
  enums: {
    shipping: ['Shop book ship', 'Khách tự book', 'Ghé lấy'],
    statuses: ['Chờ bó', 'Đã bó', 'Đã giao']
  },
  supportedRuleFeatures: [
    'required_fields',
    'conditional_reminders',
    'accessory_unit_pricing',
    'min_deposit_ratio',
    'flower_total_required',
    'shipping_enum',
    'sale_default'
  ]
};

export function buildOrderRules(overrides = {}) {
  const phoneRequired = Boolean(overrides.phoneRequired ?? overrides.phone_required);
  const requireFlowerTotal = overrides.requireFlowerTotal !== undefined
    ? Boolean(overrides.requireFlowerTotal)
    : (overrides.require_flower_total !== undefined ? Boolean(overrides.require_flower_total) : true);
  const minDepositRatioRaw = Number(overrides.minDepositRatio ?? overrides.min_deposit_ratio ?? BASE_ORDER_VALIDATION_RULES.minDepositRatio);
  const minDepositRatio = Number.isFinite(minDepositRatioRaw) && minDepositRatioRaw >= 0 && minDepositRatioRaw <= 1
    ? minDepositRatioRaw
    : BASE_ORDER_VALIDATION_RULES.minDepositRatio;

  const baseRequired = ['customer', 'flower', 'date', 'time', 'shipping'];
  if (requireFlowerTotal) baseRequired.push('flowerTotal');
  if (phoneRequired) baseRequired.push('phone');

  return {
    ...BASE_ORDER_VALIDATION_RULES,
    schemaVersion: phoneRequired ? '2026-11-26.v3+phone' : BASE_ORDER_VALIDATION_RULES.schemaVersion,
    required: baseRequired,
    requireFlowerTotal,
    minDepositRatio,
    phoneRequired,
    source: overrides.source || 'default'
  };
}

/**
 * Load canonical OPS order validation rules from D1 `sync_config` (`row_key = 'order_rules'`)
 * and Worker env fallback. Both `getOrderRules` and `createOrder`/`updateOrder` read this exact helper.
 */
export async function loadOrderRules(dbBinding, env = {}) {
  const envPhoneRequired = String(env?.OPS_PHONE_REQUIRED || '').trim() === '1';
  let overrides = { source: 'default' };

  if (dbBinding && typeof dbBinding.prepare === 'function') {
    try {
      const row = await dbBinding.prepare('SELECT data FROM sync_config WHERE row_key = ?').bind('order_rules').first();
      if (row?.data) {
        const parsed = JSON.parse(row.data);
        if (parsed && typeof parsed === 'object') {
          overrides = {
            ...parsed,
            source: 'd1:sync_config/order_rules'
          };
        }
      }
    } catch {
      // Fall back cleanly to base rules when sync_config does not contain order_rules
    }
  }

  // env fallback: apply only if D1 didn't set phone_required / phoneRequired
  if (overrides.phoneRequired === undefined && overrides.phone_required === undefined) {
    overrides.phoneRequired = envPhoneRequired;
  }

  return buildOrderRules(overrides);
}

export function extractDepositPaymentAmount(payment) {
  const raw = clean(payment);
  if (!raw) return null;
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').replace(/\s+/g, ' ');
  if (/chua|full|du tien hoa|toan bo don|da tt|thanh toan du/.test(normalized)) return null;
  if (!/(?:coc|da thanh toan)/.test(normalized)) return null;
  const match = normalized.replace(/\s/g, '').match(/([0-9.,]+)(k|tr|trieu)?/);
  if (!match) return null;
  let numStr = match[1];
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(numStr)) numStr = numStr.replace(/[.,]/g, '');
  else numStr = numStr.replace(',', '.');
  let value = Number(numStr);
  if (!Number.isFinite(value)) return null;
  if (match[2] === 'tr' || match[2] === 'trieu') value *= 1000000;
  else if (match[2] === 'k') value *= 1000;
  return value;
}

/**
 * Validate flowerTotal > 0, dynamic required fields (e.g. phone), and >=50% deposit threshold
 * computed strictly on flower_total (excluding ship_fee and accessories).
 */
export function validateOrderRulesServer(normalizedOrder, rules = BASE_ORDER_VALIDATION_RULES) {
  const r = rules || BASE_ORDER_VALIDATION_RULES;
  const flowerTotal = Number(normalizedOrder?.flower_total ?? normalizedOrder?.flowerTotal ?? 0);

  if (r.requireFlowerTotal !== false) {
    const minFlower = Number(r.minFlowerTotal ?? 1);
    if (!Number.isFinite(flowerTotal) || flowerTotal < minFlower) {
      const err = new Error('Tiền hoa bắt buộc và phải lớn hơn 0 đ.');
      err.code = 'FLOWER_TOTAL_REQUIRED';
      throw err;
    }
  }

  const requiredSet = new Set(Array.isArray(r.required) ? r.required : []);
  if (requiredSet.has('phone') && !clean(normalizedOrder?.phone)) {
    const err = new Error('Số điện thoại khách hàng là bắt buộc theo quy tắc OPS hiện hành.');
    err.code = 'PHONE_REQUIRED';
    throw err;
  }

  const minRatio = Number(r.minDepositRatio ?? 0.5);
  if (Number.isFinite(minRatio) && minRatio > 0 && flowerTotal > 0) {
    const deposit = extractDepositPaymentAmount(normalizedOrder?.payment);
    if (deposit !== null) {
      const minDeposit = flowerTotal * minRatio;
      if (deposit < minDeposit) {
        const err = new Error(`Tiền cọc phải đạt tối thiểu ${Math.round(minRatio * 100)}% tiền hoa (không tính phí ship hay phụ kiện).`);
        err.code = 'DEPOSIT_BELOW_MIN_RATIO';
        throw err;
      }
    }
  }
}
