# llm-cassette

[![CI](https://github.com/tonyweckstrom1987/llm-cassette/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyweckstrom1987/llm-cassette/actions/workflows/ci.yml) ![Lisenssi: MIT](https://img.shields.io/badge/lisenssi-MIT-blue.svg)

Tallenna LLM-kutsujen vastaukset kerran ja toista ne testeissä. Testit ovat silloin nopeita, ilmaisia ja vakaita CI:ssä, eikä niihin tarvita API-avainta.

**English summary:** Record/replay for `fetch`-based LLM clients (VCR-style). It wraps `fetch`, stores responses in a JSON file, and replays them in tests, so tests are fast, free and deterministic. Default mode is `replay`, which never touches the network. Request headers (e.g. `Authorization`) are never stored. Zero runtime dependencies, Node 22/24, TypeScript.

**Teknologiat:** TypeScript, Node.js 22/24, vitest. Ei ajonaikaisia riippuvuuksia.

## Asennus

```bash
npm install --save-dev @tonyweckstrom/llm-cassette
```

Node 22.12+ tai 24. Ei ajonaikaisia riippuvuuksia. (Nimi on scopattu, koska `llm-cassette` on jo toisen julkaisemana npm:ssä: se on eri työkalu.)

## Käyttö

```ts
import { cassetteFetch } from "@tonyweckstrom/llm-cassette";

const fetchWithCassette = cassetteFetch({ path: "test/cassettes/yleinen.json" });

// Anna tämä LLM-asiakkaallesi fetch-funktioksi:
const res = await fetchWithCassette("https://litellm.local/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.LLM_API_KEY}` },
  body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hei" }] }),
});
```

Ensimmäinen ajo tallentaa vastaukset, seuraavat toistavat ne:

```bash
LLM_CASSETTE_MODE=record npm test   # kerran, oikealla avaimella: tallentaa cassetteen
npm test                            # normaalisti: toistaa, ei verkkoa
```

Commitoi cassette-tiedostot repoon. Silloin CI toistaa samat vastaukset ilman kuluja.

## Tilat

| Tila | Mitä tekee |
| --- | --- |
| `replay` (oletus) | Toistaa tallenteen. Jos tallennetta ei ole, heittää `CassetteMissError`. Ei koskaan verkkoa. |
| `record` | Kutsuu oikeaa `fetch`-funktiota ja tallentaa vastauksen. Korvaa saman pyynnön vanhat tallenteet ja säilyttää muut. |
| `auto` | Toistaa jos tallenne löytyy, muuten kutsuu oikeaa `fetch`-funktiota ja tallentaa. Kätevä kehittäessä; CI:ssä käytä `replay`-tilaa. |

Tila valitaan `mode`-asetuksella tai ympäristömuuttujalla `LLM_CASSETTE_MODE`. Ilman niitä tila on `replay`, jotta unohtunut asetus ei koskaan aiheuta maksullisia kutsuja.

## Asetukset

| Asetus | Merkitys |
| --- | --- |
| `path` | Cassette-tiedoston polku (JSON). Hakemisto luodaan tarvittaessa. |
| `mode` | `replay`, `record` tai `auto` (ks. yllä). |
| `fetch` | Oikea `fetch` tallennusta varten (oletus `globalThis.fetch`). |
| `ignoreBodyKeys` | JSON-rungon ylätason kentät, jotka jätetään pois pyynnön tunnistamisesta (esim. `["user"]`, jos arvo vaihtelee ajoista toiseen). |

## Miten pyyntö tunnistetaan

Tallenne löytyy menetelmän (GET/POST), URL:n ja JSON-rungon perusteella. JSON-kenttien järjestyksellä ei ole väliä. Otsikoilla ei ole väliä, joten API-avaimen vaihtaminen ei riko tallenteita. Jos sama pyyntö on tallennettu useasti (esim. uudelleenyritys), vastaukset toistetaan tallennetussa järjestyksessä ja viimeinen toistuu sen jälkeen.

## Turvallisuus

- Pyyntöotsikoita (esim. `Authorization`) **ei koskaan tallenneta** eikä niitä käytetä tunnisteen laskentaan. Vastauksista tallennetaan vain `content-type`.
- Pyynnön runko (prompti) **tallennetaan**, jotta cassetten voi lukea ja tarkistaa. Älä laita testipromptiin salaisuuksia tai henkilötietoja.
- Tarkista cassette ennen commitointia: vastausten runkoja ei suodateta.

## Vaihtoehtoja ja miksi tämä

Tilanne 16.10.2026. LLM-kutsujen tallennukseen ja toistoon on jo muitakin työkaluja:

- Toisen kehittäjän npm-paketti nimeltä `llm-cassette` (README:ssä tuote on nimeltä llm-vcr) tallentaa ja toistaa LLM-kutsut testeissä, tukee striimausta ja sumeaa pyyntöjen täsmäystä, ja kytkeytyy testeihin globaalisti (käyttää `msw`-kirjastoa).
- [`@copilotkit/aimock`](https://www.npmjs.com/package/@copilotkit/aimock) on laaja mock-infrastruktuuri tekoälysovellusten testaukseen: paikallinen palvelin, joka vastaa monen palveluntarjoajan puolesta, sekä tallennus ja toisto.
- [`@pollyjs/core`](https://www.npmjs.com/package/@pollyjs/core) on yleiskäyttöinen HTTP-tallennus ja -toisto (ei LLM-erityinen).

llm-cassette on tarkoituksella pieni ja eksplisiittinen, jos tarvitset vain yhden asian: toistaa tallennetut vastaukset `fetch`-pohjaiselle LLM-asiakkaalle ilman verkkoa. Erot:

- **Ei globaalia kytkentää:** annat `cassetteFetch`:n asiakkaasi `fetch`-funktioksi. Mikään ei muutu itsestään.
- **Nolla ajonaikaista riippuvuutta**, koko toteutus on yksi lähdetiedosto.
- **Turvallinen oletus:** oletustila on `replay`, joka ei koskaan käytä verkkoa, joten unohtunut asetus ei aiheuta maksullisia kutsuja.
- **Otsikoita ei tallenneta** (esim. `Authorization`), eikä niitä käytetä tunnisteen laskentaan.

Jos tarvitset striimausta (`stream: true`) tai sumeaa täsmäystä, käytä jotakin yllä olevista: tämä työkalu ei tue niitä.

## Rajoitukset

- Vain merkkijonorunko (JSON) tuetaan pyynnöissä. Striimaus (`stream: true`) ei ole tuettu: vastauksen runko luetaan kokonaan ja toistetaan kerralla.
- Verkkovirheet (esim. yhteys katkeaa) eivät tallennu. HTTP-virhevastaukset (esim. 429, 503) tallentuvat statuksineen, joten niillä voi testata varamalli- ja uudelleenyrityslogiikkaa.

## Kehitys

```bash
npm ci
npm run typecheck
npm test
npm run build
```
