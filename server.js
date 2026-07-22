require('dotenv').config();
const express = require('express');
const path = require('node:path');

const payway = require('./src/payway');
const session = require('./src/session');
const productsRouter = require('./src/routes/products');
const ordersRouter = require('./src/routes/orders');
const webhookRouter = require('./src/routes/webhook');
const authRouter = require('./src/routes/auth');
const adminRouter = require('./src/routes/admin');
const couponsRouter = require('./src/routes/coupons');
const promotionsRouter = require('./src/routes/promotions');

const app = express();
app.use(express.json());
app.use(session.attachSession);

app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/webhook', webhookRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/coupons', couponsRouter);
app.use('/api/promotions', promotionsRouter);

app.get('/api/health', (req, res) => {
    res.json({ ok: true, demo_mode: payway.DEMO_MODE });
});

// serve the frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'myshop.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MyShop backend running at http://localhost:${PORT}`);
    console.log(`Admin dashboard at http://localhost:${PORT}/admin`);
    console.log(`PayWay mode: ${payway.DEMO_MODE ? 'DEMO (no real payments)' : 'LIVE'}`);
});
