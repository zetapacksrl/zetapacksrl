'use strict';
/**
 * Import fatture d'acquisto (fornitori) da PDF → dati fornitore + righe articoli.
 * - extractText(buffer): testo del PDF (pdf-parse v2)
 * - heuristicParse(text): estrazione a regole (fallback, sempre disponibile)
 * - aiParse(base64): estrazione robusta via Anthropic API (se ANTHROPIC_API_KEY è impostata)
 * - parseInvoice(buffer, base64): prova AI, poi euristica; ritorna sempre una struttura + metodo usato
 *
 * NB: l'estrazione da PDF liberi non è affidabile al 100%: il risultato va SEMPRE
 * rivisto/corretto dall'operatore prima di importarlo in magazzino.
 */
// pdf-parse caricato in modo "pigro": l'import XML/.p7m non dipende dalla libreria PDF
async function extractText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const r = await parser.getText();
  return (r && r.text) || '';
}

function toNum(s) {
  if (s == null) return 0;
  let t = String(s).trim().replace(/[^\d.,-]/g, '');
  if (t.indexOf(',') > -1) t = t.replace(/\./g, '').replace(',', '.');       // 1.234,56 → 1234.56
  else if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');          // 1.680 → 1680 (migliaia); NON tocca 0.097
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}
const isNumTok = t => /^-?\d{1,3}(\.\d{3})+(,\d+)?$|^-?\d+(?:[.,]\d+)?$/.test(t);

function heuristicParse(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\t/g, ' ').trim()).filter(Boolean);
  const joined = lines.join('\n');
  const supplier = { name: '', piva: '', cf: '', pec: '', email: '', address: '', cap: '', city: '', prov: '' };

  let m = joined.match(/P\.?\s*IVA[:\s]*([0-9]{11})/i) || joined.match(/\b([0-9]{11})\b/);
  if (m) supplier.piva = m[1];
  m = joined.match(/Cod(?:ice)?\.?\s*Fisc(?:ale)?[:.\s]*([A-Z0-9]{11,16})/i);
  if (m) supplier.cf = m[1].toUpperCase();
  m = joined.match(/([A-Z0-9._%+-]+@(?:pec|legalmail|postecert)[A-Z0-9.-]*\.[A-Z]{2,})/i) || joined.match(/PEC[:\s]*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (m) supplier.pec = m[1];
  m = joined.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (m && !supplier.email) supplier.email = m[1];

  const nameLine = lines.find(l => /(s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|\bditta\b)/i.test(l) && !/spett/i.test(l)) || lines[0] || '';
  supplier.name = nameLine.replace(/\s{2,}/g, ' ').slice(0, 80);
  const viaLine = lines.find(l => /^(via|viale|v\.le|piazza|p\.zza|corso|c\.so|strada|str\.|localit|loc\.|largo)/i.test(l) && !/spett/i.test(l));
  if (viaLine) supplier.address = viaLine.slice(0, 60);
  const capLine = lines.find(l => /\b\d{5}\b/.test(l) && !/spett/i.test(l) && !/p\.?\s*iva/i.test(l));
  if (capLine) { const am = capLine.match(/(\d{5})\s+([A-Za-z\u00C0-\u017F'\u2019.\- ]+?)\s*\(?([A-Z]{2})\)?\s*$/); if (am) { supplier.cap = am[1]; supplier.city = am[2].trim(); supplier.prov = am[3]; } }

  let numero = '', data = '';
  m = joined.match(/fattura[\s\S]{0,20}?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i);
  if (m) data = m[1]; else { const d = joined.match(/\b(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\b/); if (d) data = d[1]; }
  m = joined.match(/(\d{1,7})\s+fattura/i) || joined.match(/fattura\s*(?:n[.\u00b0]?|numero)?\s*[:.]?\s*(\d{1,7})/i);
  if (m) numero = m[1];

  const skip = /descrizione|imponibile|\btotale\b|\biva\b|\bimposta\b|spett|p\.?\s*iva|cod(?:ice)?\.?\s*fisc|pagament|scadenz|\bbanca\b|iban|causale|\bddt\b|^note$|^fornitore$|dati del documento|serie\s*\/\s*numero|documento esterno|spese di|^sconti$|printed with|invoicex|www\.|pag\.\s*\d/i;
  const UM = /^(PZ|PZ\.|PEZ|KG|KIL|CT|CF|LT|L|MT|M|ML|GR|G|NR|N|N\u00b0|CONF|COLLI|COLLO|SC|SCAT|BANCALE|PACCO|BOX|ROT|RT|BOB|CAD|MC|MQ|H|RIS|RISME)$/i;
  const isInt = v => Math.abs(v - Math.round(v)) < 1e-9;
  const RATES = [4, 5, 10, 22];
  const items = []; let pend = [];

  function buildItem(descLines, um, numStrs) {
    const dl = descLines.map(x => x.trim()).filter(x => x && !/^(data|serie\s*\/\s*numero|note|dati del|documento esterno|fornitore)$/i.test(x) && !/^\d{1,6}\s*\/\s*\d+$/.test(x) && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(x));
    let descr = dl.join(' ').replace(/\s{2,}/g, ' ').trim();
    const n = numStrs.map(toNum);
    if (n.length < 2 || descr.length < 3) return null;
    let ivaIdx = -1;
    if (isInt(n[n.length - 1]) && n[n.length - 1] <= 23) ivaIdx = n.length - 1;
    else if (n.length >= 2 && isInt(n[n.length - 2]) && n[n.length - 2] <= 23 && !isInt(n[n.length - 1])) ivaIdx = n.length - 2;
    if (ivaIdx < 0) { for (let i = n.length - 1; i >= Math.max(0, n.length - 3); i--) { if (i !== n.length - 1 && isInt(n[i]) && RATES.indexOf(n[i]) > -1) { ivaIdx = i; break; } } }
    const iva = ivaIdx >= 0 ? n[ivaIdx] : null;
    const core = n.filter((_, i) => i !== ivaIdx);
    if (!core.length) return null;
    const importo = core[core.length - 1];
    const qty = core[0];
    let price = core.length >= 2 ? core[1] : null;
    const sconti = core.length >= 4 ? [core[core.length - 2]] : [];
    if ((price == null || price === 0) && qty) price = Math.round((importo / qty) * 10000) / 10000;
    let type = 'product';
    if (/^conai\b|contributo ambient|^cont\.?\s*amb/i.test(descr)) type = 'conai';
    else if (/riga ausiliaria|informazioni tecniche/i.test(descr)) type = 'aux';
    let code = '';
    const cm = descr.match(/^([A-Za-z0-9][A-Za-z0-9.,_\/\-]{2,19})\s+(.+)/);
    if (cm) {
      const t = cm[1];
      // codice se: contiene una cifra (numerico/alfanumerico) OPPURE è testuale con punti/lineette/virgole in MAIUSCOLO
      const isCode = /\d/.test(t) || (/[.,\-\/]/.test(t) && !/[a-z]/.test(t));
      if (isCode && /[A-Za-z]/.test(cm[2])) { code = t; descr = cm[2]; }
    }
    if (!(qty > 0) || !(importo > 0)) return null;
    return { code, descr: descr.slice(0, 200), um: um || '', qty, price: price || 0, sconti, vat: iva, total: importo, type, include: type === 'product' };
  }

  for (const l of lines) {
    if (skip.test(l)) { pend = []; continue; }
    const toks = l.split(/\s+/);
    let k = toks.length, nums = [];
    while (k > 0 && isNumTok(toks[k - 1])) { nums.unshift(toks[k - 1]); k--; }
    const head = toks.slice(0, k);
    const valuesOnly = nums.length >= 3 && head.length <= 1 && (head.length === 0 || UM.test(head[0]));
    if (valuesOnly) {
      if (pend.length) { const it = buildItem(pend, head[0] || '', nums); if (it) items.push(it); }
      pend = []; continue;
    }
    if (nums.length >= 3 && head.length >= 1) {
      let um = ''; let h = head.slice();
      if (UM.test(h[h.length - 1])) { um = h[h.length - 1]; h = h.slice(0, -1); }
      const it = buildItem(pend.concat([h.join(' ')]), um, nums); if (it) items.push(it);
      pend = []; continue;
    }
    if (/[A-Za-z]/.test(l)) { pend.push(l); if (pend.length > 3) pend.shift(); }
  }

  const totals = {};
  const euros = [...joined.matchAll(/\u20ac\s*([\d.]+,\d{2})/g)].map(x => toNum(x[1]));
  if (euros.length >= 3) { totals.imponibile = euros[euros.length - 3]; totals.imposta = euros[euros.length - 2]; totals.totale = euros[euros.length - 1]; }
  else {
    m = joined.match(/imponibile[:\s]*([\d.]+,\d{2})/i); if (m) totals.imponibile = toNum(m[1]);
    m = joined.match(/totale(?:\s*fattura|\s*documento)?[:\s]*([\d.]+,\d{2})/i); if (m) totals.totale = toNum(m[1]);
  }

  return { supplier, numero, data, items, totals };
}

// Estrazione AI (opzionale). Richiede ANTHROPIC_API_KEY. Usa il PDF come documento.
async function aiParse(base64) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || typeof fetch !== 'function') return null;
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  const prompt = `Sei un estrattore di dati da fatture d'acquisto italiane. Analizza il PDF e restituisci SOLO un oggetto JSON (nessun testo prima o dopo, niente markdown) con questa struttura esatta:
{"supplier":{"name":"","piva":"","cf":"","pec":"","email":"","address":"","cap":"","city":"","prov":""},
"numero":"","data":"GG/MM/AAAA",
"items":[{"code":"","descr":"","um":"","qty":0,"price":0,"vat":22,"total":0}],
"totals":{"imponibile":0,"imposta":0,"totale":0}}
Regole: "supplier" è il CEDENTE/fornitore (l'intestazione), NON il destinatario. "price" è il prezzo unitario, "total" l'importo di riga, "vat" l'aliquota IVA in percentuale.
IMPORTANTISSIMO sui numeri: le fatture italiane usano la VIRGOLA come separatore decimale e il PUNTO come separatore delle migliaia. Esempi: "40,755" = 40.755 (quaranta e 755 millesimi, NON quarantamila); "1.234,56" = 1234.56; "0,14976" = 0.14976. Nel JSON riporta i numeri col punto decimale e SENZA separatore delle migliaia. Non arrotondare e non trasformare i decimali in interi.
Verifica di coerenza: per ogni riga deve risultare price × qty ≈ total; se non torna, hai letto male un numero, ricontrolla (quasi sempre è una virgola decimale interpretata come migliaia). Se un dato manca usa "" o 0.`;
  const body = {
    model, max_tokens: 4000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: prompt }
    ] }]
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('AI ' + res.status);
  const data = await res.json();
  let txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  txt = txt.replace(/```json|```/g, '').trim();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('AI: risposta non JSON');
  return JSON.parse(txt.slice(s, e + 1));
}

// Rileva il formato "fattura elettronica di cortesia" (PDF generato dall'XML FatturaPA)
function isCortesia(text) {
  return /cedente\/prestatore/i.test(text) || /\(CO\s?D\)/.test(text) || (/cessionario\/committente/i.test(text) && /prezzo totale/i.test(text));
}

// Parser dedicato al PDF di cortesia FatturaPA (codice su riga "(COD)", EAN, sconti multipli)
function parseCortesia(text) {
  const raw = String(text || '').split(/\r?\n/);
  const lines = raw.map(l => l.replace(/\t/g, ' ').replace(/\s{2,}/g, ' ').trim());
  const joined = lines.join('\n');
  const supplier = { name: '', piva: '', cf: '', pec: '', email: '', address: '', cap: '', city: '', prov: '' };

  // Blocco del CEDENTE/prestatore (il fornitore), non l'intermediario né il cessionario
  const ci = lines.findIndex(l => /^cedente\/prestatore/i.test(l));
  let endi = lines.findIndex((l, idx) => ci >= 0 && idx > ci && /(terzo intermediario|cessionario\/committente)/i.test(l));
  if (endi < 0) endi = (ci < 0 ? 0 : ci) + 12;
  const bjoin = (ci >= 0 ? lines.slice(ci, endi) : lines.slice(0, 12)).join('\n');
  let m;
  m = bjoin.match(/Denominazione:\s*(.+)/i); if (m) supplier.name = m[1].trim().slice(0, 80);
  m = bjoin.match(/ai fini IVA:\s*([A-Z]{2})?\s*([0-9]{11})/i); if (m) supplier.piva = m[2];
  m = bjoin.match(/Codice fiscale:\s*([A-Z0-9]{11,16})/i); if (m) supplier.cf = m[1].toUpperCase();
  m = bjoin.match(/Indirizzo:\s*(.+)/i); if (m) supplier.address = m[1].trim().slice(0, 60);
  m = bjoin.match(/Comune:\s*(.+?)\s+Provincia:\s*([A-Za-z]{2})/i); if (m) { supplier.city = m[1].trim(); supplier.prov = m[2].toUpperCase(); }
  m = bjoin.match(/Cap:\s*([0-9]{5})/i); if (m) supplier.cap = m[1];
  m = bjoin.match(/Email:\s*(\S+@\S+)/i); if (m) supplier.email = m[1];
  m = bjoin.match(/(\S+@(?:pec|legalmail|postecert)\S+)/i); if (m) supplier.pec = m[1];

  // Numero e data documento (riga tipologia TDxx)
  let numero = '', data = '';
  const tdLine = lines.find(l => /^TD\d{2}\b/i.test(l)) || '';
  m = tdLine.match(/([0-9]{5,})\s+([0-9]{2}-[0-9]{2}-[0-9]{4})/); if (m) { numero = m[1]; data = m[2].replace(/-/g, '/'); }
  if (!data) { const d = joined.match(/([0-9]{2}-[0-9]{2}-[0-9]{4})/); if (d) data = d[1].replace(/-/g, '/'); }

  // Articoli: ogni blocco inizia con una riga "codice (COD)"
  const UMt = /^(CT|PZ|KG|CF|LT|L|MT|ML|GR|NR|N|COLLI|SC|CAD|BOB|ROT|RIS|CONF)$/i;
  const codeIdx = [];
  lines.forEach((l, idx) => { if (/\(CO\s?D\)/i.test(l)) codeIdx.push(idx); });
  const endItems = lines.findIndex(l => /RIEPILOGHI IVA|riepiloghi iva e totali/i.test(l));
  const items = [];
  for (let c = 0; c < codeIdx.length; c++) {
    const start = codeIdx[c];
    const end = c + 1 < codeIdx.length ? codeIdx[c + 1] : (endItems > 0 ? endItems : lines.length);
    const codeM = lines[start].match(/^(\S+)\s*\(CO\s?D\)/);
    const code = codeM ? codeM[1] : '';
    let descrParts = [], qty = null, price = null, um = '', iva = null, total = null, discs = [];
    for (let j = start + 1; j < end; j++) {
      const l = lines[j]; if (!l) continue;
      if (/^\(EAN\)/i.test(l) || /^[0-9]{8,}$/.test(l)) continue;                 // codice EAN / barcode
      if (/^Tipo dato:/i.test(l) || /^Rif\.?\s*testo:/i.test(l)) continue;         // note (es. CONAI)
      if (/^[+-]?[0-9]+[.,][0-9]+\s*%$/.test(l)) { discs.push(toNum(l.replace('%', ''))); continue; } // sconto/magg. su riga a sé
      const toks = l.split(' ');
      let umIdx = -1; for (let k = 0; k < toks.length; k++) { if (UMt.test(toks[k])) { umIdx = k; break; } }
      if (umIdx >= 2 && /%/.test(l) && isNumTok(toks[umIdx - 1]) && isNumTok(toks[umIdx - 2])) {
        price = toNum(toks[umIdx - 1]); qty = toNum(toks[umIdx - 2]); um = toks[umIdx].toUpperCase();
        for (let k = umIdx + 1; k < toks.length; k++) { if (/^[+-]?[0-9]+[.,][0-9]+%$/.test(toks[k])) discs.push(toNum(toks[k].replace('%', ''))); } // sconto inline
        const dp = toks.slice(0, umIdx - 2).join(' ').trim(); if (dp) descrParts.push(dp);
        continue;
      }
      const fm = l.match(/^([0-9]{1,2},[0-9]{2})\s+([0-9.]+,[0-9]{2})$/);           // riga finale: IVA + Prezzo totale
      if (fm) { iva = toNum(fm[1]); total = toNum(fm[2]); continue; }
      descrParts.push(l);
    }
    const descr = descrParts.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (!(qty > 0) || !(total > 0) || descr.length < 2) continue;
    const sconti = discs.filter(d => d < 0).map(d => Math.round(Math.abs(d) * 100) / 100); // solo sconti reali (negativi), in serie
    items.push({ code, descr: descr.slice(0, 200), um, qty, price: price || Math.round((total / qty) * 10000) / 10000, sconti, vat: iva, total, type: 'product', include: true });
  }

  // Totali
  const totals = {};
  const eLine = lines.find(l => /esigibilit[\u00e0a] immediata|\bI \(/.test(l));
  if (eLine) { const nums = [...eLine.matchAll(/([0-9.]+,[0-9]{2})/g)].map(x => toNum(x[1])); if (nums.length >= 2) { totals.imposta = nums[nums.length - 1]; totals.imponibile = nums[nums.length - 2]; } }
  const tdi = lines.findIndex(l => /Totale documento/i.test(l));
  if (tdi >= 0) { for (let j = tdi; j < Math.min(lines.length, tdi + 2); j++) { const nums = [...lines[j].matchAll(/([0-9.]+,[0-9]{2})/g)].map(x => toNum(x[1])); if (nums.length) totals.totale = Math.max(...nums); } }

  return { supplier, numero, data, items, totals };
}

async function parseInvoice(buffer, base64) {
  // 1) prova AI se configurata
  if (process.env.ANTHROPIC_API_KEY) {
    try { const ai = await aiParse(base64); if (ai && ai.items) { ai.method = 'ai'; return normalize(ai); } } catch (e) { /* fallback */ }
  }
  // 2) parser sul testo (rileva il formato)
  const text = await extractText(buffer);
  let parsed;
  if (isCortesia(text)) { parsed = parseCortesia(text); parsed.method = 'fattura elettronica'; }
  else { parsed = heuristicParse(text); parsed.method = 'euristica'; }
  parsed.rawText = text.slice(0, 4000);
  return normalize(parsed);
}

function normalize(o) {
  const nn = v => typeof v === 'number' ? v : toNum(v); // non ri-converte numeri già puliti (es. decimali XML)
  o.supplier = Object.assign({ name: '', piva: '', cf: '', pec: '', email: '', address: '', cap: '', city: '', prov: '' }, o.supplier || {});
  o.items = (o.items || []).map(it => ({
    code: String(it.code || '').slice(0, 30), descr: String(it.descr || '').slice(0, 200),
    um: String(it.um || '').slice(0, 10), qty: nn(it.qty), price: nn(it.price),
    sconti: Array.isArray(it.sconti) ? it.sconti.filter(x => x != null && x !== '').map(x => nn(x)) : (it.sconto != null && it.sconto !== '' ? [nn(it.sconto)] : []),
    vat: it.vat == null || it.vat === '' ? null : nn(it.vat), total: nn(it.total),
    type: it.type || 'product', include: it.include != null ? !!it.include : (it.type || 'product') === 'product'
  })).filter(it => it.descr);
  // Controllo di coerenza: se la riga NON ha sconti, il prezzo unitario deve essere ≈ importo/quantità.
  // Recupera i casi in cui il prezzo è stato letto male (es. virgola persa: 40,755 → 40755).
  o.items.forEach(it => {
    const q = Number(it.qty) || 0, tot = Number(it.total) || 0;
    if (q > 0 && tot > 0 && (!it.sconti || !it.sconti.length)) {
      const atteso = tot / q;
      if (!(it.price > 0) || Math.abs(it.price * q - tot) > Math.max(tot * 0.02, 0.01)) {
        it.price = Math.round(atteso * 10000) / 10000;
      }
    }
  });
  o.totals = o.totals || {};
  return o;
}

/* ===== Fattura elettronica: XML FatturaPA e .p7m (CAdES) ===== */
const numEN = s => { const n = parseFloat(String(s == null ? '' : s).trim()); return isNaN(n) ? 0 : n; };
function xdec(s) { return String(s == null ? '' : s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim(); }
function xtag(xml, name) { const m = String(xml || '').match(new RegExp('<(?:[\\w.-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?' + name + '>', 'i')); return m ? xdec(m[1]) : ''; }
function xtagAll(xml, name) { const re = new RegExp('<(?:[\\w.-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?' + name + '>', 'ig'); const out = []; let m; while ((m = re.exec(String(xml || '')))) out.push(m[1]); return out; }

function parseFatturaXML(xml) {
  xml = String(xml || '');
  const supplier = { name: '', piva: '', cf: '', pec: '', email: '', address: '', cap: '', city: '', prov: '' };
  const header = xtag(xml, 'FatturaElettronicaHeader') || xml;
  const ced = xtag(header, 'CedentePrestatore');
  const anag = xtag(ced, 'DatiAnagrafici');
  const idiva = xtag(anag, 'IdFiscaleIVA');
  supplier.piva = xtag(idiva, 'IdCodice');
  supplier.cf = xtag(anag, 'CodiceFiscale');
  const an = xtag(anag, 'Anagrafica');
  supplier.name = xtag(an, 'Denominazione') || [xtag(an, 'Nome'), xtag(an, 'Cognome')].filter(Boolean).join(' ');
  const sede = xtag(ced, 'Sede');
  supplier.address = [xtag(sede, 'Indirizzo'), xtag(sede, 'NumeroCivico')].filter(Boolean).join(' ');
  supplier.cap = xtag(sede, 'CAP'); supplier.city = xtag(sede, 'Comune'); supplier.prov = xtag(sede, 'Provincia');
  const contatti = xtag(ced, 'Contatti'); if (contatti) { supplier.email = xtag(contatti, 'Email'); }

  const body = xtag(xml, 'FatturaElettronicaBody') || xml;
  const dgd = xtag(body, 'DatiGeneraliDocumento');
  const numero = xtag(dgd, 'Numero');
  let data = xtag(dgd, 'Data'); if (/^\d{4}-\d{2}-\d{2}/.test(data)) { const p = data.slice(0, 10).split('-'); data = p[2] + '/' + p[1] + '/' + p[0]; }
  const tipo = xtag(dgd, 'TipoDocumento') || 'TD01';

  const items = [];
  for (const l of xtagAll(body, 'DettaglioLinee')) {
    const descr = xtag(l, 'Descrizione');
    const qty = numEN(xtag(l, 'Quantita')) || 0;
    const um = xtag(l, 'UnitaMisura');
    const price = numEN(xtag(l, 'PrezzoUnitario'));
    const total = numEN(xtag(l, 'PrezzoTotale'));
    const vat = xtag(l, 'AliquotaIVA') !== '' ? numEN(xtag(l, 'AliquotaIVA')) : null;
    // codice: preferisci un CodiceArticolo non EAN
    let code = '';
    const arts = xtagAll(l, 'CodiceArticolo');
    for (const a of arts) { const t = (xtag(a, 'CodiceTipo') || '').toUpperCase(); const v = xtag(a, 'CodiceValore'); if (v && !/EAN|GTIN/.test(t)) { code = v; break; } }
    if (!code && arts.length) code = xtag(arts[0], 'CodiceValore');
    // sconti in serie (ScontoMaggiorazione con Tipo SC)
    const sconti = [];
    for (const sm of xtagAll(l, 'ScontoMaggiorazione')) {
      const t = (xtag(sm, 'Tipo') || 'SC').toUpperCase();
      const perc = xtag(sm, 'Percentuale');
      if (perc !== '') { const p = numEN(perc); if (t === 'SC') sconti.push(Math.round(p * 100) / 100); }
    }
    if (qty > 0 && (total !== 0 || price !== 0) && descr) items.push({ code, descr, um, qty, price, sconti, vat, total, type: 'product', include: true });
  }

  const totals = {};
  let imp = 0, imposta = 0;
  for (const r of xtagAll(body, 'DatiRiepilogo')) { imp += numEN(xtag(r, 'ImponibileImporto')); imposta += numEN(xtag(r, 'Imposta')); }
  if (imp) totals.imponibile = Math.round(imp * 100) / 100;
  if (imposta) totals.imposta = Math.round(imposta * 100) / 100;
  const totDoc = xtag(dgd, 'ImportoTotaleDocumento');
  totals.totale = totDoc ? numEN(totDoc) : Math.round((imp + imposta) * 100) / 100;

  return { supplier, numero, data, tipo, items, totals };
}

// Estrae l'XML della FatturaPA incapsulato in un file .p7m (CAdES, DER/Base64)
function extractXmlFromP7m(buffer) {
  let latin = buffer.toString('latin1');
  // se è base64 (CAdES in PEM o testo), prova a decodificare
  if (!/<(?:[\w.-]+:)?FatturaElettronica[\s>]/i.test(latin) && /^[A-Za-z0-9+/=\s-]+$/.test(latin.slice(0, 200))) {
    try { const b = Buffer.from(latin.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'); if (b.length > 100) latin = b.toString('latin1'); } catch (e) {}
  }
  let s = latin.search(/<\?xml/i);
  if (s < 0) s = latin.search(/<(?:[\w.-]+:)?FatturaElettronica[\s>]/i);
  if (s < 0) return null;
  const endRe = /<\/(?:[\w.-]+:)?FatturaElettronica\s*>/ig; let e = -1, m;
  while ((m = endRe.exec(latin))) e = m.index + m[0].length;
  if (e < 0) return null;
  return Buffer.from(latin.slice(s, e), 'latin1').toString('utf8');
}

// Punto d'ingresso unico: riconosce PDF, XML o .p7m
async function parseAny(buffer) {
  const head5 = buffer.slice(0, 5).toString('latin1');
  if (head5 === '%PDF-') return parseInvoice(buffer, buffer.toString('base64'));
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, 6000));
  if (/<\?xml/i.test(head) || /<(?:[\w.-]+:)?FatturaElettronica[\s>]/i.test(head)) {
    const r = parseFatturaXML(buffer.toString('utf8')); r.method = 'fattura elettronica (XML)'; return normalize(r);
  }
  const xml = extractXmlFromP7m(buffer);
  if (xml && /FatturaElettronica/i.test(xml)) { const r = parseFatturaXML(xml); r.method = 'fattura elettronica (XML)'; return normalize(r); }
  return parseInvoice(buffer, buffer.toString('base64'));
}

module.exports = { extractText, heuristicParse, parseCortesia, aiParse, parseInvoice, parseFatturaXML, extractXmlFromP7m, parseAny };
