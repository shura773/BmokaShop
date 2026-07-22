const express = require('express');
const db = require('../db');
const payway = require('../payway');
const email = require('../email');

const router = express.Router();

/**
 * Sends the order confirmation email and never lets an email failure
 * break the payment-confirmation flow itself — the order is already
 * marked paid in the database regardless of whether the email succeeds.
 */
async function sendConfirmationEmailSafely(orderId) {
    try {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        const items = db
            .prepare('SELECT product_name, unit_price_usd, qty FROM order_items WHERE order_id = ?')
            .all(orderId);
        await email.sendOrderConfirmationEmail({ ...order, items });
    } catch (err) {
        console.error('Order confirmation email failed to send:', err.message);
    }
}

/**
 * POST /api/webhook/payway
 * PayWay calls this once a payment succeeds. Requires your server to be
 * publicly reachable over HTTPS (won't work on localhost — deploy first,
 * or tunnel with something like ngrok during testing).
 *
 * ⚠️ Confirm the exact payload field names (esp. which field carries YOUR
 * tran_id back to you — 'merchant_ref' vs 'tran_id' vs something else)
 * against a real sandbox test payment once you have credentials.
 */
router.post('/payway', async (req, res) => {
    const receivedSignature = req.header('X-PAYWAY-HMAC-SHA512') || req.header('x-payway-hmac-sha512');

    if (!payway.verifyWebhookSignature(req.body, receivedSignature)) {
        console.warn('PayWay webhook: signature verification failed.');
        return res.status(401).json({ error: 'Invalid signature.' });
    }

    const body = req.body || {};
    const ourTranId = body.merchant_ref || body.tran_id;
    const isApproved = body.payment_status === 'APPROVED' || body.payment_status_code === 0;

    if (!ourTranId) {
        console.warn('PayWay webhook: no tran_id/merchant_ref in payload.', body);
        return res.status(400).json({ error: 'Missing transaction reference.' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE tran_id = ?').get(ourTranId);
    if (!order) {
        console.warn('PayWay webhook: no matching order for', ourTranId);
        return res.status(404).json({ error: 'Order not found.' });
    }

    if (isApproved) {
        db.prepare(`
            UPDATE orders
            SET status = 'paid',
                payway_transaction_id = ?,
                payway_bank_ref = ?,
                paid_at = datetime('now')
            WHERE id = ?
        `).run(body.transaction_id || null, body.bank_ref || null, order.id);

        await sendConfirmationEmailSafely(order.id);
    } else {
        db.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?`).run(order.id);
    }

    res.json({ received: true });
});

/**
 * POST /api/webhook/simulate-paid/:orderId
 * DEMO-MODE ONLY. Lets you test the full flow locally (cart → QR →
 * "paid" → confirmation) without a real bank, since PayWay can't reach
 * your laptop's localhost to send a real webhook. Disabled automatically
 * once PAYWAY_MERCHANT_ID / PAYWAY_API_KEY are set.
 */
router.post('/simulate-paid/:orderId', async (req, res) => {
    if (!payway.DEMO_MODE) {
        return res.status(403).json({ error: 'Simulation is disabled outside demo mode.' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    db.prepare(`
        UPDATE orders
        SET status = 'paid', payway_transaction_id = 'DEMO-TXN', paid_at = datetime('now')
        WHERE id = ?
    `).run(order.id);

    await sendConfirmationEmailSafely(order.id);

    res.json({ ok: true });
});

module.exports = router;
