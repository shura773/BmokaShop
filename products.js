const express = require('express');
const db = require('../db');

const router = express.Router();

const SORT_OPTIONS = {
    newest: 'created_at DESC',
    price_asc: 'price_usd ASC',
    price_desc: 'price_usd DESC',
    name: 'name ASC',
    popular: 'stock ASC', // simple stand-in for "popularity" until real order-count based ranking exists
};

/**
 * GET /api/products
 * Optional query params: category, sort, search
 */
router.get('/', (req, res) => {
    const { category, sort, search } = req.query;

    let sql = 'SELECT id, name, price_usd, image_url, spec, description, stock, category, created_at FROM products WHERE 1=1';
    const params = [];

    if (category && category !== 'all') {
        sql += ' AND category = ?';
        params.push(category);
    }

    if (search && search.trim()) {
        sql += ' AND (name LIKE ? OR description LIKE ? OR spec LIKE ?)';
        const like = `%${search.trim()}%`;
        params.push(like, like, like);
    }

    const orderBy = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;
    sql += ` ORDER BY ${orderBy}`;

    const products = db.prepare(sql).all(...params);
    res.json({ products });
});

/**
 * GET /api/products/categories
 * Returns the distinct list of categories with a product count each,
 * for building filter menus.
 */
router.get('/categories', (req, res) => {
    const categories = db
        .prepare('SELECT category, COUNT(*) AS count FROM products GROUP BY category ORDER BY category ASC')
        .all();
    res.json({ categories });
});

/**
 * GET /api/products/:id
 * Single product detail.
 */
router.get('/:id', (req, res) => {
    const product = db
        .prepare('SELECT id, name, price_usd, image_url, spec, description, stock, category, created_at FROM products WHERE id = ?')
        .get(req.params.id);

    if (!product) {
        return res.status(404).json({ error: 'Product not found.' });
    }
    res.json({ product });
});

/**
 * GET /api/products/:id/related
 * Other products in the same category, excluding this one.
 */
router.get('/:id/related', (req, res) => {
    const product = db.prepare('SELECT category FROM products WHERE id = ?').get(req.params.id);
    if (!product) {
        return res.status(404).json({ error: 'Product not found.' });
    }

    const related = db
        .prepare('SELECT id, name, price_usd, image_url, spec, stock FROM products WHERE category = ? AND id != ? LIMIT 4')
        .all(product.category, req.params.id);

    res.json({ related });
});

module.exports = router;
