'use strict';
const nodemailer = require('nodemailer');

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE,
  MAIL_FROM, MAIL_ADMIN
} = process.env;

let transporter = null;
let ready = false;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE || 'false') === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  ready = true;
  console.log('[mail] SMTP configurato:', SMTP_HOST);
} else {
  console.log('[mail] SMTP non configurato — le email vengono solo registrate in console (modalità sviluppo).');
}

const FROM  = MAIL_FROM  || 'ZETAPACK Srl <no-reply@zetapack.local>';
const ADMIN = MAIL_ADMIN || SMTP_USER || 'amministrazione@zetapack.local';

/** Invia una email; in assenza di SMTP la registra soltanto in console. */
async function sendMail({ to, cc, bcc, replyTo, subject, text, html, attachments }) {
  if (!ready) {
    console.log('\n[mail:dev] ─────────────────────────────');
    console.log('  A:', to, cc ? ('| CC: ' + cc) : '', bcc ? ('| BCC: ' + bcc) : '');
    console.log('  Oggetto:', subject);
    if (text) console.log('  Testo:', text.replace(/\n/g, '\n         '));
    if (attachments && attachments.length) console.log('  Allegati:', attachments.map(a => a.filename).join(', '));
    console.log('────────────────────────────────────────\n');
    return { dev: true };
  }
  return transporter.sendMail({ from: FROM, to, cc, bcc, replyTo, subject, text, html, attachments });
}

/* Notifica: nuovo ordine ricevuto */
async function notifyNewOrder(order, clientEmail) {
  const lines = order.items.map(i => `  • ${i.qty} × ${i.descr} (${i.code}) — € ${(i.qty * i.price).toFixed(2)}`).join('\n');
  const body =
`Nuova richiesta d'ordine ${order.id}
Cliente: ${order.client_name} (${order.client_id})
Data: ${new Date(order.created_at).toLocaleString('it-IT')}

Articoli:
${lines}

Totale indicativo: € ${order.total.toFixed(2)}
${order.note ? '\nNota cliente: ' + order.note : ''}`;

  await sendMail({ to: ADMIN, subject: `Nuovo ordine ${order.id} — ${order.client_name}`, text: body });

  if (clientEmail) {
    await sendMail({
      to: clientEmail,
      subject: `Abbiamo ricevuto la tua richiesta ${order.id} — ZETAPACK`,
      text: `Gentile cliente,\nabbiamo ricevuto la tua richiesta d'ordine ${order.id} per un totale indicativo di € ${order.total.toFixed(2)}.\nLa confermeremo al più presto con disponibilità e prezzi definitivi.\n\nGrazie,\nZETAPACK Srl`
    });
  }
}

/* Notifica: nuova richiesta di accesso / listino */
async function notifyNewRequest(r) {
  const body =
`Nuova richiesta dal sito (${r.type})
Azienda: ${r.company}
Referente: ${r.name}
P.IVA: ${r.vat || '—'}
Email: ${r.email}
Telefono: ${r.phone || '—'}
Messaggio: ${r.msg || '—'}`;
  await sendMail({ to: ADMIN, subject: `Richiesta ${r.type} — ${r.company}`, text: body });
}

module.exports = { sendMail, notifyNewOrder, notifyNewRequest, mailReady: () => ready };
