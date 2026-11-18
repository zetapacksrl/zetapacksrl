# ZETAPACK — Immagini prodotti e categorie (assegnazione automatica)

Il portale assegna le foto ai prodotti **in automatico**, con questa priorità:

1. Foto caricata a mano dal pannello prodotto (se presente) — ha la precedenza.
2. `/assets/products/<codice-prodotto>.png`
3. `/assets/products/<codice-fornitore>.png` (se il prodotto ha un codice fornitore)
4. **Immagine della categoria** in `/assets/categories/<categoria>.png` (fallback finale)

Così ogni prodotto ha SEMPRE almeno l'immagine della sua categoria; quando carichi la foto
specifica (con nome = codice) quella sostituisce automaticamente il fallback.

---

## 1) Foto dei singoli prodotti  →  cartella `assets/products/`

Nomina ogni file **esattamente come il codice del prodotto**, con estensione `.png`.
Esempi (dal tuo catalogo):

| Codice prodotto | Nome file da usare |
|---|---|
| `acca45+25k` | `acca45+25k.png` |
| `assmeat1013` | `assmeat1013.png` |
| `assmeat1715` | `assmeat1715.png` |
| `b1t` | `b1t.png` |
| `Barc17` | `Barc17.png` |
| `bic100cart` | `bic100cart.png` |

In alternativa puoi nominare la foto con il **codice fornitore** (dove presente).

---

## 2) Immagini delle categorie  →  cartella `assets/categories/`

Servono **13 immagini**, una per categoria. Usa ESATTAMENTE questi nomi file:

| Categoria | Prodotti | Nome file (obbligatorio) |
|---|---|---|
| Monouso in carta | 175 | `monouso-in-carta.png` |
| Monouso in plastica | 126 | `monouso-in-plastica.png` |
| Altro | 122 | `altro.png` |
| Imballaggi in plastica | 81 | `imballaggi-in-plastica.png` |
| Imballaggi in carta | 72 | `imballaggi-in-carta.png` |
| Pulizia e igiene | 70 | `pulizia-e-igiene.png` |
| Imballaggi bio | 34 | `imballaggi-bio.png` |
| arredo tavola | 33 | `arredo-tavola.png` |
| Monouso in alluminio | 22 | `monouso-in-alluminio.png` |
| Monouso Bio | 21 | `monouso-bio.png` |
| Monouso in legno | 18 | `monouso-in-legno.png` |
| Cancelleria | 12 | `cancelleria.png` |
| Estetica e linee cortesia | 6 | `estetica-e-linee-cortesia.png` |

> I nomi sono in minuscolo, senza accenti, con i trattini al posto degli spazi. Rispettali
> alla lettera, altrimenti il fallback non trova l'immagine.

---

## Formato consigliato

- **PNG** (come da tua richiesta), quadrato o 4:3, lato ~800–1000 px.
- Sfondo bianco o trasparente per un look pulito nel catalogo.
- Peso contenuto (<300 KB) per pagine veloci.

## Dove finiscono i file online

Le due cartelle sono servite dal sito all'indirizzo `/assets/products/` e `/assets/categories/`.
Basta caricarle nel progetto (o via GitHub) insieme al resto del sito.