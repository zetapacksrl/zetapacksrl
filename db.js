'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'zetapack.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); // crea la cartella (utile sul disco persistente)
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* ---------------- Schema ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  code      TEXT PRIMARY KEY,
  descr     TEXT NOT NULL,
  um        TEXT,
  cost      REAL,
  price     REAL,
  supplier  TEXT,
  supcode   TEXT,
  category  TEXT,
  tags      TEXT,            -- JSON array
  minq      REAL DEFAULT 1,
  published INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clients (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  city      TEXT,
  vat       TEXT,
  email     TEXT,
  username  TEXT UNIQUE NOT NULL,
  passhash  TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  client_id  TEXT,
  client_name TEXT,
  status     TEXT DEFAULT 'Nuovo',
  note       TEXT,
  total      REAL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  code     TEXT,
  descr    TEXT,
  price    REAL,
  qty      REAL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requests (
  id         TEXT PRIMARY KEY,
  type       TEXT,
  company    TEXT,
  name       TEXT,
  vat        TEXT,
  email      TEXT,
  phone      TEXT,
  msg        TEXT,
  status     TEXT DEFAULT 'Aperta',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  name     TEXT,
  passhash TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id          TEXT PRIMARY KEY,
  client_id   TEXT,
  client_name TEXT,
  to_email    TEXT,
  status      TEXT DEFAULT 'Bozza',
  note        TEXT,
  validity    INTEGER DEFAULT 30,
  total       REAL,
  created_at  INTEGER,
  sent_at     INTEGER
);

CREATE TABLE IF NOT EXISTS quote_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id TEXT NOT NULL,
  code     TEXT,
  descr    TEXT,
  price    REAL,
  qty      REAL,
  FOREIGN KEY(quote_id) REFERENCES quotes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS communications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT,
  type       TEXT,
  subject    TEXT,
  to_email   TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS access_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER,
  kind      TEXT,
  client_id TEXT,
  who       TEXT,
  action    TEXT,
  detail    TEXT,
  ip        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id          TEXT PRIMARY KEY,
  numero      TEXT,
  anno        INTEGER,
  tipo        TEXT DEFAULT 'TD01',
  data        INTEGER,
  client_id   TEXT,
  client_json TEXT,
  order_id    TEXT,
  imponibile  REAL,
  imposta     REAL,
  totale      REAL,
  aliquota    REAL DEFAULT 22,
  cond_pag    TEXT DEFAULT 'TP02',
  mod_pag     TEXT DEFAULT 'MP05',
  progressivo INTEGER,
  note        TEXT,
  status      TEXT DEFAULT 'Bozza',
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL,
  code       TEXT,
  descr      TEXT,
  price      REAL,
  qty        REAL,
  um         TEXT,
  aliquota   REAL,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT, piva TEXT, cf TEXT, pec TEXT, email TEXT,
  address TEXT, cap TEXT, city TEXT, prov TEXT, phone TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, supplier_id TEXT, numero TEXT, data INTEGER,
  imponibile REAL, imposta REAL, totale REAL, file TEXT, fname TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id TEXT NOT NULL,
  code TEXT, descr TEXT, um TEXT, qty REAL, price REAL, vat REAL, total REAL,
  FOREIGN KEY(purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS warehouse (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id TEXT, supplier_code TEXT,
  descr TEXT, um TEXT, category TEXT, last_price REAL, vat REAL,
  qty_stock REAL DEFAULT 0, last_purchase INTEGER, updated_at INTEGER
);
`);

/* ---------------- Migrazioni (aggiunge colonne mancanti) ---------------- */
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('clients', 'phone', 'phone TEXT');
ensureColumn('clients', 'address', 'address TEXT');
ensureColumn('clients', 'contact', 'contact TEXT');
ensureColumn('clients', 'cf', 'cf TEXT');            /* codice fiscale */
ensureColumn('clients', 'sdi', 'sdi TEXT');          /* codice destinatario SdI (7) */
ensureColumn('clients', 'pec', 'pec TEXT');          /* PEC destinatario */
ensureColumn('clients', 'cap', 'cap TEXT');
ensureColumn('clients', 'prov', 'prov TEXT');
ensureColumn('clients', 'nazione', 'nazione TEXT');
ensureColumn('clients', 'pa', 'pa INTEGER DEFAULT 0'); /* è Pubblica Amministrazione (FPA12) */
ensureColumn('purchase_items', 'sconto', 'sconto REAL');
ensureColumn('purchase_items', 'sconti', 'sconti TEXT'); /* serie sconti applicati in cascata, es. [20,25,62] */
ensureColumn('warehouse', 'code', 'code TEXT'); /* codice interno / listino, distinto dal codice fornitore */
ensureColumn('orders', 'ddt_num', 'ddt_num TEXT');
ensureColumn('orders', 'ddt_date', 'ddt_date TEXT');
ensureColumn('orders', 'invoice_num', 'invoice_num TEXT');
ensureColumn('orders', 'invoice_date', 'invoice_date TEXT');
ensureColumn('orders', 'ddt_file', 'ddt_file TEXT');
ensureColumn('orders', 'ddt_fname', 'ddt_fname TEXT');
ensureColumn('orders', 'invoice_file', 'invoice_file TEXT');
ensureColumn('orders', 'invoice_fname', 'invoice_fname TEXT');
ensureColumn('orders', 'stock_done', 'stock_done INTEGER DEFAULT 0'); /* giacenze già scaricate per questo ordine */
ensureColumn('products', 'image', 'image TEXT');
ensureColumn('order_items', 'disc', 'disc REAL DEFAULT 0');
ensureColumn('order_items', 'list', 'list REAL');
ensureColumn('quote_items', 'disc', 'disc REAL DEFAULT 0');
ensureColumn('quote_items', 'list', 'list REAL');
ensureColumn('products', 'promo', 'promo INTEGER DEFAULT 0');
ensureColumn('products', 'promo_price', 'promo_price REAL');
ensureColumn('access_logs', 'ua', 'ua TEXT');
ensureColumn('access_logs', 'ref', 'ref TEXT');

/* ---------------- Seed prodotti (solo se vuoto) ---------------- */
function seedProducts() {
  const count = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  if (count > 0) return count;
  const file = path.join(__dirname, 'data', 'products.json');
  if (!fs.existsSync(file)) return 0;
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ins = db.prepare(`INSERT OR REPLACE INTO products
    (code,descr,um,cost,price,supplier,supcode,category,tags,minq,published)
    VALUES (@code,@descr,@um,@cost,@price,@supplier,@supcode,@category,@tags,@minq,@published)`);
  const tx = db.transaction((list) => {
    for (const p of list) ins.run({
      code: p.code, descr: p.descr || p.code, um: p.um || 'pz',
      cost: p.cost ?? null, price: p.price ?? null,
      supplier: p.supplier || '', supcode: p.supcode || '',
      category: p.category || 'Altro', tags: JSON.stringify(p.tags || []),
      minq: p.minq || 1, published: p.published ? 1 : 0
    });
  });
  tx(rows);
  return db.prepare('SELECT COUNT(*) n FROM products').get().n;
}

/* ---------------- Seed admin + cliente demo ---------------- */
function seedAccounts() {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'admin123';
  const exists = db.prepare('SELECT 1 FROM admins WHERE username=?').get(adminUser);
  if (!exists) {
    db.prepare('INSERT INTO admins (username,name,passhash) VALUES (?,?,?)')
      .run(adminUser, 'ZETAPACK — Amministrazione', bcrypt.hashSync(adminPass, 10));
  }
  const cCount = db.prepare('SELECT COUNT(*) n FROM clients').get().n;
  if (cCount === 0) {
    const ins = db.prepare(`INSERT INTO clients (id,name,city,vat,email,username,passhash,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    ins.run('C-001', 'Bar Trattoria Al Ponte', 'Verona', 'IT 03421150247', 'demo@alponte.it',
            'cliente', bcrypt.hashSync('cliente123', 10), Date.now());
  }
}

seedProducts();
seedAccounts();

module.exports = { db, bcrypt };
