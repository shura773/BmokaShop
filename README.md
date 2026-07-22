# MyShop Backend

A real backend for the MyShop site: products + orders live in a database,
prices are calculated server-side (never trusted from the browser), and
checkout is wired to ABA PayWay's KHQR payment flow (ABA + ACLEDA both pay
through the same KHQR standard).

It runs in **two modes**:

- **DEMO_MODE** (default, no setup needed) — everything works end-to-end:
  cart → order → fake-but-realistic QR → simulate payment → confirmation.
  No real bank is contacted. This is what you get out of the box.
- **LIVE mode** — once you add real `PAYWAY_MERCHANT_ID` / `PAYWAY_API_KEY`
  in `.env`, it calls the real PayWay API instead.

---

## 1. Run it locally (demo mode)

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Open **http://localhost:3000** — that's the full site, now served by the
backend instead of being a standalone file.

Try it:
1. Add a couple of products to the cart, open the cart, click **Checkout**.
2. Fill in the shipping form, pick ABA or ACLEDA, click **Continue to Payment**.
3. You'll see a real order was created (check `backend/data/shop.db` — it's
   a real SQLite file) and a QR code appears.
4. Since there's no real bank connected yet, click **Simulate Payment
   Received (demo)** — this stands in for what PayWay's webhook would
   normally do. The order flips to "paid" and you'll see the confirmation
   screen (this happens automatically via polling, same as a real payment
   would).

Everything here is real except the actual bank connection: real database,
real server-side price validation (edit `price_usd` in the products table
and refresh the site — checkout totals will reflect the DB, not the
hardcoded HTML), real order records.

---

## 3. Admin dashboard

Go to **http://localhost:3000/admin**. Log in with whatever you set for
`ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` (defaults to
`admin` / `change-this-password` — change this before deploying anywhere
public!).

From there you can:
- See every order, its items, total, and status
- Change an order's status (pending → paid → shipped, or cancelled)
- Edit a product's price or stock directly
- **Export Orders (CSV)** / **Export Products (CSV)** — downloads a file
  that opens directly in Excel or Google Sheets. This is the "connect
  with Excel" feature — no database drivers or ODBC setup needed, just
  click the button whenever you want fresh data.

There's only ever one admin account, and it's not stored in the
database — it's just the username/password in your `.env` file. Nothing
public-facing can create an admin account.

## 4. Customer accounts

Customers can click **Login** in the header to sign up or log in. Once
logged in:
- Checkout auto-fills their name and email
- Orders are linked to their account
- They can see **My Account → Order History** for past orders

Guest checkout (no account) still works fine — accounts are optional,
not required to buy something.

## 5. Going live with ABA PayWay

1. **Get a sandbox account:** sign up at https://developer.payway.com.kh/
   (free, self-serve) to get sandbox API keys and access their full API
   reference.
2. **Get production credentials:** once you're ready to accept real money,
   email **paywaysales@ababank.com** — you'll need a registered business
   and an ABA business bank account.
3. Paste the Merchant ID + API Key into `.env`:
   ```
   PAYWAY_MERCHANT_ID=your_merchant_id
   PAYWAY_API_KEY=your_api_key
   PAYWAY_ENV=sandbox   # switch to "production" when you go live
   ```
4. Restart the server — you'll see `PayWay mode: LIVE` in the console
   instead of `DEMO`.

### ⚠️ Before real money touches this: verify the exact API shape

ABA's publicly documented examples aren't 100% consistent across their
different APIs (Create Transaction vs. Generate QR vs. webhook payloads),
and the fully detailed field-by-field spec is only visible once you're
signed into their developer portal. I built `src/payway.js` to follow their
publicly documented pattern (HMAC-SHA512, base64, specific field order),
and clearly marked the two spots that need a final check once you have
sandbox access:

- `buildCreateTransactionHash()` — confirm the exact field order matches
  the example request shown in your own dashboard.
- `verifyWebhookSignature()` — confirm the field name that carries *your*
  `tran_id` back to you (I used `merchant_ref`, but test a real sandbox
  payment and check the payload PayWay actually sends).

Make a single $0.10–$1 sandbox test payment and compare the request/response
your server produces against ABA's sample in their docs — if anything
doesn't match, it's a one-line fix in `payway.js`.

### Webhooks need a public URL

PayWay calls **your** server when a payment completes — it can't reach
`localhost`. For local testing, use the "Simulate Payment Received" button
in demo mode, or once deployed, point PayWay's webhook setting at:

```
https://your-deployed-domain.com/api/webhook/payway
```

## 6. Sending real emails (order confirmations + password resets)

Right now, order confirmations and password reset links are only ever
*logged to the console* — nothing is actually emailed, because no email
service is configured. This is real, working code (real tokens, real
templates) missing only the "actually send it" piece.

1. **Sign up free** at https://resend.com — no credit card needed, 3,000
   emails/month free (capped at 100/day on the free tier).
2. **Create an API key** in their dashboard.
3. Paste it into `.env`:
   ```
   RESEND_API_KEY=your_api_key
   EMAIL_FROM=MyShop <onboarding@resend.dev>
   PUBLIC_BASE_URL=http://localhost:3000
   ```
   `onboarding@resend.dev` is Resend's shared test address — it works
   immediately with no setup, good for testing. To send from your own
   address (e.g. `hello@myshop.com`), verify that domain in the Resend
   dashboard first, then update `EMAIL_FROM`.
4. Once deployed somewhere public, update `PUBLIC_BASE_URL` to your real
   domain — this is used to build the link inside password reset emails.
5. Restart the server. With no key set you'll see emails logged to the
   console (`📧 [DEMO EMAIL...]`); with a real key, they'll actually send.

**What triggers an email today:**
- Order confirmation — sent the moment an order's status becomes `paid`
  (via the real PayWay webhook, or the "Simulate Payment Received" button
  in demo mode)
- Password reset — sent when someone uses "Forgot password?"; the emailed
  link automatically opens the reset form when clicked

## 7. Deploying

This is a plain Node/Express app + a SQLite file — it'll run on almost
any Node host: Railway, Render, Fly.io, a small VPS, etc. Two things to
remember:

- The SQLite file (`data/shop.db`) needs to live on **persistent** storage
  — some platforms wipe the filesystem on redeploy. If your host doesn't
  offer a persistent disk, swap SQLite for a hosted Postgres (the query
  code in `src/db.js` would need adjusting, but the rest of the app
  doesn't change).
- Set your real `PAYWAY_MERCHANT_ID` / `PAYWAY_API_KEY` as environment
  variables on the host (don't commit `.env`).

---

## Project structure

```
backend/
  server.js              — entry point, wires routes + serves the frontend
  src/
    db.js                 — SQLite schema + product seed data
    payway.js              — PayWay integration (demo + live modes)
    routes/
      products.js          — GET /api/products
      orders.js             — POST/GET /api/orders  (server-side pricing!)
      webhook.js             — PayWay webhook + demo simulate-paid endpoint
  public/
    myshop.html             — the site (now calls the backend for checkout)
  data/
    shop.db                  — created automatically on first run
```

## API summary

| Method | Path | What it does |
|---|---|---|
| GET | `/api/products` | list products from the database |
| POST | `/api/orders` | create an order (re-prices from DB), returns a QR |
| GET | `/api/orders/:id` | order status — frontend polls this |
| POST | `/api/webhook/payway` | PayWay calls this when a payment succeeds |
| POST | `/api/webhook/simulate-paid/:orderId` | demo-mode only, fakes a payment |
