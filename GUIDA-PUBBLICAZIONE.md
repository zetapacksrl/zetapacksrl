# Guida alla pubblicazione online — Portale ZETAPACK

Questa guida ti porta dal progetto sul tuo computer al **sito online sul tuo dominio**, con
**HTTPS automatico** e senza dover gestire un server. Il dominio resta su **Aruba**; l'applicazione
gira su **Render**.

**Cosa ti serve (tutto gratis da creare):**
1. Un account **GitHub** (dove appoggiamo il codice) → https://github.com
2. Un account **Render** (dove gira l'app) → https://render.com
3. I dati della tua **casella email** Aruba (indirizzo e password) per le notifiche
4. L'accesso al **pannello Aruba** del dominio (per due record DNS)

**Costo a regime:** circa **7 $/mese** (piano Render "Starter", sempre attivo) + pochi centesimi
per il disco dei dati. Il dominio e l'email li paghi già ad Aruba come adesso.

> Tempo richiesto: circa 30–40 minuti la prima volta.

---

## PARTE 1 — Mettere il codice su GitHub

1. Vai su https://github.com e crea un account (o accedi).
2. In alto a destra clicca **+** → **New repository**.
3. **Repository name:** `zetapack-portale`. Lascia **Private** selezionato. Clicca **Create repository**.
4. Nella pagina che appare, clicca il link **"uploading an existing file"**.
5. Apri la cartella del progetto sul tuo computer, **seleziona tutti i file e le cartelle**
   (server.js, db.js, package.json, render.yaml, le cartelle public, lib, assets, data, ecc.)
   e **trascinali** nella pagina di GitHub.
   > NON caricare la cartella `node_modules` (non è presente nello zip: bene così, si ricrea da sola).
6. In basso clicca **Commit changes**. Il codice è ora su GitHub.

---

## PARTE 2 — Creare il servizio su Render

1. Vai su https://render.com e registrati (puoi usare **"Sign up with GitHub"**: è il più comodo).
2. Nella dashboard clicca **New +** → **Blueprint**.
3. Render ti chiede di collegare GitHub: autorizzalo e **seleziona il repository `zetapack-portale`**.
4. Render legge il file `render.yaml` e propone il servizio già configurato (con il disco dei dati).
   Clicca **Apply** / **Create**.
5. Ti verrà chiesto di inserire i **valori riservati** (quelli che non stanno nel codice).
   Inseriscili così:

   | Variabile | Cosa mettere |
   |---|---|
   | `ADMIN_PASS` | La password che vuoi per l'accesso azienda (scegline una robusta) |
   | `SMTP_USER` | Il tuo indirizzo email Aruba completo, es. `ordini@tuodominio.it` |
   | `SMTP_PASS` | La password di quella casella email |
   | `MAIL_FROM` | `ZETAPACK Srl <ordini@tuodominio.it>` |
   | `MAIL_ADMIN` | L'indirizzo dove vuoi ricevere gli avvisi degli ordini |

   > I parametri del server email (host `smtps.aruba.it`, porta `465`, SSL) sono **già impostati**
   > nel file di configurazione: non devi toccarli.

6. Conferma. Render scarica il codice, installa tutto e avvia l'app (ci vuole qualche minuto).
7. Quando lo stato diventa **Live**, in alto trovi l'indirizzo provvisorio del sito, del tipo
   **https://zetapack-portale.onrender.com** — aprilo: il portale è online. 🎉

**Primo controllo:** accedi come azienda con utente `admin` e la password che hai messo in `ADMIN_PASS`.
Prova a creare un ordine di test dall'area cliente (`cliente` / `cliente123`) e verifica che arrivi
l'email di notifica all'indirizzo `MAIL_ADMIN`.

---

## PARTE 3 — Collegare il tuo dominio Aruba

### 3a. Aggiungi il dominio su Render
1. Nella dashboard Render apri il servizio **zetapack-portale** → **Settings** → **Custom Domains**.
2. Clicca **+ Add Custom Domain** e inserisci **`www.tuodominio.it`** → Save.
3. Aggiungi anche il dominio senza www: **`tuodominio.it`** → Save.
   (Render imposta in automatico il reindirizzamento tra i due.)
4. Render mostra ora i **record DNS da creare**. Tienili sott'occhio: di norma sono
   - per `tuodominio.it` → un record **A** verso l'IP **`216.24.57.1`**
   - per `www.tuodominio.it` → un record **CNAME** verso **`zetapack-portale.onrender.com`**
   (usa esattamente i valori che vedi nella tua schermata Render).

### 3b. Imposta i record nel pannello Aruba
1. Entra nel pannello Aruba → area del **dominio** → **Gestione DNS / Record DNS**.
2. **Record A** — modifica (o crea) il record del dominio principale:
   - Tipo: **A** · Host/Nome: **@** (il dominio nudo) · Valore/IP: **`216.24.57.1`**
3. **Record CNAME** — per il www:
   - Tipo: **CNAME** · Host/Nome: **www** · Valore: **`zetapack-portale.onrender.com`**
4. **Rimuovi eventuali record AAAA** (quelli IPv6) del dominio: Render usa solo IPv4 e possono dare problemi.
5. Salva.

> ⚠️ **Non toccare i record MX**: sono quelli dell'email. Cambiamo solo A e CNAME (il sito web),
> quindi la tua posta Aruba continua a funzionare esattamente come prima.

### 3c. Attendi e verifica
- I cambiamenti DNS possono richiedere da pochi minuti a qualche ora per propagarsi.
- Torna su Render → **Custom Domains** e clicca **Verify**. Quando risulta verificato, Render emette
  in automatico il **certificato HTTPS** (lucchetto). Da quel momento il sito risponde su
  `https://www.tuodominio.it`.

> Se il pannello Aruba non ti lascia modificare il record A del dominio principale (a volte è
> bloccato quando il dominio punta all'hosting Aruba), cerca l'opzione per gestire i **DNS personalizzati**
> del dominio, oppure contatta l'assistenza Aruba chiedendo di impostare "un record A del dominio verso
> un IP esterno e un CNAME per www": è un'operazione standard.

---

## PARTE 4 — Note sull'email
- Aruba richiede l'autenticazione con **indirizzo completo e password** della casella (già previsto).
- Usa come mittente (`MAIL_FROM`) **la stessa casella** che hai messo in `SMTP_USER`: eviti blocchi.
- Aruba pone un **limite al numero di email** inviabili: per le notifiche degli ordini (poche al giorno)
  è più che sufficiente. Non usare questa casella per invii massivi/newsletter.

---

## PARTE 5 — Aggiornamenti futuri e backup

**Quando aggiungiamo una nuova funzione:** ti darò i file aggiornati. Ti basterà caricarli su GitHub
(stesso metodo della Parte 1, "Add file → Upload files") e **Render ripubblica da solo** la nuova
versione. I dati nel database **restano** (sono sul disco persistente).

**Backup dei dati:** oltre al disco persistente, come sicurezza in più puoi ogni tanto usare il
pulsante **Esporta CSV** nella sezione Ordini: così tieni una copia degli ordini sul tuo computer.

---

## Promemoria di sicurezza
- La password admin è quella che hai messo in `ADMIN_PASS`: scegline una robusta e non condividerla.
- Il "segreto" delle sessioni (`JWT_SECRET`) viene generato da Render in automatico: non devi fare nulla.
- Le password dei clienti sono salvate cifrate.

---

## Riepilogo veloce (checklist)
- [ ] Codice caricato su GitHub
- [ ] Servizio creato su Render da `render.yaml` (piano Starter)
- [ ] Variabili inserite (ADMIN_PASS, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_ADMIN)
- [ ] Sito raggiungibile sull'indirizzo `.onrender.com`
- [ ] Dominio aggiunto su Render (www + dominio nudo)
- [ ] Record DNS su Aruba: A `@` → 216.24.57.1 · CNAME `www` → …onrender.com · AAAA rimossi
- [ ] Dominio verificato e HTTPS attivo
- [ ] Email di prova ricevuta correttamente

Se un passaggio non torna, scrivimi **a che punto sei bloccato** e ti guido nel dettaglio.
