import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cassetteFetch, CassetteMissError, requestKey } from "../src/index.js";

const URL_ = "http://llm.local/v1/chat/completions";

function fakeFetch(replies: Array<{ status?: number; body: unknown }>) {
  let calls = 0;
  const f = (async () => {
    const r = replies[Math.min(calls, replies.length - 1)];
    calls++;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", "x-secret-header": "ei-tallenneta" },
    });
  }) as typeof fetch;
  return { f, calls: () => calls };
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers, body: JSON.stringify(body) };
}

describe("llm-cassette", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-cassette-"));
    path = join(dir, "nested", "c.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("record tallentaa ja replay toistaa saman vastauksen ilman verkkoa", async () => {
    const real = fakeFetch([{ body: { text: "moi" } }]);
    const rec = cassetteFetch({ path, mode: "record", fetch: real.f });
    const r1 = await rec(URL_, post({ model: "m", prompt: "hei" }));
    expect(await r1.json()).toEqual({ text: "moi" });
    expect(real.calls()).toBe(1);

    const never = fakeFetch([{ body: "ei saa kutsua" }]);
    const rep = cassetteFetch({ path, mode: "replay", fetch: never.f });
    const r2 = await rep(URL_, post({ model: "m", prompt: "hei" }));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ text: "moi" });
    expect(never.calls()).toBe(0);
  });

  it("replay ilman tallennetta heittää CassetteMissError eikä kutsu verkkoa", async () => {
    const never = fakeFetch([{ body: "x" }]);
    const rep = cassetteFetch({ path, mode: "replay", fetch: never.f });
    await expect(rep(URL_, post({ prompt: "uusi" }))).rejects.toBeInstanceOf(CassetteMissError);
    expect(never.calls()).toBe(0);
  });

  it("oletustila on replay (myös ilman mode-asetusta)", async () => {
    const prev = process.env.LLM_CASSETTE_MODE;
    delete process.env.LLM_CASSETTE_MODE;
    try {
      const never = fakeFetch([{ body: "x" }]);
      const f = cassetteFetch({ path, fetch: never.f });
      await expect(f(URL_, post({ a: 1 }))).rejects.toBeInstanceOf(CassetteMissError);
      expect(never.calls()).toBe(0);
    } finally {
      if (prev !== undefined) process.env.LLM_CASSETTE_MODE = prev;
    }
  });

  it("ympäristömuuttuja LLM_CASSETTE_MODE=record valitsee tilan", async () => {
    const prev = process.env.LLM_CASSETTE_MODE;
    process.env.LLM_CASSETTE_MODE = "record";
    try {
      const real = fakeFetch([{ body: { ok: 1 } }]);
      const f = cassetteFetch({ path, fetch: real.f });
      await f(URL_, post({ a: 1 }));
      expect(real.calls()).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.LLM_CASSETTE_MODE;
      else process.env.LLM_CASSETTE_MODE = prev;
    }
  });

  it("tuntematon tila hylätään", () => {
    expect(() => cassetteFetch({ path, mode: "joku" as never })).toThrow(/tuntematon tila/);
  });

  it("auto: toistaa löytyvän ja tallentaa puuttuvan", async () => {
    const real = fakeFetch([{ body: { n: 1 } }, { body: { n: 2 } }]);
    const f = cassetteFetch({ path, mode: "auto", fetch: real.f });
    await f(URL_, post({ q: "a" }));
    await f(URL_, post({ q: "a" })); // toistetaan, ei verkkoa
    await f(URL_, post({ q: "b" })); // uusi, tallennetaan
    expect(real.calls()).toBe(2);
  });

  it("avain ei riipu JSON-kenttien järjestyksestä eikä otsikoista", async () => {
    const real = fakeFetch([{ body: { ok: true } }]);
    await cassetteFetch({ path, mode: "record", fetch: real.f })(URL_, post({ a: 1, b: { y: 2, x: 3 } }, { authorization: "Bearer a" }));

    const never = fakeFetch([{ body: "x" }]);
    const res = await cassetteFetch({ path, mode: "replay", fetch: never.f })(
      URL_,
      post({ b: { x: 3, y: 2 }, a: 1 }, { authorization: "Bearer TOINEN-AVAIN" }),
    );
    expect(await res.json()).toEqual({ ok: true });
  });

  it("eri prompt tai eri URL ei osu samaan tallenteeseen", async () => {
    const real = fakeFetch([{ body: { ok: true } }]);
    await cassetteFetch({ path, mode: "record", fetch: real.f })(URL_, post({ p: "yksi" }));
    const rep = cassetteFetch({ path, mode: "replay", fetch: fakeFetch([{ body: "x" }]).f });
    await expect(rep(URL_, post({ p: "kaksi" }))).rejects.toBeInstanceOf(CassetteMissError);
    await expect(rep("http://llm.local/v1/muu", post({ p: "yksi" }))).rejects.toBeInstanceOf(CassetteMissError);
  });

  it("ignoreBodyKeys jättää vaihtelevat kentät pois avaimesta", async () => {
    const real = fakeFetch([{ body: { ok: true } }]);
    await cassetteFetch({ path, mode: "record", fetch: real.f, ignoreBodyKeys: ["user"] })(URL_, post({ p: 1, user: "a" }));
    const res = await cassetteFetch({ path, mode: "replay", fetch: fakeFetch([{ body: "x" }]).f, ignoreBodyKeys: ["user"] })(
      URL_,
      post({ p: 1, user: "b" }),
    );
    expect(await res.json()).toEqual({ ok: true });
  });

  it("ei tallenna pyyntöotsikoita eikä salaisuuksia tiedostoon", async () => {
    const real = fakeFetch([{ body: { ok: true } }]);
    await cassetteFetch({ path, mode: "record", fetch: real.f })(URL_, post({ p: 1 }, { authorization: "Bearer sk-salainen-123" }));
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("sk-salainen-123");
    expect(raw.toLowerCase()).not.toContain("authorization");
    expect(raw).not.toContain("ei-tallenneta"); // vastausotsikkoa x-secret-header ei myöskään talleteta
  });

  it("tallentaa virhevastaukset (status säilyy) ja toistaa ne", async () => {
    const real = fakeFetch([{ status: 503, body: { error: "alhaalla" } }]);
    await cassetteFetch({ path, mode: "record", fetch: real.f })(URL_, post({ p: 1 }));
    const res = await cassetteFetch({ path, mode: "replay", fetch: fakeFetch([{ body: "x" }]).f })(URL_, post({ p: 1 }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "alhaalla" });
  });

  it("sama pyyntö toistetaan tallennetussa järjestyksessä ja viimeinen jää voimaan", async () => {
    const real = fakeFetch([{ body: { n: 1 } }, { body: { n: 2 } }]);
    const a = cassetteFetch({ path, mode: "auto", fetch: real.f });
    // Ensimmäinen kutsu tallentaa n=1, toinen osuu jo tallenteeseen -> kirjoitetaan käsin kaksi vastausta:
    await a(URL_, post({ p: 1 }));
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.entries.push({ ...file.entries[0], response: { ...file.entries[0].response, body: JSON.stringify({ n: 2 }) } });
    writeFileSync(path, JSON.stringify(file));

    const rep = cassetteFetch({ path, mode: "replay", fetch: fakeFetch([{ body: "x" }]).f });
    expect(await (await rep(URL_, post({ p: 1 }))).json()).toEqual({ n: 1 });
    expect(await (await rep(URL_, post({ p: 1 }))).json()).toEqual({ n: 2 });
    expect(await (await rep(URL_, post({ p: 1 }))).json()).toEqual({ n: 2 });
  });

  it("record korvaa saman pyynnön vanhan tallenteen mutta säilyttää muut", async () => {
    await cassetteFetch({ path, mode: "record", fetch: fakeFetch([{ body: { v: "vanha" } }]).f })(URL_, post({ p: 1 }));
    await cassetteFetch({ path, mode: "record", fetch: fakeFetch([{ body: { v: "muu" } }]).f })(URL_, post({ p: 2 }));
    await cassetteFetch({ path, mode: "record", fetch: fakeFetch([{ body: { v: "uusi" } }]).f })(URL_, post({ p: 1 }));

    const rep = cassetteFetch({ path, mode: "replay", fetch: fakeFetch([{ body: "x" }]).f });
    expect(await (await rep(URL_, post({ p: 1 }))).json()).toEqual({ v: "uusi" });
    expect(await (await rep(URL_, post({ p: 2 }))).json()).toEqual({ v: "muu" });
    expect(JSON.parse(readFileSync(path, "utf8")).entries).toHaveLength(2);
  });

  it("rikkinäinen tai vieras cassette-tiedosto antaa selkeän virheen", () => {
    writeFileSync(join(dir, "huono.json"), "{ ei json");
    expect(() => cassetteFetch({ path: join(dir, "huono.json"), mode: "replay" })).toThrow(/ei ole kelvollista JSON/);
    writeFileSync(join(dir, "vieras.json"), JSON.stringify({ version: 99, entries: [] }));
    expect(() => cassetteFetch({ path: join(dir, "vieras.json"), mode: "replay" })).toThrow(/ei ole tuettu/);
  });

  it("requestKey on vakaa ja erottaa metodin", () => {
    expect(requestKey("post", "http://a", '{"x":1}')).toBe(requestKey("POST", "http://a", '{ "x": 1 }'));
    expect(requestKey("GET", "http://a", null)).not.toBe(requestKey("POST", "http://a", null));
  });
});
