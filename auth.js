const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { hashPassword, verifyPassword } = require('../auth');
const session = require('../session');
const email = require('../email');

const router = express.Router();

function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post('/signup', (req, res) => {
    const { name, email, password } = req.body || {};

    if (!name || !isValidEmail(email) || !password || password.length < 6) {
        return res.status(400).json({
            error: 'Please provide a name, a valid email, and a password of at least 6 characters.',
        });
    }

    const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email.toLowerCase());
    if (existing) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = hashPassword(password);
    const result = db
        .prepare('INSERT INTO customers (name, email, password_hash) VALUES (?, ?, ?)')
        .run(name, email.toLowerCase(), passwordHash);

    const token = session.createSession({ type: 'customer', customerId: result.lastInsertRowid });
    session.setSessionCookie(res, token);

    res.json({ id: result.lastInsertRowid, name, email: email.toLowerCase() });
});

router.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) {
        return res.status(400).json({ error: 'Please provide email and password.' });
    }

    const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email.toLowerCase());
    if (!customer || !verifyPassword(password, customer.password_hash)) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const token = session.createSession({ type: 'customer', customerId: customer.id });
    session.setSessionCookie(res, token);

    res.json({ id: customer.id, name: customer.name, email: customer.email });
});

router.post('/logout', (req, res) => {
    if (req.sessionToken) session.destroySession(req.sessionToken);
    session.clearSessionCookie(res);
    res.json({ ok: true });
});

router.get('/me', (req, res) => {
    if (!req.session || req.session.type !== 'customer') {
        return res.json({ loggedIn: false });
    }
    const customer = db.prepare('SELECT id, name, email FROM customers WHERE id = ?').get(req.session.customerId);
    if (!customer) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, customer });
});

/**
 * GET /api/auth/my-orders — order history for the logged-in customer.
 */
router.get('/my-orders', session.requireCustomer, (req, res) => {
    const orders = db
        .prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC')
        .all(req.session.customerId);

    const itemsStmt = db.prepare('SELECT product_name, unit_price_usd, qty FROM order_items WHERE order_id = ?');
    const withItems = orders.map((o) => ({ ...o, items: itemsStmt.all(o.id) }));

    res.json({ orders: withItems });
});

/**
 * GET /api/auth/wishlist — the logged-in customer's saved products.
 */
router.get('/wishlist', session.requireCustomer, (req, res) => {
    const items = db
        .prepare(`
            SELECT p.id, p.name, p.price_usd, p.image_url, p.spec, p.stock
            FROM wishlist w
            JOIN products p ON p.id = w.product_id
            WHERE w.customer_id = ?
            ORDER BY w.created_at DESC
        `)
        .all(req.session.customerId);

    res.json({ items });
});

/**
 * POST /api/auth/wishlist/toggle
 * body: { product_id }
 * Adds the product if it's not already saved, removes it if it is.
 * Returns the new state so the frontend knows which way it went.
 */
router.post('/wishlist/toggle', session.requireCustomer, (req, res) => {
    const { product_id } = req.body || {};
    if (!product_id) {
        return res.status(400).json({ error: 'product_id is required.' });
    }

    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(product_id);
    if (!product) {
        return res.status(404).json({ error: 'Product not found.' });
    }

    const existing = db
        .prepare('SELECT id FROM wishlist WHERE customer_id = ? AND product_id = ?')
        .get(req.session.customerId, product_id);

    if (existing) {
        db.prepare('DELETE FROM wishlist WHERE id = ?').run(existing.id);
        return res.json({ saved: false });
    }

    db.prepare('INSERT INTO wishlist (customer_id, product_id) VALUES (?, ?)').run(req.session.customerId, product_id);
    res.json({ saved: true });
});

/**
 * POST /api/auth/forgot-password
 * body: { email }
 *
 * Generates a real, securely-hashed, time-limited reset token, then
 * emails a reset link via Resend. If no RESEND_API_KEY is configured
 * (email.DEMO_MODE), falls back to returning the token directly in the
 * response so you can still test the whole flow locally without an
 * email service set up.
 */
router.post('/forgot-password', async (req, res) => {
    const { email: emailAddress } = req.body || {};
    if (!isValidEmail(emailAddress)) {
        return res.status(400).json({ error: 'Please provide a valid email.' });
    }

    const customer = db.prepare('SELECT id, name, email FROM customers WHERE email = ?').get(emailAddress.toLowerCase());

    if (!customer) {
        // In demo mode we still need to say clearly that there's no
        // account, since there's no real email to fall back on for
        // testing. Once real email is configured, return this same
        // generic response either way, so we don't leak which emails
        // are registered accounts.
        if (email.DEMO_MODE) {
            return res.status(404).json({ error: 'No account found with that email.' });
        }
        return res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes

    db.prepare('INSERT INTO password_resets (customer_id, token_hash, expires_at) VALUES (?, ?, ?)')
        .run(customer.id, tokenHash, expiresAt);

    if (email.DEMO_MODE) {
        return res.json({
            ok: true,
            demo_mode: true,
            demo_note: 'Email sending isn\'t configured yet, so here\'s your reset token directly (this would normally be emailed to you).',
            reset_token: rawToken,
            expires_in_minutes: 30,
        });
    }

    try {
        await email.sendPasswordResetEmail(customer.email, customer.name, rawToken);
    } catch (err) {
        console.error('Password reset email failed to send:', err.message);
        return res.status(500).json({ error: 'Could not send reset email. Please try again shortly.' });
    }

    res.json({ ok: true, message: 'Check your email for a link to reset your password.' });
});

/**
 * POST /api/auth/reset-password
 * body: { token, new_password }
 */
router.post('/reset-password', (req, res) => {
    const { token, new_password } = req.body || {};
    if (!token || !new_password || new_password.length < 6) {
        return res.status(400).json({ error: 'Token and a new password (6+ characters) are required.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRow = db
        .prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0')
        .get(tokenHash);

    if (!resetRow) {
        return res.status(400).json({ error: 'Invalid or already-used reset token.' });
    }
    if (new Date(resetRow.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const newHash = hashPassword(new_password);
    db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(newHash, resetRow.customer_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(resetRow.id);

    res.json({ ok: true });
});

module.exports = router;
