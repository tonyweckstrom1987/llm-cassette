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
 * eikä lueta avaimen laskentaan. URL:n salaisuusparametrit (key, api_key, access_token, token)
 * maskataan ennen tallennusta ja avaimen laskentaa. Pyynnön runko (prompti) tallennetaan luettavuuden vuoksi.
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
      `llm-cassette: no recording found for ${method} ${url} (file ${path}). ` +
        `Run once with LLM_CASSETTE_MODE=record to save the response.`,
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

const SECRET_PARAMS = ["key", "api_key", "access_token", "token"];
const SECRET_PARAM_RE = new RegExp(`([?&;])(${SECRET_PARAMS.join("|")})=[^&#]*`, "gi");

/** Korvaa URL:n tunnettujen salaisuusparametrien arvot merkkijonolla REDACTED. */
export function maskUrl(url: string): string {
  return url.replace(SECRET_PARAM_RE, "$1$2=REDACTED");
}

export function requestKey(method: string, url: string, body: string | null, ignoreBodyKeys: string[] = []): string {
  const normalized = `${method.toUpperCase()}\n${maskUrl(url)}\n${normalizeBody(body, new Set(ignoreBodyKeys))}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function loadFile(path: string): CassetteFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`llm-cassette: file '${path}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const f = parsed as Partial<CassetteFile>;
  if (f?.version !== 1 || !Array.isArray(f.entries)) {
    throw new Error(`llm-cassette: file '${path}' is not a supported cassette format (expected version 1)`);
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
    throw new Error(`llm-cassette: unknown mode '${m}' (allowed: replay, record, auto)`);
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
  throw new Error("llm-cassette: only string (JSON) request bodies are supported; got " + Object.prototype.toString.call(b));
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
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = maskUrl(rawUrl);
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
