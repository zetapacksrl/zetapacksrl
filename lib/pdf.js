'use strict';
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const LOGO = path.join(__dirname, '..', 'assets', 'logo.png');
const GREEN = '#2FB81C';
const INK = '#101311';
const MUT = '#6B7568';

let _db = null;
try { _db = require('./db').db; } catch (e) {}

function euro(n) {
  return '€ ' + (Number(n) || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function fetchImage(url) {
  try {
    if (!url) return null;
    if (url.startsWith('data:')) { const b64 = url.split(',')[1]; return b64 ? Buffer.from(b64, 'base64') : null; }
    if (!/^https?:\/\//.test(url)) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) { return null; }
}

/* Recupera le immagini (JPEG/PNG) dei prodotti per codice, per disegnarle nel PDF. */
async function buildImageMap(items) {
  const map = {};
  if (!_db) return map;
  const codes = [...new Set((items || []).map(it => it.code).filter(Boolean))];
  const wanted = [];
  for (const code of codes) {
    let url = null;
    try { const row = _db.prepare('SELECT image FROM products WHERE code=?').get(code); url = row && row.image; } catch (e) {}
    if (url) wanted.push({ code, url });
  }
  await Promise.all(wanted.map(async ({ code, url }) => { const buf = await fetchImage(url); if (buf) map[code] = buf; }));
  return map;
}

/**
 * Genera il PDF di un ordine/preventivo e restituisce un Buffer.
 * @param {object} order  { id, client_name, client_id, status, note, total, created_at, items:[{code,descr,price,qty}] }
 * @param {object} opts   { title, client:{name,vat,city,email} }
 */
async function orderPdf(order, opts = {}) {
  const imgMap = await buildImageMap(order.items);
  const hasImg = Object.keys(imgMap).length > 0;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const title = opts.title || 'Richiesta d\'ordine';
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    /* Header: logo + titolo documento */
    try { if (fs.existsSync(LOGO)) doc.image(LOGO, left, 40, { height: 34 }); } catch (e) {}
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(title, left, 44, { align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(MUT)
       .text(order.id, { align: 'right' })
       .text(new Date(order.created_at).toLocaleString('it-IT'), { align: 'right' });

    /* Riga verde */
    doc.moveTo(left, 92).lineTo(left + pageW, 92).lineWidth(2).strokeColor(GREEN).stroke();

    /* Mittente / destinatario */
    const y0 = 108;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text('ZETAPACK Srl', left, y0);
    doc.font('Helvetica').fontSize(9).fillColor(MUT)
       .text('Imballaggi, monouso e materiali di consumo', left, y0 + 15);

    const c = opts.client || {};
    const rx = left + pageW / 2;
    doc.fillColor(MUT).font('Helvetica-Bold').fontSize(9).text('CLIENTE', rx, y0);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(c.name || order.client_name || '', rx, y0 + 12);
    doc.font('Helvetica').fontSize(9).fillColor(MUT);
    if (c.vat) doc.text('P.IVA: ' + c.vat, rx);
    if (c.address) doc.text(c.address, rx);
    if (c.city) doc.text(c.city, rx);
    if (c.email) doc.text(c.email, rx);
    if (c.phone) doc.text('Tel: ' + c.phone, rx);
    doc.text('Codice: ' + (order.client_id || ''), rx);

    /* Stato */
    doc.fillColor(INK).font('Helvetica').fontSize(9).text('Stato: ' + (order.status || 'Nuovo'), left, y0 + 34);

    /* Tabella articoli */
    const thumbW = hasImg ? 26 : 0;
    let y = y0 + 66;
    const cols = { thumb: left, code: left + thumbW, descr: left + thumbW + 76, qty: left + pageW - 170, price: left + pageW - 110, sub: left + pageW - 50 };
    doc.rect(left, y - 4, pageW, 20).fill('#F1F5EF');
    doc.fillColor(MUT).font('Helvetica-Bold').fontSize(8.5);
    doc.text('CODICE', cols.code + 4, y + 1);
    doc.text('DESCRIZIONE', cols.descr, y + 1);
    doc.text('Q.TÀ', cols.qty, y + 1, { width: 40, align: 'right' });
    doc.text('PREZZO', cols.price, y + 1, { width: 55, align: 'right' });
    doc.text('SUBTOT.', cols.sub, y + 1, { width: 46, align: 'right' });
    y += 22;

    doc.font('Helvetica').fontSize(9).fillColor(INK);
    for (const it of order.items) {
      const dtxt = it.descr + (it.disc > 0 ? '  (sconto ' + (Math.round(it.disc * 10) / 10) + '%)' : '');
      const dh = doc.heightOfString(dtxt, { width: cols.qty - cols.descr - 10 });
      const rh = Math.max(hasImg ? 28 : 16, dh + 4);
      if (y + rh > doc.page.height - 80) { doc.addPage(); y = 60; }
      if (hasImg && imgMap[it.code]) { try { doc.image(imgMap[it.code], cols.thumb, y - 1, { fit: [22, 22], align: 'center', valign: 'center' }); } catch (e) {} }
      doc.fillColor(INK).fontSize(8).font('Helvetica').text(it.code, cols.code + 4, y, { width: 72 });
      doc.fontSize(9).text(dtxt, cols.descr, y, { width: cols.qty - cols.descr - 10 });
      doc.text(String(it.qty), cols.qty, y, { width: 40, align: 'right' });
      doc.text(euro(it.price), cols.price, y, { width: 55, align: 'right' });
      doc.font('Helvetica-Bold').text(euro(it.qty * it.price), cols.sub, y, { width: 46, align: 'right' });
      doc.font('Helvetica');
      y += rh;
      doc.moveTo(left, y - 2).lineTo(left + pageW, y - 2).lineWidth(0.5).strokeColor('#E4E9DF').stroke();
    }

    /* Totale */
    y += 8;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
       .text('Totale indicativo', cols.price - 60, y, { width: 120, align: 'right' })
       .text(euro(order.total), cols.sub - 20, y, { width: 66, align: 'right' });

    if (opts.validity) {
      y += 26;
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUT)
         .text(`Preventivo valido ${opts.validity} giorni dalla data di emissione. Prezzi IVA esclusa, salvo conferma disponibilità.`, left, y, { width: pageW });
    }

    if (order.note) {
      y += opts.validity ? 16 : 28;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUT).text('Nota:', left, y);
      doc.font('Helvetica').fillColor(INK).text(order.note, left, y + 12, { width: pageW });
    }

    /* Footer */
    doc.fontSize(8).fillColor(MUT).font('Helvetica')
       .text('Documento generato automaticamente dal Portale ZETAPACK. Prezzi e disponibilità soggetti a conferma.',
             left, doc.page.height - 60, { width: pageW, align: 'center' });

    doc.end();
  });
}

module.exports = { orderPdf };
