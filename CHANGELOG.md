# Changelog

Muoto perustuu [Keep a Changelogiin](https://keepachangelog.com/fi/1.0.0/), ja versiointi noudattaa [Semantic Versioningia](https://semver.org/lang/fi/).

## [0.2.0] - 2026-10-16

Ensimmäinen npm-julkaisu: `@tonyweckstrom/llm-cassette`.

### Lisätty

- Julkaisu npm:ään scopattuna nimellä (nimi `llm-cassette` oli jo toisen käytössä). Tuonti: `import { cassetteFetch } from "@tonyweckstrom/llm-cassette"`.
- Julkaisutiedot `package.json`:iin (repository, homepage, bugs, keywords, `publishConfig`), `prepublishOnly`-tarkistus ja CI:n pakettitesti (npm pack, asennus puhtaaseen kansioon, record/replay-kierros).
- README: asennusohje ja osio "Vaihtoehtoja ja miksi tämä".

## [0.1.1] - 2026-10-16

### Lisätty

- `prepare`-skripti: asennettavissa suoraan GitHubista.

## [0.1.0] - 2026-10-16

### Lisätty

- Ensimmäinen versio: record/replay `fetch`-pohjaisille LLM-asiakkaille (tilat `replay`, `record`, `auto`), otsikoita ei tallenneta.
