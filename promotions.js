const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * GET /api/promotions/quantity-discounts
 * Public — active tiers only, so the storefront can show "Buy 10+, save
 * 5%!" style messaging and preview the discount before checkout. The
 * authoritative calculation always happens again server-side in
 * routes/orders.js when the order is actually placed.
 */
router.get('/quantity-discounts', (req, res) => {
    const tiers = db
        .prepare('SELECT min_qty, discount_percent FROM quantity_discounts WHERE active = 1 ORDER BY min_qty ASC')
        .all();
    res.json({ tiers });
});

module.exports = router;
