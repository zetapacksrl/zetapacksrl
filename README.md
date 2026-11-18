# ZETAPACK Srl — Portale Ordini & Preventivi (backend definitivo)

Applicazione full-stack: **frontend** (sito pubblico + area clienti + area azienda) e **backend**
(Node.js + database **SQLite**) con **autenticazione sicura**, **notifiche email** ed **export PDF**.

I dati sono condivisi e persistenti su database: più clienti e l'azienda lavorano sugli stessi dati.

---

## 1. Requisiti
- **Node.js 18+** (include npm). Download: https://nodejs.org

## 2. Installazione
Apri il terminale nella cartella del progetto ed esegui:

```bash
npm install
cp .env.example .env      # su Windows:  copy .env.example .env
npm start
```

Poi apri il browser su **http://localhost:3000**

Alla prima esecuzione il database viene creato e popolato automaticamente con i 792 prodotti
del listino e con gli account demo.

## 3. Accessi demo
- **Azienda (admin):** utente `admin` · password `admin123`
- **Cliente:** utente `cliente` · password `cliente123`

Le credenziali admin si cambiano nel file `.env` (`ADMIN_USER`, `ADMIN_PASS`).
> ⚠️ In produzione cambia `ADMIN_PASS` e imposta un `JWT_SECRET` lungo e casuale.

## 4. Email (notifiche)
Le notifiche partono in automatico per ogni **nuovo ordine** (all'azienda + conferma al cliente)
e per ogni **richiesta di accesso** dal sito.

- Senza configurazione SMTP le email vengono **stampate nella console** del server (utile in prova).
- Per inviarle davvero, compila nel file `.env` i parametri SMTP del tuo provider:

```
SMTP_HOST=smtp.tuoprovider.it
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=ordini@tuodominio.it
SMTP_PASS=la-tua-password
MAIL_FROM=ZETAPACK Srl <ordini@tuodominio.it>
MAIL_ADMIN=amministrazione@tuodominio.it
```

L'email del cliente (per la conferma) si imposta nella scheda cliente, nel pannello azienda.

## 5. Export PDF
Ogni ordine ha un pulsante **PDF**: genera un documento con logo, dati cliente, articoli e totale,
sia lato cliente (i propri ordini) sia lato azienda (tutti gli ordini).

---

## Struttura del progetto
```
zetapack-backend/
├── server.js          API REST, autenticazione, rotte
├── db.js              database SQLite, schema, seed
├── lib/mailer.js      notifiche email (nodemailer)
├── lib/pdf.js         generazione PDF (pdfkit)
├── data/products.json listino iniziale (seed)
├── assets/logo.png    logo aziendale
├── public/index.html  frontend completo
├── .env.example       configurazione da copiare in .env
└── package.json
```

## Principali API
| Metodo | Endpoint | Ruolo | Descrizione |
|---|---|---|---|
| POST | `/api/login` | tutti | Login, restituisce token JWT |
| GET  | `/api/catalog` | pubblico | Catalogo **senza** prezzi |
| GET  | `/api/catalog/prices` | cliente | Catalogo **con** prezzi |
| POST | `/api/requests` | pubblico | Richiesta accesso (→ email) |
| POST | `/api/orders` | cliente | Nuova richiesta d'ordine (→ email) |
| GET  | `/api/orders/mine` | cliente | Storico ordini |
| GET  | `/api/orders/:id/pdf` | cliente/admin | PDF ordine |
| GET  | `/api/admin/orders/:id/quote.pdf` | admin | PDF preventivo |
| GET/PATCH | `/api/admin/orders` | admin | Ordini e stati |
| GET  | `/api/admin/orders.csv` | admin | Export CSV |
| CRUD | `/api/admin/products` | admin | Gestione listino |
| POST | `/api/admin/products/import` | admin | Import massivo |
| CRUD | `/api/admin/clients` | admin | Gestione account clienti |
| GET/PATCH | `/api/admin/requests` | admin | Richieste dal sito |

## Note tecniche
- Password salvate con **hash bcrypt**; sessioni con **token JWT** (scadenza 12h).
- I prezzi degli ordini sono **ricalcolati dal server** dal listino (non ci si fida del client).
- Database in un unico file `data/zetapack.db` — facile da salvare/backuppare.

## Messa online (hosting)
Il progetto è un normale server Node.js: puoi pubblicarlo su un VPS o su piattaforme come
Render, Railway o Fly.io. Imposta le variabili d'ambiente del file `.env` nel pannello dell'hosting
e avvia con `npm start`. Per il database condiviso su più server si può in seguito passare a
PostgreSQL/MySQL mantenendo la stessa struttura.
