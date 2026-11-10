#!/usr/bin/env node
/*
  Numera — mail relay
  ----------------------------
  Browsers cannot open SMTP connections, so Numera posts each email to this small
  service, which delivers it with your SMTP settings (Settings → Email (SMTP) → "Send through my mail relay").

  Setup
    1. npm install nodemailer
    2. RELAY_TOKEN="<random string, 16+ chars>" node numera-mail-relay.js
    3. In Numera enter  Relay URL = http://localhost:8787/  and the same token.
       For anything beyond your own machine, put this behind HTTPS (e.g. a reverse proxy).

  Environment variables
    RELAY_TOKEN         (required) shared secret; requests without "Authorization: Bearer <token>" get 401
    PORT                default 8787
    HOST                default 127.0.0.1 (only this machine). Use 0.0.0.0 only behind HTTPS + a firewall.
    ALLOWED_ORIGIN      default *  (value of Access-Control-Allow-Origin)
    ALLOWED_SMTP_HOSTS  optional comma-separated allow-list, e.g. "smtp.office365.com,smtp.gmail.com".
                        STRONGLY recommended: without it a caller holding the token can make this
                        server connect to any host/port.

  Requests (POST, JSON)
    { action: "verify" | "send", smtp:{host,port,security:"starttls|ssl|none",user,pass},
      from:{name,address}, replyTo, bcc, to:[...], cc:[...], subject, html, text }
*/
'use strict';
const http = require('http');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.RELAY_TOKEN || '';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SMTP_ALLOW = (process.env.ALLOWED_SMTP_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_BODY = 2 * 1024 * 1024, RATE_PER_MIN = 30, MAX_RECIPIENTS = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (TOKEN.length < 16) {
  console.error('Set RELAY_TOKEN to a random string of at least 16 characters.');
  process.exit(1);
}

const hits = new Map();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length > RATE_PER_MIN;
}
function reply(res, code, obj) {
  const h = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600'
  };
  if (code === 204) { res.writeHead(204, h); return res.end(); }
  h['Content-Type'] = 'application/json';
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}
function authorised(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const list = v => (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map(x => String(x).trim()).filter(Boolean);

function validate(b) {
  if (!b || typeof b !== 'object') return 'Invalid request.';
  if (b.action !== 'send' && b.action !== 'verify') return 'Unknown action.';
  const s = b.smtp || {};
  if (typeof s.host !== 'string' || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s.host)) return 'Invalid SMTP host.';
  if (SMTP_ALLOW.length && !SMTP_ALLOW.includes(s.host.toLowerCase())) return 'This SMTP host is not allowed by the relay.';
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'Invalid SMTP port.';
  if (!['starttls', 'ssl', 'none'].includes(s.security)) return 'Invalid security option.';
  if (b.action === 'verify') return '';
  if (!b.from || !EMAIL.test(b.from.address || '')) return 'Invalid From address.';
  const to = list(b.to), cc = list(b.cc), bcc = list(b.bcc);
  if (!to.length) return 'No recipients.';
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) return 'Too many recipients (max ' + MAX_RECIPIENTS + ').';
  if (to.concat(cc, bcc).some(x => !EMAIL.test(x))) return 'One or more recipient addresses are invalid.';
  if (b.replyTo && !EMAIL.test(b.replyTo)) return 'Invalid Reply-To address.';
  if (typeof b.subject !== 'string' || !b.subject.trim() || b.subject.length > 300 || /[\r\n]/.test(b.subject)) return 'Invalid subject.';
  if (typeof b.text !== 'string' && typeof b.html !== 'string') return 'The message is empty.';
  return '';
}
function transport(s) {
  return nodemailer.createTransport({
    host: s.host, port: s.port,
    secure: s.security === 'ssl', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: s.pass || '' } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return reply(res, 204);
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'Use POST.' });
  if (!authorised(req)) return reply(res, 401, { ok: false, error: 'Unauthorised.' });
  if (limited(req.socket.remoteAddress || '')) return reply(res, 429, { ok: false, error: 'Too many requests. Try again in a minute.' });

  let size = 0; const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { reply(res, 413, { ok: false, error: 'Request too large.' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let b;
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reply(res, 400, { ok: false, error: 'Body must be JSON.' }); }
    const err = validate(b);
    if (err) return reply(res, 400, { ok: false, error: err });
    try {
      const t = transport(b.smtp);
      if (b.action === 'verify') { await t.verify(); return reply(res, 200, { ok: true }); }
      const info = await t.sendMail({
        from: { name: b.from.name || '', address: b.from.address },
        to: list(b.to), cc: list(b.cc), bcc: list(b.bcc), replyTo: b.replyTo || undefined,
        subject: b.subject, text: b.text, html: b.html
      });
      reply(res, 200, { ok: true, messageId: info.messageId });
    } catch (e) {
      // never echo credentials: scrub the SMTP password from the error text before replying
      let msg = String(e && e.message || e);
      if (b.smtp && b.smtp.pass) msg = msg.split(b.smtp.pass).join('***');
      reply(res, 502, { ok: false, error: 'SMTP error: ' + msg.slice(0, 200) });
    }
  });
});
server.listen(PORT, HOST, () => console.log('Numera mail relay listening on http://' + HOST + ':' + PORT));
