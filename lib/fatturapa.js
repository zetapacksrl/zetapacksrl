'use strict';
/**
 * Generatore XML FatturaPA (fattura ordinaria B2B/B2C — FormatoTrasmissione FPR12).
 * Schema v1.2 — namespace http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2
 * NB: l'XML va poi FIRMATO digitalmente (CAdES .p7m o XAdES) e trasmesso allo SdI.
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function dec(n, d = 2) { return (Math.round((Number(n) || 0) * 1e8) / 1e8).toFixed(d); }
function ymd(ts) { const dt = new Date(ts || Date.now()); return dt.toISOString().slice(0, 10); }

// ProgressivoInvio alfanumerico (base36 maiuscolo, min 1 car., max 10)
function progAlpha(n) {
  let s = (Number(n) || 1).toString(36).toUpperCase();
  return s.slice(0, 10);
}
// Nome file richiesto dallo SdI: IT<idfiscale>_<progressivo>.xml
function xmlFileName(idPaese, idCodice, prog) {
  return `${(idPaese || 'IT')}${String(idCodice || '').replace(/\s/g, '')}_${progAlpha(prog)}.xml`;
}

// Blocco <Sede> / indirizzo
function sede(o) {
  let x = '';
  x += `<Indirizzo>${esc((o.address || '').slice(0, 60) || '-')}</Indirizzo>`;
  if (o.civico) x += `<NumeroCivico>${esc(o.civico)}</NumeroCivico>`;
  x += `<CAP>${esc((o.cap || '00000').replace(/\D/g, '').padStart(5, '0').slice(0, 5))}</CAP>`;
  x += `<Comune>${esc((o.city || o.comune || '-').slice(0, 60))}</Comune>`;
  if (o.prov) x += `<Provincia>${esc(String(o.prov).toUpperCase().slice(0, 2))}</Provincia>`;
  x += `<Nazione>${esc((o.nazione || 'IT').toUpperCase().slice(0, 2))}</Nazione>`;
  return `<Sede>${x}</Sede>`;
}

/**
 * @param {object} company  dati del cedente/prestatore (ZETAPACK)
 * @param {object} client   dati del cessionario/committente
 * @param {object} inv      { numero, data(ts), tipo='TD01', progressivo, note, condPag='TP02', modPag='MP05' }
 * @param {array}  items    [{ descr, qty, um, price, aliquota, natura }]
 */
function buildFatturaXML(company, client, inv, items) {
  company = company || {}; client = client || {}; inv = inv || {}; items = items || [];
  const idPaese = (company.idPaese || 'IT').toUpperCase();
  const piva = String(company.piva || '').replace(/\s/g, '');
  const versione = client.pa ? 'FPA12' : 'FPR12';

  // Destinatario: codice SdI 7 char, altrimenti 0000000 (+ PEC se presente)
  let sdi = String(client.sdi || '').trim().toUpperCase();
  if (client.pa) { sdi = (sdi || '000000').replace(/[^A-Z0-9]/g, '').padStart(6, '0').slice(0, 6); }
  else if (sdi && /^[A-Z0-9]{7}$/.test(sdi)) { /* ok */ }
  else sdi = '0000000';
  const pec = (!client.pa && sdi === '0000000') ? String(client.pec || '').trim() : '';

  // Righe + riepilogo IVA per aliquota
  const aliqDef = inv.aliquota != null ? Number(inv.aliquota) : 22;
  let righe = '', riep = {};
  items.forEach((it, i) => {
    const q = Number(it.qty) || 0, pu = Number(it.price) || 0;
    const tot = Math.round(q * pu * 100) / 100;
    const al = it.aliquota != null ? Number(it.aliquota) : aliqDef;
    const nat = it.natura || (al === 0 ? (it.natura || 'N2.2') : '');
    righe += '<DettaglioLinee>' +
      `<NumeroLinea>${i + 1}</NumeroLinea>` +
      `<Descrizione>${esc((it.descr || 'Prodotto').slice(0, 1000))}</Descrizione>` +
      `<Quantita>${dec(q, 2)}</Quantita>` +
      (it.um ? `<UnitaMisura>${esc(String(it.um).slice(0, 10))}</UnitaMisura>` : '') +
      `<PrezzoUnitario>${dec(pu, 2)}</PrezzoUnitario>` +
      `<PrezzoTotale>${dec(tot, 2)}</PrezzoTotale>` +
      `<AliquotaIVA>${dec(al, 2)}</AliquotaIVA>` +
      (nat ? `<Natura>${esc(nat)}</Natura>` : '') +
      '</DettaglioLinee>';
    const key = dec(al, 2) + '|' + (nat || '');
    riep[key] = riep[key] || { al, nat, imp: 0 };
    riep[key].imp += tot;
  });

  let riepXml = '', totDoc = 0;
  Object.values(riep).forEach(r => {
    const imp = Math.round(r.imp * 100) / 100;
    const imposta = Math.round(imp * r.al) / 100;
    totDoc += imp + imposta;
    riepXml += '<DatiRiepilogo>' +
      `<AliquotaIVA>${dec(r.al, 2)}</AliquotaIVA>` +
      (r.nat ? `<Natura>${esc(r.nat)}</Natura>` : '') +
      `<ImponibileImporto>${dec(imp, 2)}</ImponibileImporto>` +
      `<Imposta>${dec(imposta, 2)}</Imposta>` +
      `<EsigibilitaIVA>${esc(inv.esigibilita || 'I')}</EsigibilitaIVA>` +
      '</DatiRiepilogo>';
  });
  totDoc = Math.round(totDoc * 100) / 100;

  // Anagrafica cessionario: IVA e/o Codice Fiscale
  let cessAnag = '';
  const cvat = String(client.vat || '').replace(/\s/g, '');
  if (cvat) cessAnag += `<IdFiscaleIVA><IdPaese>${esc((client.nazione || 'IT').toUpperCase())}</IdPaese><IdCodice>${esc(cvat)}</IdCodice></IdFiscaleIVA>`;
  if (client.cf) cessAnag += `<CodiceFiscale>${esc(String(client.cf).toUpperCase().slice(0, 16))}</CodiceFiscale>`;
  cessAnag += `<Anagrafica><Denominazione>${esc((client.name || 'Cliente').slice(0, 80))}</Denominazione></Anagrafica>`;

  const header =
    '<FatturaElettronicaHeader>' +
      '<DatiTrasmissione>' +
        `<IdTrasmittente><IdPaese>${esc(idPaese)}</IdPaese><IdCodice>${esc(piva)}</IdCodice></IdTrasmittente>` +
        `<ProgressivoInvio>${esc(progAlpha(inv.progressivo))}</ProgressivoInvio>` +
        `<FormatoTrasmissione>${versione}</FormatoTrasmissione>` +
        `<CodiceDestinatario>${esc(sdi)}</CodiceDestinatario>` +
        (company.tel || company.email ? '<ContattiTrasmittente>' + (company.tel ? `<Telefono>${esc(company.tel)}</Telefono>` : '') + (company.email ? `<Email>${esc(company.email)}</Email>` : '') + '</ContattiTrasmittente>' : '') +
        (pec ? `<PECDestinatario>${esc(pec)}</PECDestinatario>` : '') +
      '</DatiTrasmissione>' +
      '<CedentePrestatore>' +
        '<DatiAnagrafici>' +
          `<IdFiscaleIVA><IdPaese>${esc(idPaese)}</IdPaese><IdCodice>${esc(piva)}</IdCodice></IdFiscaleIVA>` +
          (company.cf ? `<CodiceFiscale>${esc(company.cf)}</CodiceFiscale>` : '') +
          `<Anagrafica><Denominazione>${esc((company.name || 'ZETAPACK Srl').slice(0, 80))}</Denominazione></Anagrafica>` +
          `<RegimeFiscale>${esc(company.regime || 'RF01')}</RegimeFiscale>` +
        '</DatiAnagrafici>' +
        sede(company) +
      '</CedentePrestatore>' +
      '<CessionarioCommittente>' +
        `<DatiAnagrafici>${cessAnag}</DatiAnagrafici>` +
        sede(client) +
      '</CessionarioCommittente>' +
    '</FatturaElettronicaHeader>';

  const body =
    '<FatturaElettronicaBody>' +
      '<DatiGenerali>' +
        '<DatiGeneraliDocumento>' +
          `<TipoDocumento>${esc(inv.tipo || 'TD01')}</TipoDocumento>` +
          '<Divisa>EUR</Divisa>' +
          `<Data>${ymd(inv.data)}</Data>` +
          `<Numero>${esc(String(inv.numero || '1').slice(0, 20))}</Numero>` +
          (inv.note ? `<Causale>${esc(String(inv.note).slice(0, 200))}</Causale>` : '') +
        '</DatiGeneraliDocumento>' +
        (inv.order_id ? `<DatiOrdineAcquisto><IdDocumento>${esc(String(inv.order_id).slice(0, 20))}</IdDocumento></DatiOrdineAcquisto>` : '') +
      '</DatiGenerali>' +
      '<DatiBeniServizi>' + righe + riepXml + '</DatiBeniServizi>' +
      '<DatiPagamento>' +
        `<CondizioniPagamento>${esc(inv.condPag || 'TP02')}</CondizioniPagamento>` +
        '<DettaglioPagamento>' +
          `<ModalitaPagamento>${esc(inv.modPag || 'MP05')}</ModalitaPagamento>` +
          `<ImportoPagamento>${dec(totDoc, 2)}</ImportoPagamento>` +
          (company.iban ? `<IBAN>${esc(String(company.iban).replace(/\s/g, ''))}</IBAN>` : '') +
        '</DettaglioPagamento>' +
      '</DatiPagamento>' +
    '</FatturaElettronicaBody>';

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<p:FatturaElettronica versione="${versione}" ` +
    'xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" ' +
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2 http://www.fatturapa.gov.it/export/fatturazione/sdi/fatturapa/v1.2/Schema_del_file_xml_FatturaPA_versione_1.2.2.xsd">\n' +
    header + body +
    '\n</p:FatturaElettronica>\n';

  return { xml, fileName: xmlFileName(idPaese, piva, inv.progressivo), totale: totDoc };
}

module.exports = { buildFatturaXML, xmlFileName, progAlpha };
