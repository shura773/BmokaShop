const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const db = require('../db');
const session = require('../session');

const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ---------------------------------------------------------------------
// Image uploads for products. Files are saved into public/uploads/products
// so they're served automatically by the static file server, and get a
// random filename (never the original name) to avoid path-traversal or
// filename-collision tricks.
// ---------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.jpg';
            cb(null, crypto.randomBytes(12).toString('hex') + safeExt);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const looksLikeImage = file.mimetype.startsWith('image/') && ALLOWED_EXTENSIONS.has(ext);
        cb(looksLikeImage ? null : new Error('Only JPG, PNG, WEBP, or GIF images are allowed.'), looksLikeImage);
    },
});

function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

router.post('/login', (req, res) => {
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
        return res.status(500).json({
            error: 'Admin login is not configured yet. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env.',
        });
    }

    const { username, password } = req.body || {};
    const usernameOk = username && timingSafeStringEqual(username, ADMIN_USERNAME);
    const passwordOk = password && timingSafeStringEqual(password, ADMIN_PASSWORD);

    if (!usernameOk || !passwordOk) {
        return res.status(401).json({ error: 'Incorrect username or password.' });
    }

    const token = session.createSession({ type: 'admin' });
    session.setSessionCookie(res, token);
    res.json({ ok: true });
});

router.post('/logout', (req, res) => {
    if (req.sessionToken) session.destroySession(req.sessionToken);
    session.clearSessionCookie(res);
    res.json({ ok: true });
});

router.get('/me', (req, res) => {
    res.json({ loggedIn: !!(req.session && req.session.type === 'admin') });
});

// everything below this line requires an admin session
router.use(session.requireAdmin);

/**
 * POST /api/admin/upload
 * multipart/form-data with a single field "image".
 * Returns { url: '/uploads/products/xxxx.jpg' } — use that as the
 * product's image_url when creating/editing a product.
 */
router.post('/upload', (req, res) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            const message = err.code === 'LIMIT_FILE_SIZE'
                ? 'Image is too large — 5MB max.'
                : err.message || 'Upload failed.';
            return res.status(400).json({ error: message });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No image file received.' });
        }
        res.json({ url: '/uploads/products/' + req.file.filename });
    });
});

router.get('/orders', (req, res) => {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    const itemsStmt = db.prepare('SELECT product_name, unit_price_usd, qty FROM order_items WHERE order_id = ?');
    const withItems = orders.map((o) => ({ ...o, items: itemsStmt.all(o.id) }));
    res.json({ orders: withItems });
});

router.put('/orders/:id/status', (req, res) => {
    const { status } = req.body || {};
    const allowed = ['pending', 'paid', 'shipped', 'cancelled', 'failed'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    const wasAlreadyTerminal = order.status === 'cancelled' || order.status === 'failed';
    const isNowTerminal = status === 'cancelled' || status === 'failed';

    db.exec('BEGIN');
    try {
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);

        // Give the stock back if this order is newly cancelled/failed
        // (and wasn't already in that state, so re-saving the same
        // status twice doesn't double-restock).
        if (isNowTerminal && !wasAlreadyTerminal) {
            const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(order.id);
            const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
            for (const item of items) {
                restock.run(item.qty, item.product_id);
            }
        }

        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Order status update failed:', err);
        return res.status(500).json({ error: 'Could not update order status.' });
    }

    res.json({ ok: true });
});

router.get('/products', (req, res) => {
    const products = db.prepare('SELECT * FROM products').all();
    res.json({ products });
});

function slugify(name) {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

/**
 * POST /api/admin/products
 * body: { name, price_usd, stock, category, spec, description, image_url, id? }
 * Creates a new product. If no id is given, one is generated from the
 * name (e.g. "Wool Scarf" -> "wool-scarf"), with a numeric suffix if
 * that slug is already taken.
 */
router.post('/products', (req, res) => {
    const { name, price_usd, stock, category, spec, description, image_url } = req.body || {};
    let { id } = req.body || {};

    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Product name is required.' });
    }
    const price = Number(price_usd);
    if (Number.isNaN(price) || price < 0) {
        return res.status(400).json({ error: 'price_usd must be a non-negative number.' });
    }
    const stockNum = stock !== undefined ? Math.max(0, Math.floor(Number(stock))) : 0;

    if (!id || !id.trim()) {
        id = slugify(name);
    } else {
        id = slugify(id);
    }
    if (!id) {
        return res.status(400).json({ error: 'Could not generate a valid product ID from that name.' });
    }

    // ensure uniqueness — append -2, -3, etc. if the slug is taken
    let finalId = id;
    let suffix = 2;
    while (db.prepare('SELECT id FROM products WHERE id = ?').get(finalId)) {
        finalId = `${id}-${suffix}`;
        suffix += 1;
    }

    db.prepare(`
        INSERT INTO products (id, name, price_usd, image_url, spec, description, stock, category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        finalId,
        name.trim(),
        price,
        image_url || '',
        spec || '',
        description || '',
        stockNum,
        (category || 'general').trim().toLowerCase()
    );

    res.json({ ok: true, id: finalId });
});

/**
 * DELETE /api/admin/products/:id
 * Historical orders keep working fine after this — order_items already
 * stores its own snapshot of the product name/price from when the order
 * was placed, so deleting the live product doesn't break past records.
 */
router.delete('/products/:id', (req, res) => {
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM wishlist WHERE product_id = ?').run(product.id);
        db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error('Product delete failed:', err);
        return res.status(500).json({ error: 'Could not delete product.' });
    }

    res.json({ ok: true });
});

router.put('/products/:id', (req, res) => {
    const { price_usd, stock } = req.body || {};
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const newPrice = price_usd !== undefined ? Number(price_usd) : product.price_usd;
    const newStock = stock !== undefined ? Math.max(0, Math.floor(Number(stock))) : product.stock;

    if (Number.isNaN(newPrice) || newPrice < 0) {
        return res.status(400).json({ error: 'price_usd must be a non-negative number.' });
    }

    db.prepare('UPDATE products SET price_usd = ?, stock = ? WHERE id = ?').run(newPrice, newStock, product.id);
    res.json({ ok: true });
});

// ---------------------------------------------------------------------
// CSV export — opens directly in Excel/Google Sheets, no extra software
// or database driver needed. This is the "connect with Excel" feature.
// ---------------------------------------------------------------------
function toCsvValue(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function rowsToCsv(headers, rows) {
    const lines = [headers.join(',')];
    for (const row of rows) {
        lines.push(headers.map((h) => toCsvValue(row[h])).join(','));
    }
    return lines.join('\r\n');
}

router.get('/export/orders.csv', (req, res) => {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    const headers = [
        'id', 'tran_id', 'customer_name', 'customer_email', 'shipping_address',
        'payment_method', 'subtotal_usd', 'shipping_usd', 'total_usd', 'status',
        'demo_mode', 'created_at', 'paid_at',
    ];
    const csv = rowsToCsv(headers, orders);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(csv);
});

router.get('/export/products.csv', (req, res) => {
    const products = db.prepare('SELECT * FROM products').all();
    const headers = ['id', 'name', 'price_usd', 'stock', 'category', 'spec', 'description', 'image_url'];
    const csv = rowsToCsv(headers, products);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    res.send(csv);
});

// ---------------------------------------------------------------------
// Bulk quantity discounts — e.g. "buy 10+ items, save 5%". Applies
// automatically at checkout, no code needed (unlike coupons).
// ---------------------------------------------------------------------
router.get('/quantity-discounts', (req, res) => {
    const tiers = db.prepare('SELECT * FROM quantity_discounts ORDER BY min_qty ASC').all();
    res.json({ tiers });
});

router.post('/quantity-discounts', (req, res) => {
    const { min_qty, discount_percent } = req.body || {};
    const minQty = Math.floor(Number(min_qty));
    const percent = Number(discount_percent);

    if (!Number.isFinite(minQty) || minQty < 1) {
        return res.status(400).json({ error: 'min_qty must be a whole number of 1 or more.' });
    }
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        return res.status(400).json({ error: 'discount_percent must be between 0 and 100.' });
    }

    const result = db
        .prepare('INSERT INTO quantity_discounts (min_qty, discount_percent, active) VALUES (?, ?, 1)')
        .run(minQty, percent);

    res.json({ ok: true, id: result.lastInsertRowid });
});

router.put('/quantity-discounts/:id', (req, res) => {
    const tier = db.prepare('SELECT * FROM quantity_discounts WHERE id = ?').get(req.params.id);
    if (!tier) return res.status(404).json({ error: 'Tier not found.' });

    const { min_qty, discount_percent, active } = req.body || {};
    const minQty = min_qty !== undefined ? Math.floor(Number(min_qty)) : tier.min_qty;
    const percent = discount_percent !== undefined ? Number(discount_percent) : tier.discount_percent;
    const isActive = active !== undefined ? (active ? 1 : 0) : tier.active;

    if (!Number.isFinite(minQty) || minQty < 1) {
        return res.status(400).json({ error: 'min_qty must be a whole number of 1 or more.' });
    }
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
        return res.status(400).json({ error: 'discount_percent must be between 0 and 100.' });
    }

    db.prepare('UPDATE quantity_discounts SET min_qty = ?, discount_percent = ?, active = ? WHERE id = ?')
        .run(minQty, percent, isActive, tier.id);

    res.json({ ok: true });
});

router.delete('/quantity-discounts/:id', (req, res) => {
    const tier = db.prepare('SELECT id FROM quantity_discounts WHERE id = ?').get(req.params.id);
    if (!tier) return res.status(404).json({ error: 'Tier not found.' });
    db.prepare('DELETE FROM quantity_discounts WHERE id = ?').run(tier.id);
    res.json({ ok: true });
});

module.exports = router;
