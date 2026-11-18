'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { db, bcrypt } = require('./db');
const { sendMail, notifyNewOrder, notifyNewRequest, mailReady } = require('./lib/mailer');
const { orderPdf } = require('./lib/pdf');
const { buildFatturaXML } = require('./lib/fatturapa');
const { parseInvoice, parseAny } = require('./lib/pdfimport');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-questo-segreto-in-produzione';
const DEFAULT_DB = path.join(__dirname, 'data', 'zetapack.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(process.env.DB_PATH || DEFAULT_DB), 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================ Auth ============================ */
function sign(user) { return jwt.sign(user, JWT_SECRET, { expiresIn: '12h' }); }

function auth(requiredRole) {
  const roles = requiredRole == null ? null : (Array.isArray(requiredRole) ? requiredRole : [requiredRole]);
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Non autenticato' });
    try {
      const u = jwt.verify(token, JWT_SECRET);
      if (roles && !roles.includes(u.role)) return res.status(403).json({ error: 'Accesso negato' });
      req.user = u; next();
    } catch (e) { return res.status(401).json({ error: 'Sessione scaduta' }); }
  };
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Credenziali mancanti' });

  const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(username);
  if (admin && bcrypt.compareSync(password, admin.passhash)) {
    const user = { role: 'admin', name: admin.name, username: admin.username };
    return res.json({ token: sign(user), user });
  }
  const cli = db.prepare('SELECT * FROM clients WHERE username=?').get(username);
  if (cli && bcrypt.compareSync(password, cli.passhash)) {
    const user = { role: 'client', id: cli.id, name: cli.name, city: cli.city, vat: cli.vat, email: cli.email };
    logAccess(req, 'client', cli.name, 'Login', '', cli.id);
    return res.json({ token: sign(user), user });
  }
  res.status(401).json({ error: 'Credenziali non valide' });
});

app.get('/api/me', auth(), (req, res) => res.json({ user: req.user, mail: mailReady() }));

/* Tracciamento accessi/attività: pubblico (visitatori anonimi) o attribuito al cliente/azienda se autenticato */
app.post('/api/track', (req, res) => {
  let kind = 'anon', who = 'Anonimo', clientId = null;
  const authz = req.headers.authorization;
  if (authz && authz.startsWith('Bearer ')) {
    try {
      const u = jwt.verify(authz.slice(7), JWT_SECRET);
      if (u.role === 'client') { kind = 'client'; who = u.name; clientId = u.id; }
      else if (u.role === 'admin') { kind = 'admin'; who = u.name || 'Azienda'; }
    } catch (e) {}
  }
  req._provenance = String((req.body && req.body.ref) || '');
  logAccess(req, kind, who, String((req.body && req.body.event) || ''), String((req.body && req.body.detail) || ''), clientId);
  res.json({ ok: true });
});

/* ============================ Helpers ============================ */
const toProduct = (r) => ({
  code: r.code, descr: r.descr, um: r.um, category: r.category,
  tags: JSON.parse(r.tags || '[]'), minq: r.minq, published: r.published,
  price: r.price, cost: r.cost, supplier: r.supplier, supcode: r.supcode, image: r.image || null,
  promo: r.promo ? 1 : 0, promo_price: r.promo_price != null ? r.promo_price : null
});
// Risolve la foto del prodotto lato server: foto caricata a mano, poi /assets/products/<codice>.png,
// poi /assets/products/<codice-fornitore>.png. Così la foto si vede anche nel catalogo pubblico
// (che non riceve il codice fornitore). Nome file cache-ato per 60s.
const PRODUCTS_IMG_DIR = path.join(__dirname, 'assets', 'products');
let _imgSet = null, _imgSetAt = 0;
function productImgSet() {
  const now = Date.now();
  if (!_imgSet || now - _imgSetAt > 60000) {
    try { _imgSet = new Set(fs.readdirSync(PRODUCTS_IMG_DIR)); } catch (e) { _imgSet = new Set(); }
    _imgSetAt = now;
  }
  return _imgSet;
}
// nome file sicuro: i codici con "/" (es. V00585/P, DON612B/FL) non possono stare nel filesystem
const safeImgName = s => String(s == null ? '' : s).trim().replace(/[\/\\\s]+/g, '_');
function resolvedImage(p) {
  if (p.image) return p.image;
  const set = productImgSet();
  for (const key of [p.code, p.supcode]) {
    const k = key == null ? '' : String(key).trim();
    if (!k) continue;
    // prima il nome esatto (codici numerici), poi il nome sicuro (codici con "/")
    if (set.has(k + '.png')) return '/assets/products/' + encodeURIComponent(k) + '.png';
    const safe = safeImgName(k);
    if (safe !== k && set.has(safe + '.png')) return '/assets/products/' + encodeURIComponent(safe) + '.png';
  }
  return null;
}
const publicView = (p) => {
  const o = { code: p.code, descr: p.descr, um: p.um, category: p.category, tags: p.tags, minq: p.minq, image: resolvedImage(p), promo: p.promo ? 1 : 0 };
  if (p.promo) { o.price = p.price; o.promo_price = p.promo_price != null ? p.promo_price : null; }  // prezzo visibile al pubblico solo per i promo
  return o;
};
const clientView = (p) => ({ ...publicView(p), price: p.price, promo: p.promo ? 1 : 0, promo_price: p.promo_price != null ? p.promo_price : null });

const ORDER_ALL = ['Nuovo', 'In lavorazione', 'Spedito', 'Fatturato', 'Evaso', 'Annullato'];
function logComm(clientId, type, subject, toEmail) {
  try { db.prepare('INSERT INTO communications (client_id,type,subject,to_email,created_at) VALUES (?,?,?,?,?)').run(clientId || null, type, subject || '', toEmail || '', Date.now()); } catch (e) {}
}
function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || '';
}
function logAccess(req, kind, who, action, detail, clientId) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const ref = String(req._provenance != null ? req._provenance : (req.headers['referer'] || req.headers['referrer'] || '')).slice(0, 200);
  try { db.prepare('INSERT INTO access_logs (ts,kind,client_id,who,action,detail,ip,ua,ref) VALUES (?,?,?,?,?,?,?,?,?)').run(Date.now(), kind, clientId || null, who || '', (action || '').slice(0, 40), (detail || '').slice(0, 140), clientIp(req), ua, ref); } catch (e) {}
}

/* ============================ Catalogo ============================ */
app.get('/api/meta', (req, res) => {
  const rows = db.prepare('SELECT category, tags FROM products').all();
  const cats = [...new Set(rows.map(r => r.category).filter(Boolean))].sort();
  const secs = [...new Set(rows.flatMap(r => JSON.parse(r.tags || '[]')).filter(Boolean))].sort();
  res.json({ categories: cats, sectors: secs });
});

app.get('/api/catalog', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE published=1 ORDER BY descr').all();
  res.json(rows.map(r => publicView(toProduct(r))));
});

app.get('/api/catalog/prices', auth(['client', 'admin']), (req, res) => {  // admin: anteprima "come cliente"
  const rows = db.prepare('SELECT * FROM products WHERE published=1 ORDER BY descr').all();
  res.json(rows.map(r => clientView(toProduct(r))));
});

/* Prodotti in promozione: pubblici, con prezzo sempre visibile */
app.get('/api/promo', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE published=1 AND promo=1 ORDER BY descr').all();
  res.json(rows.map(r => {
    const p = toProduct(r);
    return { code: p.code, descr: p.descr, category: p.category, image: resolvedImage(p), um: p.um, minq: p.minq, price: p.price, promo_price: p.promo_price };
  }));
});

/* ============================ Richieste (pubblico) ============================ */
app.post('/api/requests', async (req, res) => {
  const b = req.body || {};
  if (!b.company || !b.name || !b.email) return res.status(400).json({ error: 'Compila attività, referente ed email' });
  const n = db.prepare('SELECT COUNT(*) n FROM requests').get().n;
  const r = {
    id: 'REQ-' + (501 + n), type: b.type || 'Accesso', company: b.company, name: b.name,
    vat: b.vat || '', email: b.email, phone: b.phone || '', msg: b.msg || '',
    status: 'Aperta', created_at: Date.now()
  };
  db.prepare(`INSERT INTO requests (id,type,company,name,vat,email,phone,msg,status,created_at)
    VALUES (@id,@type,@company,@name,@vat,@email,@phone,@msg,@status,@created_at)`).run(r);
  try { await notifyNewRequest(r); } catch (e) { console.error('[mail]', e.message); }
  logAccess(req, 'anon', b.company || b.name, 'Richiesta accesso', r.id, null);
  res.json({ ok: true, id: r.id });
});

/* ============================ Ordini (cliente) ============================ */
function loadOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT code,descr,price,qty,disc,list FROM order_items WHERE order_id=?').all(id);
  return o;
}

app.post('/api/orders', auth('client'), async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Nessun articolo nella richiesta' });
  // Prezzi ricalcolati dal database (non ci si fida del client)
  const getP = db.prepare('SELECT descr,price FROM products WHERE code=?');
  const rows = [];
  for (const it of items) {
    const p = getP.get(it.code);
    if (!p || p.price == null) continue;
    const qty = Math.max(1, Math.round(Number(it.qty) || 0));
    rows.push({ code: it.code, descr: p.descr, price: p.price, qty });
  }
  if (!rows.length) return res.status(400).json({ error: 'Articoli non validi' });

  const n = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  const order = {
    id: 'ORD-' + (1001 + n), client_id: req.user.id, client_name: req.user.name,
    status: 'Nuovo', note: (req.body.note || '').slice(0, 1000),
    total: rows.reduce((s, r) => s + r.price * r.qty, 0), created_at: Date.now()
  };
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO orders (id,client_id,client_name,status,note,total,created_at)
      VALUES (@id,@client_id,@client_name,@status,@note,@total,@created_at)`).run(order);
    const ins = db.prepare('INSERT INTO order_items (order_id,code,descr,price,qty) VALUES (?,?,?,?,?)');
    for (const r of rows) ins.run(order.id, r.code, r.descr, r.price, r.qty);
  });
  tx();
  order.items = rows;
  try { await notifyNewOrder(order, req.user.email); } catch (e) { console.error('[mail]', e.message); }
  logComm(order.client_id, 'Conferma ordine', 'Ricevuta richiesta ' + order.id, req.user.email);
  logAccess(req, 'client', req.user.name, 'Ordine inviato', order.id, req.user.id);
  res.json(order);
});

app.get('/api/orders/mine', auth('client'), (req, res) => {
  const list = db.prepare('SELECT * FROM orders WHERE client_id=? ORDER BY created_at DESC').all(req.user.id);
  for (const o of list) o.items = db.prepare('SELECT code,descr,price,qty,disc,list FROM order_items WHERE order_id=?').all(o.id);
  res.json(list);
});

/* PDF ordine (cliente proprietario oppure admin) */
app.get('/api/orders/:id/pdf', auth(), async (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).send('Ordine non trovato');
  if (req.user.role === 'client' && o.client_id !== req.user.id) return res.status(403).send('Accesso negato');
  const client = db.prepare('SELECT name,vat,city,email FROM clients WHERE id=?').get(o.client_id) || {};
  const buf = await orderPdf(o, { title: 'Richiesta d\'ordine', client });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${o.id}.pdf"`);
  res.send(buf);
});

/* PDF preventivo (solo azienda) */
app.get('/api/admin/orders/:id/quote.pdf', auth('admin'), async (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).send('Ordine non trovato');
  const client = db.prepare('SELECT name,vat,city,email,phone,address FROM clients WHERE id=?').get(o.client_id) || {};
  const buf = await orderPdf(o, { title: 'Preventivo', client, validity: 30 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Preventivo-${o.id}.pdf"`);
  res.send(buf);
});

/* Invio preventivo via email al cliente, con PDF allegato (solo azienda) */
app.post('/api/admin/orders/:id/send-quote', auth('admin'), async (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Ordine non trovato' });
  const to = (req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: "Manca il recapito del destinatario" });
  const subject = req.body.subject || ('Preventivo ' + o.id + ' — ZETAPACK Srl');
  if (req.body.channel === 'whatsapp') {
    logComm(o.client_id, 'Preventivo (WhatsApp)', subject, to);
    return res.json({ ok: true });
  }
  const text = req.body.body || '';
  const client = db.prepare('SELECT name,vat,city,email,phone,address FROM clients WHERE id=?').get(o.client_id) || {};
  try {
    const buf = await orderPdf(o, { title: 'Preventivo', client, validity: 30 });
    await sendMail({
      to,
      bcc: process.env.MAIL_ADMIN || undefined,   // copia per l'azienda
      replyTo: process.env.MAIL_ADMIN || undefined,
      subject, text,
      attachments: [{ filename: 'Preventivo-' + o.id + '.pdf', content: buf }]
    });
    logComm(o.client_id, 'Preventivo', subject, to);
    res.json({ ok: true, dev: !mailReady() });
  } catch (e) {
    console.error('[mail]', e.message);
    res.status(502).json({ error: 'Invio non riuscito: ' + e.message });
  }
});

/* ============================ PREVENTIVI (azienda) ============================ */
function loadQuote(id) {
  const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(id);
  if (!q) return null;
  q.items = db.prepare('SELECT code,descr,price,qty,disc,list FROM quote_items WHERE quote_id=?').all(id);
  return q;
}
function buildQuoteItems(list) {
  const getP = db.prepare('SELECT descr,price FROM products WHERE code=?');
  const rows = [];
  for (const it of (list || [])) {
    if (!it.code) continue;
    const p = getP.get(it.code);
    const descr = it.descr || (p ? p.descr : it.code);
    let listPrice = (it.list !== undefined && it.list !== null && it.list !== '') ? Number(it.list) : (p ? p.price : null);
    let disc = Number(it.disc) || 0; if (disc < 0) disc = 0; if (disc > 100) disc = 100;
    let net;
    if (it.price !== undefined && it.price !== null && it.price !== '') net = Number(it.price);
    else if (listPrice != null) net = listPrice * (1 - disc / 100);
    else net = 0;
    if (net == null || isNaN(net)) net = 0;
    if (listPrice == null || isNaN(listPrice)) listPrice = net;
    const qty = Math.max(1, Math.round(Number(it.qty) || 0));
    rows.push({ code: it.code, descr, price: Math.round(net * 10000) / 10000, disc, list: listPrice, qty });
  }
  return rows;
}

app.get('/api/admin/quotes', auth('admin'), (req, res) => {
  const list = db.prepare('SELECT * FROM quotes ORDER BY created_at DESC').all();
  for (const q of list) q.items = db.prepare('SELECT code,descr,price,qty,disc,list FROM quote_items WHERE quote_id=?').all(q.id);
  res.json(list);
});

app.post('/api/admin/quotes', auth('admin'), (req, res) => {
  const b = req.body || {};
  const items = buildQuoteItems(b.items);
  if (!items.length) return res.status(400).json({ error: 'Aggiungi almeno un articolo' });
  let clientName = b.client_name || '', toEmail = b.to_email || '';
  if (b.client_id) { const c = db.prepare('SELECT name,email FROM clients WHERE id=?').get(b.client_id); if (c) { clientName = clientName || c.name; toEmail = toEmail || c.email || ''; } }
  if (!clientName) return res.status(400).json({ error: 'Indica il cliente o il destinatario' });
  const n = db.prepare('SELECT COUNT(*) n FROM quotes').get().n;
  const q = {
    id: 'PRV-' + (2001 + n), client_id: b.client_id || null, client_name: clientName, to_email: toEmail,
    status: 'Bozza', note: (b.note || '').slice(0, 1000), validity: Number(b.validity) || 30,
    total: items.reduce((s, r) => s + r.price * r.qty, 0), created_at: Date.now(), sent_at: null
  };
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO quotes (id,client_id,client_name,to_email,status,note,validity,total,created_at,sent_at)
      VALUES (@id,@client_id,@client_name,@to_email,@status,@note,@validity,@total,@created_at,@sent_at)`).run(q);
    const ins = db.prepare('INSERT INTO quote_items (quote_id,code,descr,price,qty,disc,list) VALUES (?,?,?,?,?,?,?)');
    for (const r of items) ins.run(q.id, r.code, r.descr, r.price, r.qty, r.disc, r.list);
  });
  tx();
  q.items = items; res.json(q);
});

app.put('/api/admin/quotes/:id', auth('admin'), (req, res) => {
  const cur = db.prepare('SELECT * FROM quotes WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Preventivo non trovato' });
  const b = req.body || {};
  const items = buildQuoteItems(b.items);
  if (!items.length) return res.status(400).json({ error: 'Aggiungi almeno un articolo' });
  const clientId = b.client_id !== undefined ? b.client_id : cur.client_id;
  const upd = {
    id: req.params.id, client_id: clientId || null, client_name: b.client_name ?? cur.client_name,
    to_email: (b.to_email ?? cur.to_email) || '', status: b.status || cur.status,
    note: b.note ?? cur.note, validity: Number(b.validity) || cur.validity,
    total: items.reduce((s, r) => s + r.price * r.qty, 0)
  };
  const tx = db.transaction(() => {
    db.prepare(`UPDATE quotes SET client_id=@client_id,client_name=@client_name,to_email=@to_email,status=@status,note=@note,validity=@validity,total=@total WHERE id=@id`).run(upd);
    db.prepare('DELETE FROM quote_items WHERE quote_id=?').run(req.params.id);
    const ins = db.prepare('INSERT INTO quote_items (quote_id,code,descr,price,qty,disc,list) VALUES (?,?,?,?,?,?,?)');
    for (const r of items) ins.run(req.params.id, r.code, r.descr, r.price, r.qty, r.disc, r.list);
  });
  tx();
  res.json({ ok: true });
});

app.patch('/api/admin/quotes/:id', auth('admin'), (req, res) => {
  if (!['Bozza', 'Inviato', 'Accettato', 'Rifiutato', 'Scaduto'].includes(req.body.status)) return res.status(400).json({ error: 'Stato non valido' });
  db.prepare('UPDATE quotes SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/quotes/:id', auth('admin'), (req, res) => {
  db.prepare('DELETE FROM quotes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/quotes/:id/pdf', auth('admin'), async (req, res) => {
  const q = loadQuote(req.params.id); if (!q) return res.status(404).send('Preventivo non trovato');
  let client = { name: q.client_name, email: q.to_email };
  if (q.client_id) { const c = db.prepare('SELECT name,vat,city,email,phone,address FROM clients WHERE id=?').get(q.client_id); if (c) client = c; }
  const buf = await orderPdf(q, { title: 'Preventivo', client, validity: q.validity });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${q.id}.pdf"`);
  res.send(buf);
});

app.post('/api/admin/quotes/:id/send', auth('admin'), async (req, res) => {
  const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'Preventivo non trovato' });
  const to = (req.body.to || q.to_email || '').trim();
  if (!to) return res.status(400).json({ error: "Manca il recapito del destinatario" });
  const subject = req.body.subject || ('Preventivo ' + q.id + ' — ZETAPACK Srl');
  if (req.body.channel === 'whatsapp') {
    db.prepare('UPDATE quotes SET status=?, sent_at=? WHERE id=?').run('Inviato', Date.now(), q.id);
    logComm(q.client_id, 'Preventivo (WhatsApp)', subject, to);
    return res.json({ ok: true });
  }
  let client = { name: q.client_name, email: to };
  if (q.client_id) { const c = db.prepare('SELECT name,vat,city,email,phone,address FROM clients WHERE id=?').get(q.client_id); if (c) client = c; }
  const text = req.body.body || '';
  try {
    const buf = await orderPdf(q, { title: 'Preventivo', client, validity: q.validity });
    await sendMail({ to, bcc: process.env.MAIL_ADMIN || undefined, replyTo: process.env.MAIL_ADMIN || undefined, subject, text, attachments: [{ filename: q.id + '.pdf', content: buf }] });
    db.prepare('UPDATE quotes SET status=?, sent_at=?, to_email=? WHERE id=?').run('Inviato', Date.now(), to, q.id);
    logComm(q.client_id, 'Preventivo', subject, to);
    res.json({ ok: true, dev: !mailReady() });
  } catch (e) { console.error('[mail]', e.message); res.status(502).json({ error: 'Invio non riuscito: ' + e.message }); }
});

app.post('/api/admin/quotes/:id/to-order', auth('admin'), (req, res) => {
  const q = loadQuote(req.params.id); if (!q) return res.status(404).json({ error: 'Preventivo non trovato' });
  if (!q.client_id) return res.status(400).json({ error: 'Il preventivo non è collegato a un cliente registrato' });
  const n = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  const order = { id: 'ORD-' + (1001 + n), client_id: q.client_id, client_name: q.client_name, status: 'Nuovo', note: 'Da preventivo ' + q.id, total: q.total, created_at: Date.now() };
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO orders (id,client_id,client_name,status,note,total,created_at) VALUES (@id,@client_id,@client_name,@status,@note,@total,@created_at)`).run(order);
    const ins = db.prepare('INSERT INTO order_items (order_id,code,descr,price,qty,disc,list) VALUES (?,?,?,?,?,?,?)');
    for (const it of q.items) ins.run(order.id, it.code, it.descr, it.price, it.qty, it.disc || 0, it.list != null ? it.list : it.price);
    db.prepare('UPDATE quotes SET status=? WHERE id=?').run('Accettato', q.id);
  });
  tx();
  res.json({ ok: true, orderId: order.id });
});

/* ============================ ADMIN ============================ */
app.get('/api/admin/products', auth('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY descr').all();
  res.json(rows.map(toProduct));
});

app.post('/api/admin/products', auth('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.descr || b.price == null) return res.status(400).json({ error: 'Codice, descrizione e prezzo obbligatori' });
  const exists = db.prepare('SELECT 1 FROM products WHERE code=? COLLATE NOCASE').get(b.code);
  if (exists) return res.status(409).json({ error: 'Codice già esistente' });
  db.prepare(`INSERT INTO products (code,descr,um,cost,price,supplier,supcode,category,tags,minq,published,image,promo,promo_price)
    VALUES (@code,@descr,@um,@cost,@price,@supplier,@supcode,@category,@tags,@minq,@published,@image,@promo,@promo_price)`).run({
    code: b.code, descr: b.descr, um: b.um || 'pz', cost: b.cost ?? null, price: b.price,
    supplier: b.supplier || '', supcode: b.supcode || '', category: b.category || 'Altro',
    tags: JSON.stringify(b.tags || []), minq: b.minq || 1, published: b.published ? 1 : 0, image: b.image || null,
    promo: b.promo ? 1 : 0, promo_price: (b.promo_price !== undefined && b.promo_price !== null && b.promo_price !== '') ? Number(b.promo_price) : null
  });
  res.json({ ok: true });
});

app.patch('/api/admin/products/:code', auth('admin'), (req, res) => {
  const cur = db.prepare('SELECT * FROM products WHERE code=?').get(req.params.code);
  if (!cur) return res.status(404).json({ error: 'Prodotto non trovato' });
  const b = req.body || {};
  const upd = {
    descr: b.descr ?? cur.descr, um: b.um ?? cur.um, cost: b.cost !== undefined ? b.cost : cur.cost,
    price: b.price !== undefined ? b.price : cur.price, supplier: b.supplier ?? cur.supplier,
    supcode: b.supcode ?? cur.supcode,
    category: b.category ?? cur.category, tags: b.tags ? JSON.stringify(b.tags) : cur.tags,
    minq: b.minq ?? cur.minq, published: b.published !== undefined ? (b.published ? 1 : 0) : cur.published,
    image: b.image !== undefined ? b.image : cur.image,
    promo: b.promo !== undefined ? (b.promo ? 1 : 0) : cur.promo,
    promo_price: b.promo_price !== undefined ? ((b.promo_price === null || b.promo_price === '') ? null : Number(b.promo_price)) : cur.promo_price,
    code: req.params.code
  };
  db.prepare(`UPDATE products SET descr=@descr,um=@um,cost=@cost,price=@price,supplier=@supplier,supcode=@supcode,
    category=@category,tags=@tags,minq=@minq,published=@published,image=@image,promo=@promo,promo_price=@promo_price WHERE code=@code`).run(upd);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:code', auth('admin'), (req, res) => {
  db.prepare('DELETE FROM products WHERE code=?').run(req.params.code);
  res.json({ ok: true });
});

/* ---- Immagini prodotto su Cloudflare R2 (storage esterno, non su Render) ---- */
function r2Config() {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL, R2_ACCOUNT_ID, R2_ENDPOINT } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL || !(R2_ACCOUNT_ID || R2_ENDPOINT)) return null;
  return {
    accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET,
    publicUrl: R2_PUBLIC_URL.replace(/\/+$/, ''),
    endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  };
}
let _s3 = null;
function getS3(cfg) {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3 = new S3Client({ region: 'auto', endpoint: cfg.endpoint, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  return _s3;
}

app.post('/api/admin/upload-image', auth('admin'), async (req, res) => {
  const cfg = r2Config();
  if (!cfg) return res.status(503).json({ error: 'Storage immagini non configurato: imposta le variabili R2_* sul server (vedi GUIDA-IMMAGINI.md).' });
  const { filename, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Immagine mancante' });
  let buf; try { buf = Buffer.from(String(data), 'base64'); } catch (e) { return res.status(400).json({ error: 'Immagine non valida' }); }
  if (!buf.length) return res.status(400).json({ error: 'Immagine vuota' });
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Immagine troppo grande (max 8 MB)' });
  const m = (filename || '').toLowerCase().match(/\.(png|jpe?g|webp|gif|avif)$/);
  const ext = m ? m[1] : 'webp';
  const ctype = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }[ext] || 'image/webp';
  const key = 'products/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3(cfg).send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: buf, ContentType: ctype, CacheControl: 'public, max-age=31536000, immutable' }));
    res.json({ url: cfg.publicUrl + '/' + key });
  } catch (e) {
    console.error('[r2]', e.message);
    const hint = /Cannot find module/.test(e.message) ? " (esegui 'npm install' sul server)" : '';
    res.status(502).json({ error: 'Caricamento immagine non riuscito: ' + e.message + hint });
  }
});

app.delete('/api/admin/delete-image', auth('admin'), async (req, res) => {
  const cfg = r2Config();
  const url = req.body && req.body.url;
  if (cfg && url && url.indexOf(cfg.publicUrl + '/') === 0) {
    const key = url.slice(cfg.publicUrl.length + 1);
    try { const { DeleteObjectCommand } = require('@aws-sdk/client-s3'); await getS3(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })); } catch (e) {}
  }
  res.json({ ok: true });
});

/* Import massivo: body { rows:[{code,descr,...}], mode:'upsert'|'add' } */
app.post('/api/admin/products/import', auth('admin'), (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const mode = req.body.mode === 'add' ? 'add' : 'upsert';
  let added = 0, updated = 0, skipped = 0;
  const exists = db.prepare('SELECT 1 FROM products WHERE code=?');
  const insert = db.prepare(`INSERT INTO products (code,descr,um,cost,price,supplier,supcode,category,tags,minq,published)
    VALUES (@code,@descr,@um,@cost,@price,@supplier,@supcode,@category,@tags,@minq,@published)`);
  const update = db.prepare(`UPDATE products SET descr=@descr,um=@um,cost=@cost,price=@price,supplier=@supplier,
    category=@category,tags=@tags,minq=@minq,published=@published WHERE code=@code`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.code) { skipped++; continue; }
      const rec = {
        code: r.code, descr: r.descr || r.code, um: r.um || 'pz', cost: r.cost ?? null, price: r.price ?? null,
        supplier: r.supplier || '', supcode: r.supcode || '', category: r.category || 'Altro',
        tags: JSON.stringify(r.tags || []), minq: r.minq || 1, published: r.published ? 1 : 0
      };
      if (exists.get(r.code)) {
        if (mode === 'add') { skipped++; continue; }
        update.run(rec); updated++;
      } else { insert.run(rec); added++; }
    }
  });
  tx();
  res.json({ added, updated, skipped });
});

/* Ordini admin */
app.get('/api/admin/orders', auth('admin'), (req, res) => {
  const list = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  for (const o of list) o.items = db.prepare('SELECT code,descr,price,qty,disc,list FROM order_items WHERE order_id=?').all(o.id);
  res.json(list);
});

app.patch('/api/admin/orders/:id', auth('admin'), async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Ordine non trovato' });
  const b = req.body || {};
  if (b.status !== undefined && !ORDER_ALL.includes(b.status)) return res.status(400).json({ error: 'Stato non valido' });
  const upd = {
    status: b.status !== undefined ? b.status : o.status,
    ddt_num: b.ddt_num !== undefined ? b.ddt_num : o.ddt_num,
    ddt_date: b.ddt_date !== undefined ? b.ddt_date : o.ddt_date,
    invoice_num: b.invoice_num !== undefined ? b.invoice_num : o.invoice_num,
    invoice_date: b.invoice_date !== undefined ? b.invoice_date : o.invoice_date,
    id: req.params.id
  };
  db.prepare('UPDATE orders SET status=@status,ddt_num=@ddt_num,ddt_date=@ddt_date,invoice_num=@invoice_num,invoice_date=@invoice_date WHERE id=@id').run(upd);
  // Scarico automatico giacenze quando l'ordine "parte" (Spedito/Fatturato/Evaso); ripristino se torna indietro o annullato
  try {
    const OUT = ['Spedito', 'Fatturato', 'Evaso'];
    const nowOut = OUT.includes(upd.status);
    if (nowOut && !o.stock_done) { applyOrderStock(req.params.id, -1); db.prepare('UPDATE orders SET stock_done=1 WHERE id=?').run(req.params.id); }
    else if (!nowOut && o.stock_done) { applyOrderStock(req.params.id, 1); db.prepare('UPDATE orders SET stock_done=0 WHERE id=?').run(req.params.id); }
  } catch (e) { console.error('[stock]', e.message); }
  let notified = false;
  if (upd.status !== o.status && (upd.status === 'Spedito' || upd.status === 'Fatturato')) {
    try { notified = await notifyOrderStatus(o, upd, upd.status); } catch (e) { console.error('[mail]', e.message); }
  }
  res.json({ ok: true, notified });
});

async function notifyOrderStatus(order, upd, status) {
  const c = order.client_id ? db.prepare('SELECT name,email FROM clients WHERE id=?').get(order.client_id) : null;
  const to = c && c.email;
  if (!to) return false;
  const isShip = status === 'Spedito';
  const subject = (isShip ? 'Ordine spedito' : 'Ordine fatturato') + ' ' + order.id + ' — ZETAPACK Srl';
  let body = 'Spett.le ' + (order.client_name || c.name) + ',\n\n';
  const attachments = [];
  if (isShip) {
    body += 'il vostro ordine ' + order.id + ' è stato spedito';
    if (upd.ddt_num) body += ' con DDT n. ' + upd.ddt_num + (upd.ddt_date ? ' del ' + upd.ddt_date : '');
    body += '.';
    if (order.ddt_file) { const fp = path.join(UPLOAD_DIR, order.ddt_file); if (fs.existsSync(fp)) attachments.push({ filename: order.ddt_fname || 'DDT.pdf', content: fs.readFileSync(fp) }); }
  } else {
    body += 'il vostro ordine ' + order.id + ' è stato fatturato';
    if (upd.invoice_num) body += ' — fattura n. ' + upd.invoice_num + (upd.invoice_date ? ' del ' + upd.invoice_date : '');
    body += '.';
    if (order.invoice_file) { const fp = path.join(UPLOAD_DIR, order.invoice_file); if (fs.existsSync(fp)) attachments.push({ filename: order.invoice_fname || 'Fattura.pdf', content: fs.readFileSync(fp) }); }
  }
  body += "\n\nPotete seguire lo stato dell'ordine nella vostra area riservata sul nostro portale.\n\nCordiali saluti,\nZETAPACK Srl";
  await sendMail({ to, bcc: process.env.MAIL_ADMIN || undefined, subject, text: body, attachments });
  logComm(order.client_id, isShip ? 'Notifica spedizione' : 'Notifica fattura', subject, to);
  return true;
}

/* ---- Allegati reali DDT / Fattura ---- */
function ctypeFor(fname) {
  const e = (fname || '').toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[e] || 'application/octet-stream';
}
function sendOrderFile(id, kind, clientId, res) {
  if (!['ddt', 'invoice'].includes(kind)) return res.status(400).send('Tipo non valido');
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).send('Ordine non trovato');
  if (clientId && o.client_id !== clientId) return res.status(403).send('Non autorizzato');
  const file = o[kind === 'ddt' ? 'ddt_file' : 'invoice_file'];
  const fname = o[kind === 'ddt' ? 'ddt_fname' : 'invoice_fname'] || (kind + '.pdf');
  if (!file) return res.status(404).send('Allegato non presente');
  const fp = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(fp)) return res.status(404).send('File non trovato');
  res.setHeader('Content-Type', ctypeFor(fname));
  res.setHeader('Content-Disposition', `inline; filename="${fname.replace(/"/g, '')}"`);
  fs.createReadStream(fp).pipe(res);
}

app.post('/api/admin/orders/:id/upload', auth('admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Ordine non trovato' });
  const { kind, filename, data } = req.body || {};
  if (!['ddt', 'invoice'].includes(kind)) return res.status(400).json({ error: 'Tipo allegato non valido' });
  if (!data) return res.status(400).json({ error: 'File mancante' });
  let buf;
  try { buf = Buffer.from(String(data), 'base64'); } catch (e) { return res.status(400).json({ error: 'File non valido' }); }
  if (!buf.length) return res.status(400).json({ error: 'File vuoto' });
  if (buf.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'File troppo grande (max 12 MB)' });
  const m = (filename || '').toLowerCase().match(/\.(pdf|png|jpe?g|gif|webp)$/);
  const ext = m ? m[1] : 'pdf';
  const stored = `${req.params.id}-${kind}-${Date.now()}.${ext}`;
  const prev = o[kind === 'ddt' ? 'ddt_file' : 'invoice_file'];
  if (prev) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prev)); } catch (e) {} }
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  if (kind === 'ddt') db.prepare('UPDATE orders SET ddt_file=?, ddt_fname=? WHERE id=?').run(stored, filename || stored, req.params.id);
  else db.prepare('UPDATE orders SET invoice_file=?, invoice_fname=? WHERE id=?').run(stored, filename || stored, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/orders/:id/file/:kind', auth('admin'), (req, res) => sendOrderFile(req.params.id, req.params.kind, null, res));
app.get('/api/orders/:id/file/:kind', auth('client'), (req, res) => sendOrderFile(req.params.id, req.params.kind, req.user.id, res));

app.delete('/api/admin/orders/:id/file/:kind', auth('admin'), (req, res) => {
  const kind = req.params.kind;
  if (!['ddt', 'invoice'].includes(kind)) return res.status(400).json({ error: 'Tipo non valido' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Ordine non trovato' });
  const file = o[kind === 'ddt' ? 'ddt_file' : 'invoice_file'];
  if (file) { try { fs.unlinkSync(path.join(UPLOAD_DIR, file)); } catch (e) {} }
  if (kind === 'ddt') db.prepare('UPDATE orders SET ddt_file=NULL, ddt_fname=NULL WHERE id=?').run(req.params.id);
  else db.prepare('UPDATE orders SET invoice_file=NULL, invoice_fname=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/orders/:id/send-docs', auth('admin'), async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Ordine non trovato' });
  const to = (req.body.to || '').trim();
  if (!to) return res.status(400).json({ error: "Manca il recapito del destinatario" });
  const subject = req.body.subject || ('Documenti ordine ' + o.id + ' — ZETAPACK Srl');
  if (req.body.channel === 'whatsapp') {
    logComm(o.client_id, 'Documenti (WhatsApp)', subject, to);
    return res.json({ ok: true });
  }
  const attachments = [];
  if (o.ddt_file) { const fp = path.join(UPLOAD_DIR, o.ddt_file); if (fs.existsSync(fp)) attachments.push({ filename: o.ddt_fname || 'DDT.pdf', content: fs.readFileSync(fp) }); }
  if (o.invoice_file) { const fp = path.join(UPLOAD_DIR, o.invoice_file); if (fs.existsSync(fp)) attachments.push({ filename: o.invoice_fname || 'Fattura.pdf', content: fs.readFileSync(fp) }); }
  if (!attachments.length) return res.status(400).json({ error: 'Nessun file allegato da inviare: carica prima il DDT o la fattura' });
  const text = req.body.body || '';
  try {
    await sendMail({ to, bcc: process.env.MAIL_ADMIN || undefined, replyTo: process.env.MAIL_ADMIN || undefined, subject, text, attachments });
    logComm(o.client_id, 'Documenti (DDT/Fattura)', subject, to);
    res.json({ ok: true, dev: !mailReady(), attached: attachments.length });
  } catch (e) { console.error('[mail]', e.message); res.status(502).json({ error: 'Invio non riuscito: ' + e.message }); }
});

/* Costruisce le righe di un ordine con sconto per riga (price = prezzo netto) */
function buildOrderItems(list) {
  const getP = db.prepare('SELECT descr,price FROM products WHERE code=?');
  const rows = [];
  for (const it of (list || [])) {
    if (!it.code) continue;
    const p = getP.get(it.code);
    const descr = it.descr || (p ? p.descr : it.code);
    let listPrice = (it.list !== undefined && it.list !== null && it.list !== '') ? Number(it.list) : (p ? p.price : null);
    let disc = Number(it.disc) || 0; if (disc < 0) disc = 0; if (disc > 100) disc = 100;
    let net;
    if (it.price !== undefined && it.price !== null && it.price !== '') net = Number(it.price);
    else if (listPrice != null) net = listPrice * (1 - disc / 100);
    else net = 0;
    if (net == null || isNaN(net)) net = 0;
    if (listPrice == null || isNaN(listPrice)) listPrice = net;
    const qty = Math.max(1, Math.round(Number(it.qty) || 0));
    rows.push({ code: it.code, descr, price: Math.round(net * 10000) / 10000, disc, list: listPrice, qty });
  }
  return rows;
}

/* Modifica righe di un ordine ricevuto: quantità, prezzi e sconto per riga */
app.put('/api/admin/orders/:id/items', auth('admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Ordine non trovato' });
  const items = buildOrderItems(req.body.items);
  if (!items.length) return res.status(400).json({ error: "L'ordine deve avere almeno un articolo" });
  const total = items.reduce((s, r) => s + r.price * r.qty, 0);
  const note = req.body.note !== undefined ? String(req.body.note).slice(0, 1000) : o.note;
  const tx = db.transaction(() => {
    db.prepare('UPDATE orders SET total=?, note=? WHERE id=?').run(total, note, req.params.id);
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(req.params.id);
    const ins = db.prepare('INSERT INTO order_items (order_id,code,descr,price,qty,disc,list) VALUES (?,?,?,?,?,?,?)');
    for (const r of items) ins.run(req.params.id, r.code, r.descr, r.price, r.qty, r.disc, r.list);
  });
  tx();
  res.json({ ok: true, total });
});

app.get('/api/admin/orders.csv', auth('admin'), (req, res) => {
  const list = db.prepare('SELECT * FROM orders ORDER BY created_at').all();
  const cell = v => { v = String(v == null ? '' : v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const num = n => (Number(n) || 0).toFixed(2).replace('.', ',');
  const out = [['Ordine', 'Data', 'Cliente', 'Cod.Cliente', 'Stato', 'CodiceProdotto', 'Descrizione', 'Quantita', 'PrezzoUnit', 'Subtotale', 'TotaleOrdine', 'Nota']];
  for (const o of list) {
    const items = db.prepare('SELECT code,descr,price,qty,disc,list FROM order_items WHERE order_id=?').all(o.id);
    for (const it of items) out.push([o.id, new Date(o.created_at).toLocaleString('it-IT'), o.client_name, o.client_id, o.status, it.code, it.descr, it.qty, num(it.price), num(it.qty * it.price), num(o.total), o.note || '']);
  }
  const csv = '\uFEFF' + out.map(r => r.map(cell).join(';')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ordini_zetapack.csv"');
  res.send(csv);
});

/* Richieste admin */
app.get('/api/admin/requests', auth('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all());
});
app.patch('/api/admin/requests/:id', auth('admin'), (req, res) => {
  db.prepare('UPDATE requests SET status=? WHERE id=?').run(req.body.status || 'Gestita', req.params.id);
  res.json({ ok: true });
});

/* Clienti admin */
app.get('/api/admin/clients', auth('admin'), (req, res) => {
  const rows = db.prepare('SELECT id,name,city,vat,email,phone,address,contact,cf,sdi,pec,cap,prov,nazione,pa,username FROM clients ORDER BY name').all();
  for (const c of rows) c.orders = db.prepare('SELECT COUNT(*) n FROM orders WHERE client_id=?').get(c.id).n;
  res.json(rows);
});
app.post('/api/admin/clients', auth('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.id || !b.name || !b.username || !b.password) return res.status(400).json({ error: 'Codice, ragione sociale, utente e password obbligatori' });
  if (db.prepare('SELECT 1 FROM clients WHERE id=?').get(b.id)) return res.status(409).json({ error: 'Codice cliente già esistente' });
  if (db.prepare('SELECT 1 FROM clients WHERE username=?').get(b.username) || db.prepare('SELECT 1 FROM admins WHERE username=?').get(b.username))
    return res.status(409).json({ error: 'Nome utente già in uso' });
  db.prepare(`INSERT INTO clients (id,name,city,vat,email,phone,address,contact,cf,sdi,pec,cap,prov,nazione,pa,username,passhash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.id, b.name, b.city || '', b.vat || '', b.email || '', b.phone || '', b.address || '', b.contact || '', b.cf || '', b.sdi || '', b.pec || '', b.cap || '', b.prov || '', b.nazione || 'IT', b.pa ? 1 : 0, b.username, bcrypt.hashSync(b.password, 10), Date.now());
  res.json({ ok: true });
});
app.put('/api/admin/clients/:id', auth('admin'), (req, res) => {
  const cur = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Cliente non trovato' });
  const b = req.body || {};
  const passhash = b.password ? bcrypt.hashSync(b.password, 10) : cur.passhash;
  db.prepare('UPDATE clients SET name=?,city=?,vat=?,email=?,phone=?,address=?,contact=?,cf=?,sdi=?,pec=?,cap=?,prov=?,nazione=?,pa=?,username=?,passhash=? WHERE id=?')
    .run(b.name || cur.name, b.city ?? cur.city, b.vat ?? cur.vat, b.email ?? cur.email, b.phone ?? cur.phone, b.address ?? cur.address, b.contact ?? cur.contact, b.cf ?? cur.cf, b.sdi ?? cur.sdi, b.pec ?? cur.pec, b.cap ?? cur.cap, b.prov ?? cur.prov, b.nazione ?? cur.nazione, (b.pa != null ? (b.pa ? 1 : 0) : cur.pa), b.username || cur.username, passhash, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/clients/:id', auth('admin'), (req, res) => {
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/clients/:id/detail', auth('admin'), (req, res) => {
  const c = db.prepare('SELECT id,name,city,vat,email,phone,address,contact,username FROM clients WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente non trovato' });
  const orders = db.prepare('SELECT * FROM orders WHERE client_id=? ORDER BY created_at DESC').all(req.params.id);
  for (const o of orders) o.items = db.prepare('SELECT code,descr,price,qty,disc,list FROM order_items WHERE order_id=?').all(o.id);
  const quotes = db.prepare('SELECT * FROM quotes WHERE client_id=? ORDER BY created_at DESC').all(req.params.id);
  const communications = db.prepare('SELECT * FROM communications WHERE client_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json({ client: c, orders, quotes, communications });
});

/* ============ FATTURAZIONE ELETTRONICA (SdI) ============ */
function getSetting(k, def) { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); if (!r) return def; try { return JSON.parse(r.v); } catch (e) { return def; } }
function setSetting(k, v) { db.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); }
function getCompany() {
  return getSetting('company', {
    name: 'ZETAPACK Srl', piva: '', cf: '', regime: 'RF01',
    address: '', cap: '', city: '', prov: '', nazione: 'IT',
    tel: '340 0810670', email: 'commerciale@zetapacksrl.it', iban: ''
  });
}

app.get('/api/admin/company', auth('admin'), (req, res) => res.json(getCompany()));
app.put('/api/admin/company', auth('admin'), (req, res) => {
  const b = req.body || {}; const c = getCompany();
  ['name', 'piva', 'cf', 'regime', 'address', 'cap', 'city', 'prov', 'nazione', 'tel', 'email', 'iban'].forEach(k => { if (b[k] != null) c[k] = String(b[k]); });
  setSetting('company', c); res.json({ ok: true, company: c });
});

app.get('/api/admin/invoices', auth('admin'), (req, res) => {
  const rows = db.prepare('SELECT id,numero,anno,tipo,data,client_id,client_json,order_id,imponibile,imposta,totale,aliquota,progressivo,status,created_at FROM invoices ORDER BY created_at DESC').all();
  for (const r of rows) { try { r.client = JSON.parse(r.client_json || '{}'); } catch (e) { r.client = {}; } delete r.client_json; }
  res.json(rows);
});

app.post('/api/admin/invoices/from-order/:id', auth('admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Ordine non trovato' });
  const items = db.prepare('SELECT code,descr,price,qty FROM order_items WHERE order_id=?').all(o.id);
  if (!items.length) return res.status(400).json({ error: 'Ordine senza righe' });
  const cli = o.client_id ? db.prepare('SELECT * FROM clients WHERE id=?').get(o.client_id) : null;
  const b = req.body || {};
  const aliquota = b.aliquota != null ? Number(b.aliquota) : 22;
  const year = new Date().getFullYear();
  const seqKey = 'inv_seq_' + year;
  const seq = (getSetting(seqKey, 0) || 0) + 1; setSetting(seqKey, seq);
  const numero = b.numero || (String(seq).padStart(5, '0') + '/' + year);
  const id = year + '-' + String(seq).padStart(5, '0');
  let imp = 0; items.forEach(it => { imp += Math.round((it.qty || 0) * (it.price || 0) * 100) / 100; });
  imp = Math.round(imp * 100) / 100; const imposta = Math.round(imp * aliquota) / 100; const totale = Math.round((imp + imposta) * 100) / 100;
  const clientSnap = cli ? { id: cli.id, name: cli.name, vat: cli.vat, cf: cli.cf, sdi: cli.sdi, pec: cli.pec, address: cli.address, cap: cli.cap, city: cli.city, prov: cli.prov, nazione: cli.nazione || 'IT', pa: cli.pa } : { name: o.client_name || 'Cliente' };
  db.prepare(`INSERT INTO invoices (id,numero,anno,tipo,data,client_id,client_json,order_id,imponibile,imposta,totale,aliquota,cond_pag,mod_pag,progressivo,note,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, numero, year, b.tipo || 'TD01', Date.now(), o.client_id || null, JSON.stringify(clientSnap), o.id,
    imp, imposta, totale, aliquota, b.condPag || 'TP02', b.modPag || 'MP05', seq, b.note || '', 'Bozza', Date.now());
  const ins = db.prepare('INSERT INTO invoice_items (invoice_id,code,descr,price,qty,um,aliquota) VALUES (?,?,?,?,?,?,?)');
  items.forEach(it => ins.run(id, it.code, it.descr, it.price, it.qty, it.um || '', aliquota));
  logAccess(req, 'admin', 'Azienda', 'Fattura creata', numero);
  res.json({ ok: true, id, numero, totale });
});

app.delete('/api/admin/invoices/:id', auth('admin'), (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/invoices/:id/xml', auth('admin'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Fattura non trovata' });
  const items = db.prepare('SELECT code,descr,price,qty,um,aliquota FROM invoice_items WHERE invoice_id=?').all(inv.id);
  const company = getCompany();
  if (!company.piva) return res.status(400).json({ error: 'Manca la Partita IVA dell\'azienda: compilala in Fatturazione → Dati azienda.' });
  let client = {}; try { client = JSON.parse(inv.client_json || '{}'); } catch (e) {}
  const out = buildFatturaXML(company, client, {
    numero: inv.numero, data: inv.data, tipo: inv.tipo, progressivo: inv.progressivo,
    aliquota: inv.aliquota, condPag: inv.cond_pag, modPag: inv.mod_pag, note: inv.note, order_id: inv.order_id
  }, items);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
  res.send(out.xml);
});

/* ============ MAGAZZINO / IMPORT FATTURE FORNITORI ============ */
function parseDateIt(s) {
  const m = String(s || '').match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!m) return Date.now();
  let d = m[1], mo = m[2], y = m[3]; y = y.length === 2 ? '20' + y : y;
  const t = new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
  return isNaN(t) ? Date.now() : t;
}
function slugId(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || ('f-' + Date.now()); }

app.post('/api/admin/purchases/parse', auth('admin'), async (req, res) => {
  const b = req.body || {};
  const data = String(b.pdf || '').replace(/^data:.*?;base64,/, '');
  if (!data) return res.status(400).json({ error: 'File mancante' });
  let buf; try { buf = Buffer.from(data, 'base64'); } catch (e) { return res.status(400).json({ error: 'File non valido' }); }
  try {
    const out = await parseAny(buf);
    (out.items || []).forEach(it => {
      let match = null;
      if (it.code) match = db.prepare('SELECT code,descr,price,supcode FROM products WHERE code=? COLLATE NOCASE OR supcode=? COLLATE NOCASE LIMIT 1').get(String(it.code), String(it.code));
      if (!match && it.descr) match = db.prepare('SELECT code,descr,price,supcode FROM products WHERE descr=? LIMIT 1').get(String(it.descr));
      it.listino = match ? { found: true, code: match.code, supcode: match.supcode, descr: match.descr, price: match.price } : { found: false };
    });
    res.json(out);
  }
  catch (e) { res.status(500).json({ error: 'Lettura fattura non riuscita: ' + e.message }); }
});

app.post('/api/admin/purchases/confirm', auth('admin'), (req, res) => {
  const b = req.body || {};
  const s = b.supplier || {}; const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'Nessun articolo da importare' });
  let sup = null;
  if (s.piva) sup = db.prepare('SELECT * FROM suppliers WHERE piva=?').get(String(s.piva));
  if (!sup && s.name) sup = db.prepare('SELECT * FROM suppliers WHERE name=?').get(String(s.name));
  let supId;
  if (sup) {
    supId = sup.id;
    db.prepare('UPDATE suppliers SET name=?,piva=?,cf=?,pec=?,email=?,address=?,cap=?,city=?,prov=? WHERE id=?')
      .run(s.name || sup.name, s.piva || sup.piva, s.cf || sup.cf, s.pec || sup.pec, s.email || sup.email, s.address || sup.address, s.cap || sup.cap, s.city || sup.city, s.prov || sup.prov, supId);
  } else {
    supId = s.piva ? 'F-' + s.piva : slugId(s.name);
    db.prepare('INSERT INTO suppliers (id,name,piva,cf,pec,email,address,cap,city,prov,phone,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(supId, s.name || 'Fornitore', s.piva || '', s.cf || '', s.pec || '', s.email || '', s.address || '', s.cap || '', s.city || '', s.prov || '', '', Date.now());
  }
  const p = b.purchase || {}; const numero = p.numero || ('ACQ-' + Date.now());
  const dataTs = parseDateIt(p.data);
  const pid = supId + '_' + slugId(numero) + '_' + Date.now().toString(36);
  const tot = p.totals || {};
  let stored = ''; const fname = b.fname || (numero + '.pdf');
  // conserva il file originale (pdf / xml / p7m) con la sua estensione
  const em = String(fname).toLowerCase().match(/\.(pdf|xml|p7m)$/); const ext = em ? em[1] : 'pdf';
  if (b.pdf) { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); stored = pid + '.' + ext; fs.writeFileSync(path.join(UPLOAD_DIR, stored), Buffer.from(String(b.pdf).replace(/^data:.*?;base64,/, ''), 'base64')); } catch (e) { stored = ''; } }
  db.prepare('INSERT INTO purchases (id,supplier_id,numero,data,imponibile,imposta,totale,file,fname,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(pid, supId, numero, dataTs, Number(tot.imponibile) || 0, Number(tot.imposta) || 0, Number(tot.totale) || 0, stored, fname, Date.now());
  const insIt = db.prepare('INSERT INTO purchase_items (purchase_id,code,descr,um,qty,price,vat,total,sconto,sconti) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const findW = db.prepare("SELECT * FROM warehouse WHERE supplier_id=? AND supplier_code=? COLLATE NOCASE AND supplier_code<>''");
  const findWd = db.prepare('SELECT * FROM warehouse WHERE supplier_id=? AND descr=? COLLATE NOCASE');
  const updW = db.prepare('UPDATE warehouse SET code=?,descr=?,um=?,last_price=?,vat=?,qty_stock=qty_stock+?,last_purchase=?,updated_at=? WHERE id=?');
  // match forte (fornitore + codice fornitore): aggiorna SOLO il prezzo d'acquisto e carica le quantità
  const updWprice = db.prepare('UPDATE warehouse SET last_price=?,vat=?,qty_stock=qty_stock+?,last_purchase=?,updated_at=? WHERE id=?');
  const insW = db.prepare('INSERT INTO warehouse (supplier_id,supplier_code,code,descr,um,category,last_price,vat,qty_stock,last_purchase,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const getW = db.prepare('SELECT * FROM warehouse WHERE id=?');
  let nNew = 0, nUpd = 0, nCarico = 0;
  const tx = db.transaction(() => {
    for (const it of items) {
      const qty = Number(it.qty) || 0, price = Number(it.price) || 0, vat = it.vat == null || it.vat === '' ? null : Number(it.vat);
      const total = Number(it.total) || Math.round(qty * price * 100) / 100;
      const sconti = Array.isArray(it.sconti) ? it.sconti.filter(x => x != null && x !== '' && !isNaN(Number(x))).map(Number) : [];
      const whDescr = (it.descr_listino && String(it.descr_listino).trim()) ? String(it.descr_listino).trim() : (it.descr || '');
      const whUm = (it.um_wh && String(it.um_wh).trim()) ? String(it.um_wh).trim() : (it.um || '');
      // €/pz: se l'utente lo forza usa quello; altrimenti applica gli sconti IN SERIE sul prezzo di listino; altrimenti totale/qtà
      let whPrice;
      if (it.unit != null && it.unit !== '' && !isNaN(Number(it.unit))) whPrice = Number(it.unit);
      else if (price > 0 && sconti.length) { let f = 1; sconti.forEach(s => { f *= (1 - s / 100); }); whPrice = Math.round(price * f * 10000) / 10000; }
      else whPrice = qty ? Math.round((total / qty) * 10000) / 10000 : price;
      insIt.run(pid, it.code || '', it.descr || '', it.um || '', qty, price, vat, total, sconti.length ? Number(sconti[0]) : null, JSON.stringify(sconti));
      let w = it.wh_id ? getW.get(it.wh_id) : null;
      // match FORTE automatico: stesso fornitore + stesso codice fornitore
      let strong = false;
      if (!w && it.code) { const wc = findW.get(supId, String(it.code)); if (wc) { w = wc; strong = true; } }
      if (!w) w = findWd.get(supId, whDescr);
      const whCode = (it.intcode && String(it.intcode).trim()) ? String(it.intcode).trim() : (w && w.code ? w.code : '');
      if (w && strong) {
        // prodotto GIÀ presente (fornitore + codice fornitore): aggiorna solo prezzo d'acquisto + carico quantità
        updWprice.run(whPrice || w.last_price, vat != null ? vat : w.vat, qty, dataTs, Date.now(), w.id); nCarico++;
      } else if (w) {
        // match su descrizione o riga collegata a mano: aggiorna i dati e carica
        updW.run(whCode, whDescr || w.descr, whUm || w.um, whPrice || w.last_price, vat != null ? vat : w.vat, qty, dataTs, Date.now(), w.id); nUpd++;
      } else {
        insW.run(supId, it.code || '', whCode, whDescr, whUm, it.category || '', whPrice, vat, qty, dataTs, Date.now()); nNew++;
      }
    }
  });
  tx();
  logAccess(req, 'admin', 'Azienda', 'Import fattura acquisto', (s.name || '') + ' ' + numero);
  res.json({ ok: true, supplier_id: supId, purchase_id: pid, nuovi: nNew, aggiornati: nUpd, carichi: nCarico });
});

app.get('/api/admin/suppliers', auth('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  for (const r of rows) r.purchases = db.prepare('SELECT COUNT(*) n FROM purchases WHERE supplier_id=?').get(r.id).n;
  res.json(rows);
});
app.get('/api/admin/purchases', auth('admin'), (req, res) => {
  res.json(db.prepare('SELECT p.*, s.name supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.created_at DESC').all());
});
app.get('/api/admin/warehouse', auth('admin'), (req, res) => {
  res.json(db.prepare('SELECT w.*, s.name supplier_name FROM warehouse w LEFT JOIN suppliers s ON s.id=w.supplier_id ORDER BY w.updated_at DESC').all());
});
app.patch('/api/admin/warehouse/:id', auth('admin'), (req, res) => {
  const b = req.body || {}; const w = db.prepare('SELECT * FROM warehouse WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Articolo non trovato' });
  db.prepare('UPDATE warehouse SET descr=?,um=?,category=?,last_price=?,vat=?,qty_stock=?,updated_at=? WHERE id=?')
    .run(b.descr ?? w.descr, b.um ?? w.um, b.category ?? w.category, b.last_price ?? w.last_price, b.vat ?? w.vat, b.qty_stock ?? w.qty_stock, Date.now(), w.id);
  res.json({ ok: true });
});
app.delete('/api/admin/warehouse/:id', auth('admin'), (req, res) => { db.prepare('DELETE FROM warehouse WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// Anagrafica fornitori: scheda con i documenti (fatture d'acquisto importate)
app.get('/api/admin/suppliers/:id/detail', auth('admin'), (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Fornitore non trovato' });
  const purchases = db.prepare('SELECT id,numero,data,imponibile,imposta,totale,file,fname,created_at FROM purchases WHERE supplier_id=? ORDER BY created_at DESC').all(s.id);
  for (const p of purchases) p.righe = db.prepare('SELECT COUNT(*) n FROM purchase_items WHERE purchase_id=?').get(p.id).n;
  const articles = db.prepare('SELECT COUNT(*) n FROM warehouse WHERE supplier_id=?').get(s.id).n;
  res.json({ supplier: s, purchases, articles });
});
app.put('/api/admin/suppliers/:id', auth('admin'), (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Fornitore non trovato' });
  const b = req.body || {};
  db.prepare('UPDATE suppliers SET name=?,piva=?,cf=?,pec=?,email=?,phone=?,address=?,cap=?,city=?,prov=? WHERE id=?')
    .run(b.name ?? s.name, b.piva ?? s.piva, b.cf ?? s.cf, b.pec ?? s.pec, b.email ?? s.email, b.phone ?? s.phone, b.address ?? s.address, b.cap ?? s.cap, b.city ?? s.city, b.prov ?? s.prov, s.id);
  res.json({ ok: true });
});
app.delete('/api/admin/suppliers/:id', auth('admin'), (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM purchases WHERE supplier_id=?').get(req.params.id).n;
  if (n > 0) return res.status(400).json({ error: 'Il fornitore ha ' + n + ' documenti collegati: non può essere eliminato.' });
  db.prepare('DELETE FROM warehouse WHERE supplier_id=?').run(req.params.id);
  db.prepare('DELETE FROM suppliers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Apri/scarica il PDF della fattura d'acquisto importata (documento collegato)
app.get('/api/admin/purchases/:id/file', auth('admin'), (req, res) => {
  const p = db.prepare('SELECT file,fname FROM purchases WHERE id=?').get(req.params.id);
  if (!p || !p.file) return res.status(404).json({ error: 'Documento non disponibile' });
  const fp = path.join(UPLOAD_DIR, p.file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File non trovato' });
  const low = String(p.file).toLowerCase();
  const isXml = low.endsWith('.xml'), isP7m = low.endsWith('.p7m');
  const ctype = isXml ? 'application/xml' : (isP7m ? 'application/pkcs7-mime' : 'application/pdf');
  // PDF in anteprima nel browser; XML/p7m come download
  const disp = (isXml || isP7m) ? 'attachment' : 'inline';
  res.setHeader('Content-Type', ctype);
  res.setHeader('Content-Disposition', `${disp}; filename="${(p.fname || ('fattura.' + (isXml ? 'xml' : isP7m ? 'p7m' : 'pdf'))).replace(/"/g, '')}"`);
  fs.createReadStream(fp).pipe(res);
});

// Scarico/ripristino giacenze per le righe di un ordine (match su codice interno del magazzino)
function applyOrderStock(orderId, sign) {
  const items = db.prepare('SELECT code,qty FROM order_items WHERE order_id=?').all(orderId);
  const find = db.prepare("SELECT id FROM warehouse WHERE code=? COLLATE NOCASE AND code<>'' ORDER BY qty_stock DESC LIMIT 1");
  const upd = db.prepare('UPDATE warehouse SET qty_stock=qty_stock+?, updated_at=? WHERE id=?');
  let moved = 0;
  for (const it of items) { if (!it.code) continue; const w = find.get(String(it.code)); if (w) { upd.run(sign * (Number(it.qty) || 0), Date.now(), w.id); moved++; } }
  return moved;
}

// Provenienza di un articolo di magazzino: fornitore + documenti (fatture) in cui compare
app.get('/api/admin/warehouse/:id/detail', auth('admin'), (req, res) => {
  const w = db.prepare('SELECT w.*, s.name supplier_name FROM warehouse w LEFT JOIN suppliers s ON s.id=w.supplier_id WHERE w.id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Articolo non trovato' });
  const purchases = db.prepare(`SELECT DISTINCT p.id,p.numero,p.data,p.totale,p.file,p.fname,p.created_at
    FROM purchases p JOIN purchase_items pi ON pi.purchase_id=p.id
    WHERE p.supplier_id=? AND ( (pi.code<>'' AND pi.code=? COLLATE NOCASE) OR pi.descr=? COLLATE NOCASE )
    ORDER BY p.created_at DESC`).all(w.supplier_id || '', w.supplier_code || '', w.descr || '');
  res.json({ article: w, supplier: { id: w.supplier_id, name: w.supplier_name }, purchases });
});

// Ricerca per l'aggancio manuale in fase di import: articoli del fornitore (in magazzino) + listino completo
app.get('/api/admin/import/lookup', auth('admin'), (req, res) => {
  const piva = String(req.query.piva || ''); const name = String(req.query.name || '');
  let sup = null;
  if (piva) sup = db.prepare('SELECT id,name FROM suppliers WHERE piva=?').get(piva);
  if (!sup && name) sup = db.prepare('SELECT id,name FROM suppliers WHERE name=?').get(name);
  let supplierArticles = [];
  if (sup) supplierArticles = db.prepare('SELECT id, supplier_code, code, descr, um, last_price, qty_stock FROM warehouse WHERE supplier_id=? ORDER BY descr').all(sup.id);
  const listino = db.prepare('SELECT code, descr, supcode, price FROM products ORDER BY descr LIMIT 1000').all();
  res.json({ supplierFound: supplierArticles.length > 0, supplierName: sup ? sup.name : '', supplierArticles, listino });
});

app.get('/api/admin/logs', auth('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM access_logs ORDER BY ts DESC LIMIT 500').all());
});

app.post('/api/admin/send-credentials', auth('admin'), async (req, res) => {
  const { to, name, username, password, channel } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Utente o password mancanti' });
  const c = db.prepare('SELECT id FROM clients WHERE username=?').get(username);
  if (channel === 'whatsapp') {
    logComm(c && c.id, 'Credenziali (WhatsApp)', 'Invio credenziali via WhatsApp', to || '');
    return res.json({ ok: true });
  }
  const email = (to || '').trim();
  if (!email) return res.status(400).json({ error: "Manca l'email del cliente" });
  const subject = 'I tuoi accessi al portale ZETAPACK';
  const link = process.env.PUBLIC_URL || '';
  const text = 'Spett.le ' + (name || '') + ",\n\necco le credenziali per accedere all'area riservata del portale ZETAPACK, dove potete consultare i prezzi e inviare le richieste d'ordine:\n\n" +
    'Utente: ' + username + '\nPassword: ' + password + '\n' + (link ? ('\nAccedete qui: ' + link + '\n') : '') +
    '\nVi consigliamo di custodire queste credenziali con cura.\n\nCordiali saluti,\nZETAPACK Srl';
  try {
    await sendMail({ to: email, bcc: process.env.MAIL_ADMIN || undefined, subject, text });
    logComm(c && c.id, 'Credenziali (email)', subject, email);
    res.json({ ok: true, dev: !mailReady() });
  } catch (e) { console.error('[mail]', e.message); res.status(502).json({ error: 'Invio non riuscito: ' + e.message }); }
});

/* ============================ BACKUP / RIPRISTINO ============================ */const BK_TABLES = ['clients', 'products', 'orders', 'order_items', 'quotes', 'quote_items', 'requests', 'communications', 'access_logs', 'admins'];
function tableCols(t) { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }

app.get('/api/admin/backup', auth('admin'), (req, res) => {
  const out = { app: 'zetapack', version: '4.9', created_at: Date.now(), tables: {}, files: {} };
  for (const t of BK_TABLES) { try { out.tables[t] = db.prepare('SELECT * FROM ' + t).all(); } catch (e) { out.tables[t] = []; } }
  const files = new Set();
  for (const o of (out.tables.orders || [])) { if (o.ddt_file) files.add(o.ddt_file); if (o.invoice_file) files.add(o.invoice_file); }
  for (const fn of files) { try { const fp = path.join(UPLOAD_DIR, fn); if (fs.existsSync(fp)) out.files[fn] = fs.readFileSync(fp).toString('base64'); } catch (e) {} }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="zetapack-backup-${stamp}.json"`);
  res.json(out);
});

app.post('/api/admin/restore', auth('admin'), (req, res) => {
  const bk = req.body;
  if (!bk || bk.app !== 'zetapack' || !bk.tables) return res.status(400).json({ error: 'File di backup non valido' });
  try {
    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      for (const t of BK_TABLES) {
        if (!Array.isArray(bk.tables[t])) continue;
        db.prepare('DELETE FROM ' + t).run();
        const valid = new Set(tableCols(t));
        for (const row of bk.tables[t]) {
          const cols = Object.keys(row).filter(k => valid.has(k));
          if (!cols.length) continue;
          const clean = {}; cols.forEach(c => clean[c] = row[c]);
          db.prepare('INSERT INTO ' + t + ' (' + cols.join(',') + ') VALUES (' + cols.map(c => '@' + c).join(',') + ')').run(clean);
        }
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
    if (bk.files && typeof bk.files === 'object') {
      for (const [fn, data] of Object.entries(bk.files)) {
        if (!/^[\w.\-]+$/.test(fn)) continue;
        try { fs.writeFileSync(path.join(UPLOAD_DIR, fn), Buffer.from(String(data), 'base64')); } catch (e) {}
      }
    }
    res.json({ ok: true });
  } catch (e) {
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    console.error('[restore]', e.message);
    res.status(500).json({ error: 'Ripristino non riuscito: ' + e.message });
  }
});

/* Fallback SPA */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint non trovato: aggiorna server.js sul server' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ZETAPACK Portale — backend attivo su http://localhost:${PORT}`);
  console.log(`  Email: ${mailReady() ? 'SMTP configurato' : 'modalità sviluppo (log in console)'}`);
});
