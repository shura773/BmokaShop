const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'shop.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_usd REAL NOT NULL,
    image_url TEXT,
    spec TEXT,
    description TEXT,
    stock INTEGER NOT NULL DEFAULT 100,
    category TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tran_id TEXT UNIQUE NOT NULL,       -- what we send to PayWay as tran_id
    customer_id INTEGER REFERENCES customers(id),
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    shipping_address TEXT NOT NULL,
    payment_method TEXT NOT NULL,        -- 'aba'
    subtotal_usd REAL NOT NULL,
    shipping_usd REAL NOT NULL,
    total_usd REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | cancelled | shipped
    payway_transaction_id TEXT,
    payway_bank_ref TEXT,
    demo_mode INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    product_name TEXT NOT NULL,
    unit_price_usd REAL NOT NULL,
    qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT NOT NULL,       -- 'percent' | 'fixed'
    discount_value REAL NOT NULL,      -- 10 = 10% if percent, or $10 if fixed
    min_order_usd REAL NOT NULL DEFAULT 0,
    usage_limit INTEGER,               -- NULL = unlimited
    times_used INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,                   -- NULL = never expires
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    product_id TEXT NOT NULL REFERENCES products(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quantity_discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    min_qty INTEGER NOT NULL,        -- e.g. 10 = "buy 10 or more items"
    discount_percent REAL NOT NULL,  -- e.g. 5 = 5% off the subtotal
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// --- migration: add customer_id to orders if this DB predates accounts ---
const orderCols = db.prepare("PRAGMA table_info(orders)").all();
if (!orderCols.some((c) => c.name === 'customer_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
    console.log('Migrated: added customer_id to orders table.');
}
if (!orderCols.some((c) => c.name === 'coupon_code')) {
    db.exec('ALTER TABLE orders ADD COLUMN coupon_code TEXT');
    console.log('Migrated: added coupon_code to orders table.');
}
if (!orderCols.some((c) => c.name === 'discount_usd')) {
    db.exec('ALTER TABLE orders ADD COLUMN discount_usd REAL NOT NULL DEFAULT 0');
    console.log('Migrated: added discount_usd to orders table.');
}
if (!orderCols.some((c) => c.name === 'qty_discount_usd')) {
    db.exec('ALTER TABLE orders ADD COLUMN qty_discount_usd REAL NOT NULL DEFAULT 0');
    console.log('Migrated: added qty_discount_usd to orders table.');
}
if (!orderCols.some((c) => c.name === 'qty_discount_percent')) {
    db.exec('ALTER TABLE orders ADD COLUMN qty_discount_percent REAL NOT NULL DEFAULT 0');
    console.log('Migrated: added qty_discount_percent to orders table.');
}

// --- migration: add category / created_at to products if this DB predates them ---
const productCols = db.prepare("PRAGMA table_info(products)").all();
if (!productCols.some((c) => c.name === 'category')) {
    db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'general'");
    console.log('Migrated: added category to products table.');
}
if (!productCols.some((c) => c.name === 'created_at')) {
    db.exec('ALTER TABLE products ADD COLUMN created_at TEXT');
    db.exec("UPDATE products SET created_at = datetime('now') WHERE created_at IS NULL");
    console.log('Migrated: added created_at to products table.');
}

// --- seed products (only if table is empty) ---
const countRow = db.prepare('SELECT COUNT(*) AS n FROM products').get();
if (countRow.n === 0) {
    const seed = db.prepare(`
        INSERT INTO products (id, name, price_usd, image_url, spec, description, stock, category, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const products = [
        ['shoes', 'Running Shoes', 79, 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600', 'Mesh Upper / Rubber Sole', 'Comfortable and stylish, built for daily mileage.', 40, 'footwear', '2026-01-10 09:00:00'],
        ['tshirt', 'T-Shirt', 25, 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=600', '100% Cotton / Preshrunk', 'Premium quality cotton, cut for everyday wear.', 120, 'apparel', '2026-01-15 09:00:00'],
        ['headphones', 'Headphones', 120, 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=600', 'Over-Ear / Wireless', 'Crystal clear sound with all-day comfort.', 25, 'electronics', '2026-02-01 09:00:00'],
        ['backpack', 'Canvas Backpack', 64, 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600', 'Waxed Canvas / Leather Trim', 'Rugged daily carry that only looks better with wear.', 30, 'accessories', '2026-02-10 09:00:00'],
        ['jacket', 'Wool Field Jacket', 149, 'https://images.unsplash.com/photo-1491553895911-0055eca6402d?w=600', 'Water-Resistant / Wool Blend', 'Built for shifting weather, from trailhead to city.', 15, 'apparel', '2026-02-20 09:00:00'],
        ['bottle', 'Insulated Bottle', 34, 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=600', '18/8 Steel / 24oz', 'Keeps cold drinks cold and hot drinks hot, all day.', 60, 'accessories', '2026-03-01 09:00:00'],
    ];
    for (const p of products) seed.run(...p);
    console.log(`Seeded ${products.length} products.`);
} else {
    // backfill category/created_at for pre-existing rows created before this migration
    const needsBackfill = db.prepare("SELECT id FROM products WHERE category = 'general'").all();
    if (needsBackfill.length > 0) {
        const categoryMap = {
            shoes: 'footwear',
            tshirt: 'apparel',
            headphones: 'electronics',
            backpack: 'accessories',
            jacket: 'apparel',
            bottle: 'accessories',
        };
        const updateCat = db.prepare('UPDATE products SET category = ? WHERE id = ?');
        for (const row of needsBackfill) {
            if (categoryMap[row.id]) updateCat.run(categoryMap[row.id], row.id);
        }
        console.log('Backfilled categories for existing products.');
    }
}

// --- seed demo coupons (only if table is empty) ---
const couponCount = db.prepare('SELECT COUNT(*) AS n FROM coupons').get();
if (couponCount.n === 0) {
    const seedCoupon = db.prepare(`
        INSERT INTO coupons (code, discount_type, discount_value, min_order_usd, usage_limit, active, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    seedCoupon.run('WELCOME10', 'percent', 10, 0, null, 1, null);
    seedCoupon.run('SAVE5', 'fixed', 5, 30, null, 1, null);
    console.log('Seeded 2 demo coupons: WELCOME10 (10% off), SAVE5 ($5 off orders $30+).');
}

// --- seed demo bulk-quantity discount tiers (only if table is empty) ---
const qtyDiscountCount = db.prepare('SELECT COUNT(*) AS n FROM quantity_discounts').get();
if (qtyDiscountCount.n === 0) {
    const seedTier = db.prepare('INSERT INTO quantity_discounts (min_qty, discount_percent, active) VALUES (?, ?, ?)');
    seedTier.run(10, 5, 1);
    seedTier.run(20, 10, 1);
    console.log('Seeded 2 bulk discount tiers: 10+ items = 5% off, 20+ items = 10% off.');
}

module.exports = db;
