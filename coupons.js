const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * Shared validation logic used both by the "Apply" button (preview) and
 * by order creation (authoritative). Never trust a discount amount sent
 * from the browser — always recompute it here from the DB.
 */
function validateCoupon(code, subtotal) {
    if (!code || !code.trim()) {
        return { valid: false, error: 'Enter a coupon code.' };
    }

    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code.trim().toUpperCase());
    if (!coupon) {
        return { valid: false, error: 'That coupon code doesn\'t exist.' };
    }
    if (!coupon.active) {
        return { valid: false, error: 'That coupon is no longer active.' };
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        return { valid: false, error: 'That coupon has expired.' };
    }
    if (coupon.usage_limit !== null && coupon.times_used >= coupon.usage_limit) {
        return { valid: false, error: 'That coupon has reached its usage limit.' };
    }
    if (subtotal < coupon.min_order_usd) {
        return { valid: false, error: `This coupon needs an order of at least $${coupon.min_order_usd}.` };
    }

    let discount = coupon.discount_type === 'percent'
        ? subtotal * (coupon.discount_value / 100)
        : coupon.discount_value;

    // never let a discount exceed the subtotal itself
    discount = Math.min(discount, subtotal);
    discount = Number(discount.toFixed(2));

    return { valid: true, coupon, discount_usd: discount };
}

/**
 * POST /api/coupons/validate
 * body: { code, subtotal }
 * Used by the "Apply" button at checkout to preview the discount.
 */
router.post('/validate', (req, res) => {
    const { code, subtotal } = req.body || {};
    const sub = Number(subtotal);

    if (Number.isNaN(sub) || sub < 0) {
        return res.status(400).json({ valid: false, error: 'Invalid subtotal.' });
    }

    const result = validateCoupon(code, sub);
    if (!result.valid) {
        return res.status(400).json(result);
    }

    res.json({
        valid: true,
        code: result.coupon.code,
        discount_usd: result.discount_usd,
        discount_type: result.coupon.discount_type,
        discount_value: result.coupon.discount_value,
    });
});

module.exports = router;
module.exports.validateCoupon = validateCoupon;
