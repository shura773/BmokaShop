const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const payway = require('../payway');
const { validateCoupon } = require('./coupons');
const { computeQuantityDiscount } = require('../promotions');

const router = express.Router();

const FLAT_SHIPPING = Number(process.env.FLAT_SHIPPING_USD || 6);

/**
 * POST /api/orders
 * body: {
 *   customer: { name, email, address },
 *   items: [{ product_id, qty }],
 *   payment_method: 'aba',
 *   coupon_code: 'WELCOME10' (optional)
 * }
 *
 * Guest checkout is allowed. If the customer is logged in, the order is
 * also linked to their account (customer_id).
 *
 * Prices, stock, coupon discounts, AND bulk-quantity discounts are never
 * trusted from the client — every line item is re-priced, stock is
 * re-checked, and any discount is recomputed from the database here.
 */
router.post('/', async (req, res) => {
    try {
        const { customer, items, payment_method, coupon_code } = req.body || {};

        if (!customer || !customer.name || !customer.email || !customer.address) {
            return res.status(400).json({ error: 'Missing customer name, email, or address.' });
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Cart is empty.' });
        }
        if (payment_method !== 'aba') {
            return res.status(400).json({ error: 'payment_method must be "aba".' });
        }

        const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
        let subtotal = 0;
        let totalQty = 0;
        const resolvedItems = [];

        for (const item of items) {
            const product = getProduct.get(item.product_id);
            if (!product) {
                return res.status(400).json({ error: `Unknown product: ${item.product_id}` });
            }
            const qty = Math.max(1, Math.floor(Number(item.qty) || 1));
            if (product.stock <= 0) {
                return res.status(400).json({ error: `${product.name} is sold out.` });
            }
            if (qty > product.stock) {
                return res.status(400).json({
                    error: `Only ${product.stock} left of ${product.name} — please lower the quantity.`,
                });
            }
            subtotal += product.price_usd * qty;
            totalQty += qty;
            resolvedItems.push({ product, qty });
        }
        subtotal = Number(subtotal.toFixed(2));

        // Re-validate any coupon against the DB — never trust a discount
        // amount the browser sends us.
        let couponDiscountUsd = 0;
        let appliedCouponCode = null;
        if (coupon_code && coupon_code.trim()) {
            const couponResult = validateCoupon(coupon_code, subtotal);
            if (!couponResult.valid) {
                return res.status(400).json({ error: couponResult.error });
            }
            couponDiscountUsd = couponResult.discount_usd;
            appliedCouponCode = couponResult.coupon.code;
        }

        // Automatic bulk-quantity discount (e.g. buy 10+, save 5%) — this
        // is separate from coupons and applies with no code needed. Both
        // can combine, but the total discount is capped at the subtotal
        // so a total can never go negative.
        const qtyDiscountResult = computeQuantityDiscount(totalQty, subtotal);
        const qtyDiscountUsd = qtyDiscountResult.discount_usd;
        const qtyDiscountPercent = qtyDiscountResult.percent;

        const combinedDiscount = Math.min(couponDiscountUsd + qtyDiscountUsd, subtotal);

        const shipping = FLAT_SHIPPING;
        const total = Number((subtotal - combinedDiscount + shipping).toFixed(2));
        const tranId = 'MS-' + crypto.randomBytes(6).toString('hex').toUpperCase();

        // If the customer is logged in, link the order to their account.
        // Guest checkout (no account) still works fine — customer_id stays null.
        const customerId = req.session && req.session.type === 'customer' ? req.session.customerId : null;

        // --- Everything below runs as one atomic transaction: create the
        // order, create its line items, decrement stock for each product,
        // AND increment the coupon's usage count — all together, or none
        // of it, so nothing can end up wrong even if something fails
        // halfway through. ---
        let orderId;
        db.exec('BEGIN');
        try {
            const insertOrder = db.prepare(`
                INSERT INTO orders
                    (tran_id, customer_id, customer_name, customer_email, shipping_address, payment_method,
                     subtotal_usd, shipping_usd, total_usd, coupon_code, discount_usd,
                     qty_discount_usd, qty_discount_percent, status, demo_mode)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
            `);
            const orderInfo = insertOrder.run(
                tranId,
                customerId,
                customer.name,
                customer.email,
                customer.address,
                payment_method,
                subtotal,
                shipping,
                total,
                appliedCouponCode,
                couponDiscountUsd,
                qtyDiscountUsd,
                qtyDiscountPercent,
                payway.DEMO_MODE ? 1 : 0
            );
            orderId = orderInfo.lastInsertRowid;

            const insertItem = db.prepare(`
                INSERT INTO order_items (order_id, product_id, product_name, unit_price_usd, qty)
                VALUES (?, ?, ?, ?, ?)
            `);
            const decrementStock = db.prepare(`
                UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?
            `);

            for (const { product, qty } of resolvedItems) {
                insertItem.run(orderId, product.id, product.name, product.price_usd, qty);

                // Guard against a race: if stock changed between our read
                // above and now, this UPDATE simply won't match any row
                // (stock >= qty fails), and we roll back the whole order.
                const result = decrementStock.run(qty, product.id, qty);
                if (result.changes === 0) {
                    throw new Error(`STOCK_RACE:${product.name}`);
                }
            }

            if (appliedCouponCode) {
                db.prepare('UPDATE coupons SET times_used = times_used + 1 WHERE code = ?').run(appliedCouponCode);
            }

            db.exec('COMMIT');
        } catch (txErr) {
            db.exec('ROLLBACK');
            if (String(txErr.message).startsWith('STOCK_RACE:')) {
                const productName = txErr.message.split(':')[1];
                return res.status(409).json({
                    error: `${productName} just sold out — someone else grabbed the last one. Please adjust your cart.`,
                });
            }
            throw txErr;
        }

        const itemsDescription = resolvedItems.map((i) => `${i.product.name} x${i.qty}`).join(', ');

        const payment = await payway.createPayment({
            tranId,
            amountUsd: total,
            itemsDescription,
            paymentMethod: payment_method,
        });

        res.json({
            order_id: orderId,
            tran_id: tranId,
            subtotal,
            coupon_discount_usd: couponDiscountUsd,
            coupon_code: appliedCouponCode,
            qty_discount_usd: qtyDiscountUsd,
            qty_discount_percent: qtyDiscountPercent,
            discount_usd: combinedDiscount,
            shipping,
            total,
            demo: payment.demo,
            payment: {
                qr_image_url: payment.qrImageUrl,
                qr_string: payment.qrString,
                deeplink: payment.deeplink,
            },
        });
    } catch (err) {
        console.error('Create order failed:', err);
        res.status(500).json({ error: 'Failed to create order.' });
    }
});

/**
 * GET /api/orders/:id
 * Frontend polls this while the customer is looking at the QR screen.
 */
router.get('/:id', (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    const items = db.prepare('SELECT product_name, unit_price_usd, qty FROM order_items WHERE order_id = ?').all(order.id);

    res.json({ order: { ...order, items } });
});

module.exports = router;
