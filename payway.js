const crypto = require('node:crypto');

const MERCHANT_ID = process.env.PAYWAY_MERCHANT_ID || '';
const API_KEY = process.env.PAYWAY_API_KEY || '';
const ENV = (process.env.PAYWAY_ENV || 'sandbox').toLowerCase();

// PayWay is only "live" once both credentials are set. Otherwise we run
// in DEMO_MODE: fully functional checkout flow, fake QR, nothing touches
// a real bank. This lets you build and test the whole site before ABA
// approves your merchant account.
const DEMO_MODE = !MERCHANT_ID || !API_KEY;

const BASE_URL = ENV === 'production'
    ? 'https://checkout.payway.com.kh'
    : 'https://checkout-sandbox.payway.com.kh';

// ---------------------------------------------------------------------
// Hashing. PayWay signs requests with HMAC-SHA512(base64), but the exact
// field list/order differs slightly between their APIs (Create Transaction
// vs Generate QR vs webhook verification), and the fully detailed spec is
// only available inside PayWay's developer portal after you sign up.
//
// ⚠️  CONFIRM THIS against the example request/response in your own
//     PayWay dashboard (Developer Suite → API docs) before going live —
//     if the field order here doesn't exactly match what PayWay expects,
//     transactions will fail signature verification.
// ---------------------------------------------------------------------
function hmacSha512Base64(message, key) {
    return crypto.createHmac('sha512', key).update(message, 'utf8').digest('base64');
}

/**
 * Builds the signature PayWay expects for the "Generate QR" / "Create
 * Transaction" endpoint: concatenated values (no separators) in a fixed
 * field order, HMAC-SHA512, base64-encoded.
 */
function buildCreateTransactionHash({ req_time, merchant_id, tran_id, amount, items }) {
    const raw = `${req_time}${merchant_id}${tran_id}${amount}${items || ''}`;
    return hmacSha512Base64(raw, API_KEY);
}

/**
 * Verifies an inbound webhook from PayWay. Per PayWay's eCommerce Checkout
 * docs: sort all response fields by key ascending, concatenate the values,
 * HMAC-SHA512 + base64, compare to the X-PAYWAY-HMAC-SHA512 header.
 */
function verifyWebhookSignature(bodyObj, receivedSignature) {
    if (!receivedSignature) return false;
    const sortedKeys = Object.keys(bodyObj).sort();
    let concat = '';
    for (const k of sortedKeys) {
        const v = bodyObj[k];
        concat += typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    }
    const expected = hmacSha512Base64(concat, API_KEY);
    // timing-safe compare
    const a = Buffer.from(expected);
    const b = Buffer.from(receivedSignature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function nowReqTime() {
    // PayWay expects req_time as YYYYMMDDHHmmss
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear().toString() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds())
    );
}

/**
 * Creates a payment (QR) for an order.
 * In DEMO_MODE, returns a fake-but-visually-real QR (via a public QR
 * image generator) encoding a clearly-labeled demo string — nothing a
 * bank app would recognize as a real payment request.
 * In live mode, calls PayWay's real API.
 */
async function createPayment({ tranId, amountUsd, itemsDescription, paymentMethod }) {
    if (DEMO_MODE) {
        const bankLabel = 'ABA Bank';
        const demoPayload = `DEMO PAYMENT (NOT REAL) | ${bankLabel} | MyShop | Amount: $${amountUsd} | Ref: ${tranId}`;
        const qrImageUrl =
            'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=' +
            encodeURIComponent(demoPayload);
        return {
            demo: true,
            qrImageUrl,
            qrString: demoPayload,
            deeplink: null,
        };
    }

    // ---- Live PayWay call ----
    // ⚠️ Endpoint path + exact payload fields: confirm against your
    // PayWay Developer Suite docs (developer.payway.com.kh) — the shape
    // below follows their publicly documented "Create Transaction" /
    // "Generate QR" pattern but ABA may require small adjustments per
    // your account setup (e.g. KHQR template, currency handling).
    const req_time = nowReqTime();
    const amount = Number(amountUsd).toFixed(2);
    const items = Buffer.from(
        JSON.stringify([{ name: itemsDescription, quantity: '1', price: amount }])
    ).toString('base64');

    const hash = buildCreateTransactionHash({
        req_time,
        merchant_id: MERCHANT_ID,
        tran_id: tranId,
        amount,
        items,
    });

    const payload = {
        req_time,
        merchant_id: MERCHANT_ID,
        tran_id: tranId,
        amount,
        currency: 'USD',
        items,
        payment_option: 'abapay_khqr',
        type: 'purchase',
        hash,
    };

    const res = await fetch(`${BASE_URL}/api/payment-gateway/v1/payments/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`PayWay create-payment failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    return {
        demo: false,
        qrImageUrl: data.qrImage || null,
        qrString: data.qrString || null,
        deeplink: data.abapay_deeplink || null,
        raw: data,
    };
}

module.exports = {
    DEMO_MODE,
    createPayment,
    verifyWebhookSignature,
};
