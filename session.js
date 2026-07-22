const crypto = require('node:crypto');

const COOKIE_NAME = 'ms_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// In-memory session store. Simple and fine for a small shop, but it resets
// whenever the server restarts (everyone gets logged out). If that ever
// becomes annoying, swap this Map for a small table in the database.
const sessions = new Map(); // token -> { type: 'customer'|'admin', customerId?, createdAt, expiresAt }

function createSession(data) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

function destroySession(token) {
    sessions.delete(token);
}

function getSessionFromToken(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return session;
}

function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    cookieHeader.split(';').forEach((pair) => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        out[key] = decodeURIComponent(val);
    });
    return out;
}

/**
 * Express middleware: attaches req.session (or null) based on the
 * ms_sid cookie, and req.sessionToken so routes can log out / rotate it.
 */
function attachSession(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    req.sessionToken = token || null;
    req.session = getSessionFromToken(token);
    next();
}

function setSessionCookie(res, token) {
    const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`
    );
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function requireCustomer(req, res, next) {
    if (!req.session || req.session.type !== 'customer') {
        return res.status(401).json({ error: 'Please log in.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || req.session.type !== 'admin') {
        return res.status(401).json({ error: 'Admin login required.' });
    }
    next();
}

module.exports = {
    attachSession,
    createSession,
    destroySession,
    setSessionCookie,
    clearSessionCookie,
    requireCustomer,
    requireAdmin,
};
