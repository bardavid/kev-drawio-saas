import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DRAWIO_EMBED_URL } from "../src/lib/drawio/protocol";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { summarizeDiagram } from "../src/lib/drawio/xml";
import { decideDemo } from "../src/lib/kev/demo";
import { KevError } from "../src/lib/kev/client";
import { describeMode, mergeKevWithDemo, runKevTurn } from "../src/lib/kev/run";
import {
  INTENT_CRITERIA,
  KevUnreachableError,
  buildSystemOneRequest,
  needsXmlEdit,
  parseSystemOneResponse,
} from "../src/lib/kev/systemone";
import type { KevReading } from "../src/lib/kev/types";

const ENV_KEYS = ["KEV_BASE_URL", "KEV_API_KEY", "KEV_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;
const originalFetch = globalThis.fetch;

function blankEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("draw.io embed", () => {
  it("uses the diagrams.net json protocol url", () => {
    assert.equal(DRAWIO_EMBED_URL, "https://embed.diagrams.net/?embed=1&proto=json&configure=1&libraries=1&ui=min");
  });
});

describe("system one contract", () => {
  it("asks Kev for a choice, a noul, and a score", () => {
    const request = buildSystemOneRequest({
      userMessage: "Make the API box red",
      summary: summarizeDiagram(STARTER_XML),
    });
    assert.equal(request.model, "kev-latest");
    assert.match(request.state, /Make the API box red/);
    assert.match(request.state, /API/);
    assert.equal(request.questions.intent.type, "choice");
    assert.match(request.questions.intent.instructions, /What diagram edit does the user want/);
    assert.match(request.questions.intent.instructions, /change the boxes to red/);
    assert.deepEqual(request.questions.intent.criteria, INTENT_CRITERIA);
    assert.deepEqual(request.questions.needs_xml_edit, {
      type: "noul",
      instructions: "Should the diagram XML be modified?",
    });
    assert.equal(request.questions.disruption.type, "score");
    assert.ok(Array.isArray(request.questions.disruption.criteria));
    const anchor = request.questions.anchor.criteria as Record<string, string>;
    assert.equal(typeof anchor.API, "string");
    assert.equal(typeof anchor.none, "string");
    assert.equal("currentXml" in request, false);
  });

  it("maps choice, noul, and score answers", () => {
    const reading = parseSystemOneResponse(
      {
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "style", confidence: 0.82, probabilities: { style: 0.9 } },
          needs_xml_edit: { type: "noul", noul: 0.93 },
          color: { type: "choice", choice: "red", confidence: 0.7 },
          anchor: { type: "choice", choice: "api" },
          shape: { type: "choice", choice: "none" },
          layout: { type: "choice", choice: "none" },
          place: { type: "choice", choice: "none" },
          source: { type: "choice", choice: "none" },
          target: { type: "choice", choice: "none" },
          disruption: {
            type: "score",
            score: 1,
            legend: ["leave the diagram alone", "a small local edit", "rewire a few shapes", "rebuild the layout"],
          },
        },
        usage: { input_tokens: 10, output_tokens: 12 },
        latency_ms: 20,
      },
      ["Client", "API", "Postgres"],
    );
    assert.equal(reading.intent, "style");
    assert.equal(reading.needsXmlEdit, true);
    assert.equal(reading.slots.colorName, "red");
    assert.equal(reading.slots.target, "API");
    assert.equal(reading.slots.shape, null);
    assert.equal(reading.confidence, 0.82);
    assert.equal(reading.disruption, 1);
    assert.equal(reading.disruptionLegend, "a small local edit");
    assert.equal(reading.model, "kev-latest");
  });

  it("keeps the xml when the noul is below one half", () => {
    const reading = parseSystemOneResponse(
      {
        answers: {
          intent: { type: "choice", choice: "add_shape", confidence: 0.4 },
          needs_xml_edit: { type: "noul", noul: 0.2 },
        },
      },
      ["API"],
    );
    assert.equal(reading.intent, "add_shape");
    assert.equal(reading.needsXmlEdit, false);
  });

  it("never edits clarify or noop", () => {
    assert.equal(needsXmlEdit("clarify", 0.99), false);
    assert.equal(needsXmlEdit("noop", null), false);
    assert.equal(needsXmlEdit("layout", null), true);
    assert.equal(needsXmlEdit("style", 0.5), true);
    assert.equal(needsXmlEdit("style", 0.49), false);
  });

  it("treats an unknown choice as clarify", () => {
    const reading = parseSystemOneResponse(
      {
        answers: {
          intent: { type: "choice", choice: "explode" },
          needs_xml_edit: { type: "noul", noul: 0.9 },
        },
      },
      [],
    );
    assert.equal(reading.intent, "clarify");
    assert.equal(reading.needsXmlEdit, false);
  });

  it("rejects a body without answers", () => {
    assert.throws(() => parseSystemOneResponse({ model: "kev-latest" }, []), /unreadable/);
  });

  it("accepts a score legend string", () => {
    const reading = parseSystemOneResponse(
      {
        answers: {
          intent: { type: "choice", choice: "layout" },
          needs_xml_edit: { type: "noul", noul: 1 },
          disruption: { type: "score", score: 3, legend: "rebuild the layout" },
        },
      },
      [],
    );
    assert.equal(reading.disruptionLegend, "rebuild the layout");
    assert.equal(reading.slots.layout, null);
  });

  it("keeps demo labels and lets Kev override the closed choices", () => {
    const reading: KevReading = {
      intent: "add_shape",
      needsXmlEdit: true,
      confidence: 0.6,
      disruption: 2,
      disruptionLegend: "rewire a few shapes",
      slots: { shape: "cylinder", place: "before", target: "Postgres", colorName: "red" },
    };
    const merged = mergeKevWithDemo(reading, decideDemo("Add a Redis cache in front of the database"));
    assert.equal(merged.intent, "add_shape");
    assert.equal(merged.slots.label, "Redis");
    assert.equal(merged.slots.shape, "cylinder");
    assert.equal(merged.slots.place, "before");
    assert.equal(merged.slots.target, "Postgres");
    assert.equal(merged.slots.colorName, "red");
    assert.match(merged.reply, /Redis/);
  });
});

describe("configured pipeline", { concurrency: 1 }, () => {
  afterEach(() => {
    blankEnv();
    globalThis.fetch = originalFetch;
  });

  it("stays in demo mode when neither host is set", async () => {
    blankEnv();
    assert.deepEqual(describeMode(), { mode: "demo", kev: false, openai: false });
    const result = await runKevTurn({
      messages: [{ role: "user", content: "Make the API box red" }],
      currentXml: STARTER_XML,
    });
    assert.equal(result.mode, "demo");
    assert.equal(result.intent, "style");
    const api = summarizeDiagram(result.updatedXml).vertices.find((vertex) => vertex.label === "API");
    assert.match(api?.style ?? "", /#f8cecc/);
  });

  it("names Kev when both hosts are configured", () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.OPENAI_API_KEY = "sk-test";
    const mode = describeMode();
    assert.equal(mode.mode, "kev");
    assert.equal(mode.model, "kev-latest");
    assert.equal(mode.kev, true);
    assert.equal(mode.openai, true);
  });

  it("applies a Kev style choice without calling a language model", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local/";
    process.env.KEV_API_KEY = "local-key";
    let auth = "";
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      auth = new Headers(init?.headers).get("authorization") ?? "";
      const body = JSON.parse(String(init?.body)) as { state: string; questions: { intent: { type: string } } };
      assert.equal(body.questions.intent.type, "choice");
      assert.match(body.state, /Make the API box red/);
      return jsonResponse({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "style", confidence: 0.8 },
          needs_xml_edit: { type: "noul", noul: 0.9 },
          color: { type: "choice", choice: "red" },
          anchor: { type: "choice", choice: "API" },
          shape: { type: "choice", choice: "none" },
          disruption: { type: "score", score: 1, legend: "a small local edit" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "Make the API box red" }],
      currentXml: STARTER_XML,
    });
    assert.equal(url, "http://kev.local/v1/systemone");
    assert.equal(auth, "Bearer local-key");
    assert.equal(result.mode, "kev");
    assert.equal(result.model, "kev-latest");
    assert.equal(result.intent, "style");
    assert.equal(result.fallback, undefined);
    assert.equal(result.confidence, 0.8);
    assert.equal(result.slots.fillColor, "#f8cecc");
    assert.equal(result.slots.strokeColor, "#b85450");
    const api = summarizeDiagram(result.updatedXml).vertices.find((vertex) => vertex.label === "API");
    assert.match(api?.style ?? "", /#f8cecc/);
  });

  it("leaves the xml alone when Kev's noul says no", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async () =>
      jsonResponse({
        answers: {
          intent: { type: "choice", choice: "style", confidence: 0.2 },
          needs_xml_edit: { type: "noul", noul: 0.1 },
        },
      })) as typeof fetch;
    const result = await runKevTurn({
      messages: [{ role: "user", content: "Make the API box red" }],
      currentXml: STARTER_XML,
    });
    assert.equal(result.mode, "kev");
    assert.equal(result.intent, "clarify");
    assert.equal(result.updatedXml, STARTER_XML);
  });

  it("asks the model to write xml from Kev's intent", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.OPENAI_API_KEY = "sk-test";
    const painted = STARTER_XML.replace("#d5e8d4", "#f8cecc").replace("#82b366", "#b85450");
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/v1/systemone")) {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), null);
        return jsonResponse({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "style", confidence: 0.77 },
            needs_xml_edit: { type: "noul", noul: 0.88 },
            color: { type: "choice", choice: "red" },
            anchor: { type: "choice", choice: "API" },
          },
        });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const joined = body.messages.map((message) => message.content).join("\n");
      assert.match(joined, /Do not change the intent/);
      assert.match(joined, /"intent":"style"/);
      assert.match(joined, /mxGraphModel/);
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: "style",
                reply: "Set API to red.",
                updatedXml: painted,
                slots: {
                  label: null,
                  shape: null,
                  fillColor: "#f8cecc",
                  strokeColor: "#b85450",
                  colorName: "red",
                  from: null,
                  to: null,
                  target: "API",
                  newLabel: null,
                  edgeLabel: null,
                  layout: null,
                  place: null,
                },
                operations: [],
              }),
            },
          },
        ],
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "Make the API box red" }],
      currentXml: STARTER_XML,
    });
    assert.deepEqual(
      calls.map((url) => new URL(url).pathname),
      ["/v1/systemone", "/v1/chat/completions"],
    );
    assert.equal(result.mode, "kev");
    assert.equal(result.intent, "style");
    assert.equal(result.repaired, false);
    assert.equal(result.fallback, undefined);
    const api = summarizeDiagram(result.updatedXml).vertices.find((vertex) => vertex.label === "API");
    assert.match(api?.style ?? "", /#f8cecc/);
  });

  it("falls back to the language model when Kev is unreachable", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/systemone")) throw new TypeError("connect ECONNREFUSED");
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: "noop",
                reply: "Nothing to change.",
                updatedXml: "",
                slots: {},
                operations: [],
              }),
            },
          },
        ],
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "hello" }],
      currentXml: STARTER_XML,
    });
    assert.equal(result.mode, "openai");
    assert.equal(result.fallback, true);
    assert.equal(result.intent, "noop");
    assert.equal(result.updatedXml, STARTER_XML);
  });

  it("surfaces a Kev outage when no language model is configured", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async () => jsonResponse({ error: "down" }, 503)) as typeof fetch;
    await assert.rejects(
      () =>
        runKevTurn({
          messages: [{ role: "user", content: "hello" }],
          currentXml: STARTER_XML,
        }),
      (error: unknown) => error instanceof KevUnreachableError,
    );
  });

  it("does not treat a Kev 400 as an outage", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.OPENAI_API_KEY = "sk-test";
    let openaiCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/chat/completions")) {
        openaiCalls += 1;
        return jsonResponse({ error: "should not run" }, 500);
      }
      return jsonResponse({ error: "bad questions" }, 400);
    }) as typeof fetch;
    await assert.rejects(
      () =>
        runKevTurn({
          messages: [{ role: "user", content: "hello" }],
          currentXml: STARTER_XML,
        }),
      (error: unknown) => error instanceof KevError && !(error instanceof KevUnreachableError) && /bad questions/.test(error.message),
    );
    assert.equal(openaiCalls, 0);
  });

  it("clarifies a bare draw instead of reporting no diagram change", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    const calls: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
      calls.push(Object.keys(body.questions).sort().join(","));
      if (body.questions.intent) {
        return jsonResponse({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "noop", confidence: 0.4 },
            needs_xml_edit: { type: "noul", noul: 0.2 },
          },
        });
      }
      return jsonResponse({
        answers: {
          specific: { type: "noul", noul: 0.08 },
          next: { type: "choice", choice: "clarify", confidence: 0.7 },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "draw" }],
      currentXml: STARTER_XML,
    });
    assert.deepEqual(calls, ["anchor,color,disruption,intent,layout,needs_xml_edit,place,shape,source,target", "next,specific"]);
    assert.equal(result.mode, "kev");
    assert.equal(result.intent, "clarify");
    assert.equal(result.updatedXml, STARTER_XML);
    assert.match(result.reply, /What should I draw/);
    assert.equal(result.reply.includes("No diagram change"), false);
    assert.equal(result.steps?.length, 1);
  });

  it("builds a 3-tier diagram when the first System One reading is noop or style", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    process.env.OPENAI_API_KEY = "sk-test";
    const prompts = [
      "draw a Complex 3 Tier Web App: Client → Postgres, orange, horizontal",
      "draw a Complex 3 Tier Web App Client to Postgres orange horizontal",
    ];
    for (const [index, prompt] of prompts.entries()) {
      const urls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
        if (url.includes("/chat/completions")) {
          return jsonResponse({ error: "writer should not run" }, 500);
        }
        if (body.questions.intent) {
          return jsonResponse({
            model: "kev-latest",
            answers: {
              intent: { type: "choice", choice: index === 0 ? "noop" : "style", confidence: 0.42 },
              needs_xml_edit: { type: "noul", noul: index === 0 ? 0.2 : 0.9 },
              color: { type: "choice", choice: "orange" },
              layout: { type: "choice", choice: "horizontal" },
              shape: { type: "choice", choice: "rectangle" },
            },
          });
        }
        return jsonResponse({
          model: "kev-latest",
          answers: {
            next: { type: "choice", choice: "apply", confidence: 0.93 },
            confirm: { type: "noul", noul: 0.97 },
            shape: { type: "choice", choice: "none" },
            color: { type: "choice", choice: "orange" },
            layout: { type: "choice", choice: "horizontal" },
          },
        });
      }) as typeof fetch;

      const result = await runKevTurn({
        messages: [{ role: "user", content: prompt }],
        currentXml: STARTER_XML,
      });
      assert.equal(urls.some((url) => url.includes("/chat/completions")), false);
      assert.ok(urls.length >= 4, `expected several System One calls, got ${urls.length}`);
      assert.equal(result.mode, "kev");
      assert.equal(result.model, "kev-latest");
      assert.equal(result.intent, "add_shape");
      assert.equal(result.fallback, undefined);
      assert.equal(result.slots.label, "Complex 3 Tier Web App");
      assert.equal(result.slots.shape, "rectangle");
      assert.equal(result.slots.from, "Client");
      assert.equal(result.slots.to, "Postgres");
      assert.equal(result.slots.colorName, "orange");
      assert.equal(result.slots.fillColor, "#ffe6cc");
      assert.equal(result.slots.strokeColor, "#d79b00");
      assert.equal(result.slots.layout, "horizontal");
      assert.match(result.reply, /Client → App → Postgres/);
      assert.equal(result.reply.includes("No diagram change"), false);
      assert.ok((result.steps ?? []).length >= 3);
      assert.equal(result.steps?.every((step) => step.accepted), true);
      assert.notEqual(result.updatedXml, STARTER_XML);

      const summary = summarizeDiagram(result.updatedXml);
      assert.ok(summary.vertices.some((vertex) => vertex.label === "App"));
      assert.ok(summary.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
      assert.ok(summary.edges.some((edge) => edge.from === "App" && edge.to === "Postgres"));
      assert.ok(summary.vertices.every((vertex) => vertex.style.includes("fillColor=#ffe6cc")));
      assert.equal(new Set(summary.vertices.map((vertex) => vertex.y)).size, 1);
      const x = new Map(summary.vertices.map((vertex) => [vertex.label, vertex.x]));
      assert.ok((x.get("Client") ?? 0) < (x.get("App") ?? 0));
      assert.ok((x.get("App") ?? 0) < (x.get("Postgres") ?? 0));
      assert.match(result.updatedXml, /id="0"/);
      assert.match(result.updatedXml, /id="1"/);
    }
  });

  it("draws the 3-tier plan when Jev returns confirm 0.43 and next is not apply", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
      if (body.questions.intent) {
        return jsonResponse({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "style", confidence: 0.4 },
            needs_xml_edit: { type: "noul", noul: 0.8 },
            color: { type: "choice", choice: "orange" },
            layout: { type: "choice", choice: "horizontal" },
          },
        });
      }
      return jsonResponse({
        model: "kev-latest",
        answers: {
          next: { type: "choice", choice: "noop", confidence: 0.55 },
          confirm: { type: "noul", noul: 0.43 },
          shape: { type: "choice", choice: "none" },
          color: { type: "choice", choice: "none" },
          layout: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [
        { role: "user", content: "draw a Complex 3 Tier Web App: Client → Postgres, orange, horizontal" },
      ],
      currentXml: STARTER_XML,
    });
    assert.equal(result.intent, "add_shape");
    assert.equal(result.reply.includes("Which nodes"), false);
    assert.match(result.reply, /Client → App → Postgres/);
    assert.equal(result.steps?.[0]?.accepted, true);
    assert.equal(result.steps?.[0]?.confirm, 0.43);
    assert.equal(result.steps?.[0]?.choice, "noop");
    assert.equal(result.steps?.every((step) => step.accepted && step.confirm === 0.43 && step.choice === "noop"), true);
    const summary = summarizeDiagram(result.updatedXml);
    assert.ok(summary.vertices.some((vertex) => vertex.label === "App"));
    assert.ok(summary.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
    assert.ok(summary.edges.some((edge) => edge.from === "App" && edge.to === "Postgres"));
    assert.ok(summary.vertices.every((vertex) => vertex.style.includes("fillColor=#ffe6cc")));
    assert.equal(new Set(summary.vertices.map((vertex) => vertex.y)).size, 1);
    assert.notEqual(result.updatedXml, STARTER_XML);
  });

  it("gates a concrete edit that the first reading called noop", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
      if (body.questions.intent) {
        return jsonResponse({
          answers: {
            intent: { type: "choice", choice: "noop", confidence: 0.3 },
            needs_xml_edit: { type: "noul", noul: 0.1 },
          },
        });
      }
      assert.equal(body.questions.confirm?.type, "noul");
      return jsonResponse({
        answers: {
          next: { type: "choice", choice: "apply", confidence: 0.88 },
          confirm: { type: "noul", noul: 0.91 },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "Add a Redis cache in front of the database" }],
      currentXml: STARTER_XML,
    });
    assert.equal(calls, 2);
    assert.equal(result.intent, "add_shape");
    assert.equal(result.steps?.[0]?.accepted, true);
    const summary = summarizeDiagram(result.updatedXml);
    assert.ok(summary.vertices.some((vertex) => vertex.label === "Redis"));
    assert.ok(summary.edges.some((edge) => edge.from === "API" && edge.to === "Redis"));
    assert.ok(summary.edges.some((edge) => edge.from === "Redis" && edge.to === "Postgres"));
  });

  it("still connects two shapes in one System One call", async () => {
    blankEnv();
    process.env.KEV_BASE_URL = "http://kev.local";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "connect", confidence: 0.86 },
          needs_xml_edit: { type: "noul", noul: 0.9 },
          source: { type: "choice", choice: "Client" },
          target: { type: "choice", choice: "Postgres" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "Connect the client to Postgres" }],
      currentXml: STARTER_XML,
    });
    assert.equal(calls, 1);
    assert.equal(result.intent, "connect");
    assert.ok(summarizeDiagram(result.updatedXml).edges.some((edge) => edge.from === "Client" && edge.to === "Postgres"));
  });
});
