# Immagini prodotto su Cloudflare R2

Le immagini dei prodotti **non** vengono salvate su Render, ma su **Cloudflare R2**
(storage esterno con CDN, gratuito fino a 10 GB e senza costi di traffico).
Il portale carica la foto su R2 e salva nel prodotto solo il **link pubblico**:
il catalogo mostra l'immagine caricandola direttamente da R2, quindi Render resta leggero.

## 1. Crea l'account e il bucket
1. Vai su https://dash.cloudflare.com e accedi (o registrati gratis).
2. Nel menu a sinistra apri **R2**. Se richiesto, attiva R2 (serve una carta per
   verifica, ma il piano gratuito non addebita nulla entro i limiti).
3. Clicca **Create bucket**, dai un nome (es. `zetapack-immagini`) e crea.

## 2. Rendi pubbliche le immagini
1. Apri il bucket → scheda **Settings**.
2. Alla voce **Public access / R2.dev subdomain**, clicca **Allow Access** per
   ottenere un indirizzo pubblico tipo `https://pub-xxxxxxxx.r2.dev`.
   (In alternativa puoi collegare un tuo sottodominio, es. `immagini.zetapacksrl.it`.)
3. Copia questo indirizzo: è il valore di **R2_PUBLIC_URL**.

## 3. Crea il token di accesso (API)
1. Nella pagina R2, apri **Manage R2 API Tokens** → **Create API Token**.
2. Permessi: **Object Read & Write**, limitato al bucket creato.
3. Crea e copia i tre valori mostrati una sola volta:
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
   - l'**Account ID** (lo trovi nella pagina R2 in alto) → `R2_ACCOUNT_ID`

## 4. Imposta le variabili su Render
Nel servizio su Render → **Environment**, aggiungi:

| Variabile | Valore |
|---|---|
| `R2_ACCOUNT_ID` | l'Account ID Cloudflare |
| `R2_ACCESS_KEY_ID` | Access Key ID del token |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key del token |
| `R2_BUCKET` | il nome del bucket (es. `zetapack-immagini`) |
| `R2_PUBLIC_URL` | l'indirizzo pubblico (es. `https://pub-xxxx.r2.dev`) |

Salva: Render riavvia il servizio da solo.

## 5. Usa la funzione
Nel portale, area azienda → **Listino** → **Scheda** di un prodotto (o
**+ Nuovo prodotto**): trovi **Carica immagine**. Scegli la foto: viene
ridimensionata e compressa nel browser, poi caricata su R2. Il prodotto mostra
l'anteprima e l'immagine appare nel catalogo (lato pubblico e clienti).

Note:
- Se le variabili R2 non sono impostate, il pulsante mostra un avviso e il
  caricamento non parte (il resto del portale funziona comunque).
- Ricordati di eseguire `npm install` sul server dopo l'aggiornamento
  (serve la libreria `@aws-sdk/client-s3`, già inclusa nel package.json).
- Nella demo offline il caricamento è simulato (l'immagine resta nel browser).
