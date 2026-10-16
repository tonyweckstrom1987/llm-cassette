import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * llm-cassette: tallentaa fetch-vastaukset tiedostoon ja toistaa ne testeissä.
 *
 * - "replay" (oletus): ei koskaan verkkoa. Puuttuva tallenne = CassetteMissError.
 * - "record": kutsuu oikeaa fetchiä ja tallentaa vastaukset (korvaa saman pyynnön vanhat).
 * - "auto": toistaa jos tallenne löytyy, muuten kutsuu oikeaa fetchiä ja tallentaa.
 *
 * Turvallisuus: pyyntöotsikoita (esim. Authorization) ei koskaan tallenneta
 * eikä lueta avaimen laskentaan. Pyynnön runko (prompti) tallennetaan luettavuuden vuoksi.
 */

export type CassetteMode = "replay" | "record" | "auto";

export interface CassetteOptions {
  /** Cassette-tiedoston polku (JSON). */
  path: string;
  /** Oletus: ympäristömuuttuja LLM_CASSETTE_MODE tai "replay". */
  mode?: CassetteMode;
  /** Oikea fetch tallennusta varten. Oletus: globalThis.fetch. */
  fetch?: typeof fetch;
  /**
   * JSON-rungon kentät, jotka jätetään pois avaimen laskennasta
   * (esim. ["user", "metadata"], jos ne vaihtelevat ajosta toiseen).
   */
  ignoreBodyKeys?: string[];
}

export class CassetteMissError extends Error {
  constructor(public readonly method: string, public readonly url: string, public readonly path: string) {
    super(
      `llm-cassette: tallennetta ei löytynyt pyynnölle ${method} ${url} (tiedosto ${path}). ` +
        `Aja kerran LLM_CASSETTE_MODE=record, jotta vastaus tallentuu.`,
    );
    this.name = "CassetteMissError";
  }
}

interface StoredEntry {
  key: string;
  request: { method: string; url: string; body: string | null };
  response: { status: number; statusText: string; contentType: string | null; body: string };
}

interface CassetteFile {
  version: 1;
  entries: StoredEntry[];
}

function canonicalize(value: unknown, ignore: Set<string>, top = true): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, ignore, false));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      if (top && ignore.has(k)) continue;
      out[k] = canonicalize((value as Record<string, unknown>)[k], ignore, false);
    }
    return out;
  }
  return value;
}

function normalizeBody(body: string | null, ignore: Set<string>): string {
  if (body === null) return "";
  try {
    return JSON.stringify(canonicalize(JSON.parse(body), ignore));
  } catch {
    return body;
  }
}

export function requestKey(method: string, url: string, body: string | null, ignoreBodyKeys: string[] = []): string {
  const normalized = `${method.toUpperCase()}\n${url}\n${normalizeBody(body, new Set(ignoreBodyKeys))}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function loadFile(path: string): CassetteFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`llm-cassette: tiedosto '${path}' ei ole kelvollista JSON:ia: ${err instanceof Error ? err.message : String(err)}`);
  }
  const f = parsed as Partial<CassetteFile>;
  if (f?.version !== 1 || !Array.isArray(f.entries)) {
    throw new Error(`llm-cassette: tiedosto '${path}' ei ole tuettu cassette-muoto (odotettiin version 1)`);
  }
  return f as CassetteFile;
}

function saveFile(path: string, data: CassetteFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function resolveMode(mode: CassetteMode | undefined): CassetteMode {
  const m = mode ?? process.env.LLM_CASSETTE_MODE ?? "replay";
  if (m !== "replay" && m !== "record" && m !== "auto") {
    throw new Error(`llm-cassette: tuntematon tila '${m}' (sallitut: replay, record, auto)`);
  }
  return m;
}

function toResponse(e: StoredEntry): Response {
  const headers = new Headers();
  if (e.response.contentType) headers.set("content-type", e.response.contentType);
  // 204/205/304 eivät saa sisältää runkoa.
  const noBody = [204, 205, 304].includes(e.response.status);
  return new Response(noBody ? null : e.response.body, {
    status: e.response.status,
    statusText: e.response.statusText,
    headers,
  });
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  const b = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (b === undefined || b === null) return null;
  if (typeof b === "string") return b;
  throw new Error("llm-cassette: vain merkkijonorunko (JSON) tuetaan; saatiin " + Object.prototype.toString.call(b));
}

/** Palauttaa fetch-yhteensopivan funktion, joka tallentaa tai toistaa vastaukset. */
export function cassetteFetch(options: CassetteOptions): typeof fetch {
  const mode = resolveMode(options.mode);
  const realFetch = options.fetch ?? globalThis.fetch;
  const file = loadFile(options.path);
  // Kuinka monta kertaa kukin avain on toistettu tässä istunnossa (saman pyynnön peräkkäiset vastaukset).
  const served = new Map<string, number>();
  // Avaimet, joiden vanhat tallenteet on jo korvattu tässä record-istunnossa.
  const rerecorded = new Set<string>();

  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = await requestBody(input, init);
    const key = requestKey(method, url, body, options.ignoreBodyKeys);

    if (mode !== "record") {
      const matches = file.entries.filter((e) => e.key === key);
      if (matches.length > 0) {
        const n = served.get(key) ?? 0;
        served.set(key, n + 1);
        // Peräkkäiset tallennetut vastaukset toistetaan järjestyksessä; viimeinen toistuu loputtomasti.
        return toResponse(matches[Math.min(n, matches.length - 1)]);
      }
      if (mode === "replay") throw new CassetteMissError(method, url, options.path);
    }

    const res = await realFetch(input, init);
    const text = await res.text();
    if (mode === "record" && !rerecorded.has(key)) {
      file.entries = file.entries.filter((e) => e.key !== key);
      rerecorded.add(key);
    }
    file.entries.push({
      key,
      request: { method, url, body },
      response: {
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type"),
        body: text,
      },
    });
    saveFile(options.path, file);
    // Palautetaan tuore Response, koska alkuperäisen runko on jo luettu.
    return toResponse(file.entries[file.entries.length - 1]);
  };
}
