import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { GET, POST } from "../src/app/api/chat/route";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { presentChatError, presentChatStatus, presentChatTurn } from "../src/lib/kev/present";
import { buildSystemPrompt, buildXmlWriterPrompt } from "../src/lib/kev/prompt";
import { describeMode } from "../src/lib/kev/run";
import type { KevTurnResult } from "../src/lib/kev/types";

const ENV_KEYS = ["KEV_BASE_URL", "KEV_API_KEY", "KEV_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;
const originalFetch = globalThis.fetch;
const LEAK = /jev(?:-[\w.]+)?|typesafe|\bkev\b(?:-[\w.]+)?/i;

function blankEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function chatRequest(content: string, currentXml = SEEDED_XML): Request {
  return new Request("http://draw.ai/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content }],
      currentXml,
    }),
  });
}

afterEach(() => {
  blankEnv();
  globalThis.fetch = originalFetch;
});

describe("client-facing chat", () => {
  it("hides the decision host on GET while describeMode keeps the model id", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.KEV_MODEL = "jev-latest";
    assert.equal(describeMode().mode, "kev");
    assert.equal(describeMode().model, "jev-latest");

    const body = await (await GET()).json();
    assert.deepEqual(body, {});
    assert.equal(LEAK.test(JSON.stringify(body)), false);
  });

  it("drops model and kev mode from a successful chat response", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.KEV_MODEL = "jev-latest";
    globalThis.fetch = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as typeof fetch;

    const response = await POST(chatRequest("draw a login sequence", STARTER_XML));
    const body = (await response.json()) as KevTurnResult;
    assert.equal(response.status, 200);
    assert.match(body.reply, /login sequence/);
    assert.equal("model" in body, false);
    assert.equal("mode" in body, false);
    const { updatedXml: _xml, ...rest } = body;
    assert.equal(LEAK.test(JSON.stringify(rest)), false);
  });

  it("does not toast a provider outage by name", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.KEV_MODEL = "jev-latest";
    globalThis.fetch = (async () => jsonResponse({ error: "jev-latest down" }, 503)) as typeof fetch;

    const response = await POST(chatRequest("hello"));
    const body = (await response.json()) as { error?: string };
    assert.equal(response.status, 502);
    assert.equal(body.error, "Could not update the diagram.");
    assert.equal(LEAK.test(JSON.stringify(body)), false);
  });

  it("scrubs a provider name inside an upstream error and keeps other errors", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async () => jsonResponse({ error: "unknown model jev-latest" }, 400)) as typeof fetch;
    const leaked = (await (await POST(chatRequest("hello"))).json()) as { error?: string };
    assert.equal(leaked.error, "Could not update the diagram.");

    globalThis.fetch = (async () => jsonResponse({ error: "bad questions" }, 400)) as typeof fetch;
    const plain = (await (await POST(chatRequest("hello"))).json()) as { error?: string };
    assert.equal(plain.error, "bad questions");
    assert.equal(presentChatError("Name the shape to edit."), "Name the shape to edit.");
    assert.equal(presentChatError("Kev is unreachable (503)."), "Could not update the diagram.");
  });

  it("strips a branded sentence from the reply and keeps the diagram sentence", () => {
    const turn = presentChatTurn({
      reply: "Drew the API in red. Answered by Jev (jev-latest) via TypeSafe.",
      updatedXml: SEEDED_XML,
      mode: "kev",
      model: "jev-latest",
      intent: "style",
      slots: { colorName: "red" },
      repaired: false,
    });
    assert.equal(turn.reply, "Drew the API in red.");
    assert.equal("model" in turn, false);
    assert.equal("mode" in turn, false);
    assert.deepEqual(presentChatStatus({ mode: "demo", kev: false, openai: false }), { mode: "demo" });
    assert.deepEqual(presentChatStatus({ mode: "openai", model: "gpt-test", kev: false, openai: true }), { mode: "openai" });
    assert.equal(presentChatStatus({ mode: "openai", model: "gpt-test", kev: false, openai: true }).mode, "openai");
    assert.equal("model" in presentChatStatus({ mode: "openai", model: "jev-latest", kev: false, openai: true }), false);
  });

  it("does not ask the writer to name the provider", () => {
    const text = `${buildSystemPrompt()}\n${buildXmlWriterPrompt()}`;
    assert.equal(LEAK.test(text), false);
  });

  it("ui copy does not name the provider", () => {
    const files = [...tsxFiles("src/components"), ...tsxFiles("src/app")];
    assert.ok(files.length > 0);
    for (const file of files) {
      const text = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*import\b/.test(line))
        .join("\n");
      assert.equal(LEAK.test(text), false, file);
    }
  });
});
