const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'MyShop <onboarding@resend.dev>';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

// No real email service configured yet? Everything still "works" — the
// email content is logged to the console instead of sent, so you can
// develop and test the full flow before signing up for anything.
const DEMO_MODE = !RESEND_API_KEY;

/**
 * Sends an email via Resend's REST API. Using plain fetch here instead of
 * their SDK, so this doesn't need any new npm dependency.
 */
async function sendEmail({ to, subject, html }) {
    if (DEMO_MODE) {
        console.log('\n📧 [DEMO EMAIL — not actually sent, no RESEND_API_KEY configured]');
        console.log(`   To: ${to}`);
        console.log(`   Subject: ${subject}`);
        console.log('   (set RESEND_API_KEY in .env to send this for real)\n');
        return { demo: true };
    }

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: EMAIL_FROM,
            to: [to],
            subject,
            html,
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Resend API error (${res.status}): ${errText}`);
    }

    return { demo: false, result: await res.json() };
}

/**
 * A minimal, consistent email wrapper so all our emails look like they
 * come from the same store, without needing a templating library.
 */
function wrapEmailBody(innerHtml) {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #241F18;">
        <h2 style="color:#FF4FA0; margin-bottom: 20px;">MyShop</h2>
        ${innerHtml}
        <p style="margin-top: 32px; font-size: 12px; color: #999;">
            This email was sent by MyShop. If you weren't expecting it, you can safely ignore it.
        </p>
    </div>`;
}

async function sendOrderConfirmationEmail(order) {
    const itemsList = (order.items || [])
        .map((i) => `<li>${i.product_name} × ${i.qty} — $${i.unit_price_usd}</li>`)
        .join('');

    const html = wrapEmailBody(`
        <p>Hi ${order.customer_name},</p>
        <p>Thanks for your order — here's your confirmation.</p>
        <p><strong>Order ${order.tran_id}</strong></p>
        <ul>${itemsList}</ul>
        <p><strong>Total: $${order.total_usd}</strong></p>
        <p>Shipping to: ${order.shipping_address}</p>
        <p>Expect it to ship within 2–3 business days.</p>
    `);

    return sendEmail({
        to: order.customer_email,
        subject: `Order Confirmed — ${order.tran_id}`,
        html,
    });
}

async function sendPasswordResetEmail(email, name, rawToken) {
    const resetLink = `${PUBLIC_BASE_URL}/?reset_token=${rawToken}`;

    const html = wrapEmailBody(`
        <p>Hi ${name},</p>
        <p>We got a request to reset your password. Click below to set a new one (this link expires in 30 minutes):</p>
        <p><a href="${resetLink}" style="display:inline-block;background:#FF4FA0;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;">Reset Password</a></p>
        <p>Or copy this link: ${resetLink}</p>
        <p>If you didn't request this, you can ignore this email.</p>
    `);

    return sendEmail({
        to: email,
        subject: 'Reset your MyShop password',
        html,
    });
}

module.exports = {
    DEMO_MODE,
    sendEmail,
    sendOrderConfirmationEmail,
    sendPasswordResetEmail,
};
