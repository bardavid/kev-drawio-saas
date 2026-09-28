import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assessDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { PALETTE } from "../src/lib/drawio/styles";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { parseArchitecture } from "../src/lib/kev/plan";
import { DEPTH_INSTRUCTIONS, STRATEGY_BLOCK, compositionNextInstructions } from "../src/lib/kev/prompt-guide";
import { buildSystemPrompt } from "../src/lib/kev/prompt";
import { runKevTurn } from "../src/lib/kev/run";
import { componentsFromBrief, ideaSubject, longUnlistedDescription } from "../src/lib/kev/scale";
import { buildSystemOneRequest } from "../src/lib/kev/systemone";
import { summarizeDiagram } from "../src/lib/drawio/xml";

const ENV_KEYS = ["KEV_BASE_URL", "KEV_API_KEY", "KEV_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;
const PASTEL = new Set(Object.values(PALETTE).map((color) => color.fill.toLowerCase()));

const KV = "Draw a subsystem of general purpose KV caching storage and its interactions";
const QUEUE = "Sketch a subsystem of distributed message delivery and its interactions";

const CACHE_NOTES =
  "Clients call the cache API. The cache API reads the key index. The key index writes to the backing store. The cache API replicates to peers. Peers persist to the backing store.";

const QUEUE_NOTES =
  "Producers publish to the broker. The broker delivers to consumers. Consumers send acknowledgements. The broker writes to retention.";

function content(nodes: QualityNode[]): QualityNode[] {
  return nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor");
}

function assertClean(xml: string) {
  const report = assessDiagram(xml);
  assert.deepEqual(report.overlaps, [], `overlaps: ${JSON.stringify(report.overlaps)}`);
  assert.deepEqual(report.crossings, [], `crossings: ${JSON.stringify(report.crossings)}`);
  return report;
}

describe("diagram depth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  it("asks Jev whether the idea is high-level or detailed", () => {
    assert.match(STRATEGY_BLOCK, /Depth/);
    assert.match(STRATEGY_BLOCK, /high-level/);
    assert.match(STRATEGY_BLOCK, /detailed/);
    assert.match(STRATEGY_BLOCK, /few/);
    assert.match(STRATEGY_BLOCK, /many components/);
    assert.match(DEPTH_INSTRUCTIONS, /high-level/);
    assert.match(DEPTH_INSTRUCTIONS, /detailed/);
    assert.match(DEPTH_INSTRUCTIONS, /→ few/);
    assert.match(DEPTH_INSTRUCTIONS, /→ many/);
    assert.match(DEPTH_INSTRUCTIONS, /Two boxes: A and B/);
    const request = buildSystemOneRequest({
      userMessage: KV,
      summary: summarizeDiagram(STARTER_XML),
      currentXml: STARTER_XML,
    });
    assert.equal(request.questions.depth?.type, "choice");
    assert.match(request.questions.depth?.instructions ?? "", /Judge the idea/);
    const criteria = request.questions.depth?.criteria as Record<string, string>;
    assert.match(criteria.few ?? "", /few boxes/);
    assert.match(criteria.many ?? "", /many components/);
    assert.match(compositionNextInstructions("outline"), /high-level/);
    assert.match(compositionNextInstructions("outline"), /leftover fragments/);
    assert.match(compositionNextInstructions("outline"), /few-box ask/);
    assert.match(buildSystemPrompt(), /high-level ask/);
    assert.match(buildSystemPrompt(), /detailed ask/);
    assert.match(buildSystemPrompt(), /Two boxes: A and B/);
  });

  it("treats a long undescribed idea as open and a counted pair as named boxes", () => {
    assert.equal(longUnlistedDescription(KV), true);
    assert.equal(longUnlistedDescription(QUEUE), true);
    assert.equal(longUnlistedDescription("Draw two boxes: A and B"), false);
    assert.equal(longUnlistedDescription("draw a 3-tier web app"), false);
    assert.equal(longUnlistedDescription("Client → App → Postgres"), false);
    assert.equal(parseArchitecture(KV), null);
    assert.equal(ideaSubject(KV)?.includes("KV"), true);
    const cache = componentsFromBrief(CACHE_NOTES);
    assert.ok(cache);
    assert.ok((cache?.nodes.length ?? 0) >= 5);
    assert.deepEqual(cache?.nodes, ["Clients", "Cache API", "Key Index", "Backing Store", "Peers"]);
    const queue = componentsFromBrief(QUEUE_NOTES);
    assert.deepEqual(queue?.nodes, ["Producers", "Broker", "Consumers", "Acknowledgements", "Retention"]);
    assert.ok(queue?.edges.every((edge) => edge.label.length > 0));
  });

  it("does not draw sentence scraps when no depth reading is available", () => {
    for (const prompt of [KV, QUEUE, KV.toLowerCase()]) {
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "clarify", prompt);
      assert.equal(drawn.xml, STARTER_XML, prompt);
      assert.match(drawn.decision.reply, /components/);
    }
  });

  it("keeps an explicit few-box ask, an N-tier stack, a named list, and a connector restyle", () => {
    const pair = content(assertClean(previewDemo("Draw two boxes: A and B", STARTER_XML).xml).nodes).map(
      (node) => node.label,
    );
    assert.deepEqual(pair, ["A", "B"]);

    const counted = content(assertClean(previewDemo("two boxes: A and B", STARTER_XML).xml).nodes).map((node) => node.label);
    assert.deepEqual(counted, ["A", "B"]);

    const tier = content(assertClean(previewDemo("draw a 3-tier web app", STARTER_XML).xml).nodes).map((node) => node.label);
    assert.deepEqual(tier, ["Client", "App", "Postgres"]);

    const chain = content(assertClean(previewDemo("Client → App → Postgres", STARTER_XML).xml).nodes).map(
      (node) => node.label,
    );
    assert.deepEqual(chain, ["Client", "App", "Postgres"]);

    const named = content(
      assertClean(previewDemo("Draw a subsystem of Client, API, and Postgres and its interactions", STARTER_XML).xml).nodes,
    ).map((node) => node.label);
    assert.deepEqual(named, ["Client", "API", "Postgres"]);

    const drawn = previewDemo("draw a 3-tier web app", STARTER_XML);
    const before = assessDiagram(drawn.xml);
    const restyled = previewDemo("make the connectors blue", drawn.xml);
    assert.equal(restyled.decision.intent, "style");
    const after = assessDiagram(restyled.xml);
    assert.deepEqual(
      after.nodes.map((node) => ({ label: node.label, x: node.x, y: node.y, width: node.width, height: node.height })),
      before.nodes.map((node) => ({ label: node.label, x: node.x, y: node.y, width: node.width, height: node.height })),
    );
    assert.ok(after.edges.every((edge) => edge.style.includes("strokeColor=#6c8ebf")));
  });

  it("draws one subject box when Jev reads the idea as high-level", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    let wiki = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        wiki += 1;
        return Response.json({ extract: CACHE_NOTES });
      }
      return Response.json({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "add_shape", confidence: 0.8 },
          needs_xml_edit: { type: "noul", noul: 0.9 },
          depth: { type: "choice", choice: "few", confidence: 0.8 },
          next: { type: "choice", choice: "apply", confidence: 0.8 },
          confirm: { type: "noul", noul: 0.8 },
          color: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: KV }],
      currentXml: STARTER_XML,
    });
    assert.equal(wiki, 0);
    assert.equal(result.intent, "add_shape");
    const labels = content(assertClean(result.updatedXml).nodes).map((node) => node.label);
    assert.equal(labels.length, 1);
    assert.match(labels[0] ?? "", /KV/);
    assert.equal(labels.includes("General Purpose"), false);
    assert.equal(labels.includes("Interactions"), false);
  });

  it("composes a detailed idea from topic notes after Jev says many", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        const extract = url.toLowerCase().includes("message") ? QUEUE_NOTES : CACHE_NOTES;
        return Response.json({ extract });
      }
      const request = JSON.parse(String(init?.body)) as { state?: string; questions?: Record<string, unknown> };
      assert.match(request.state ?? "", /Depth/);
      if (request.questions && "depth" in request.questions) {
        assert.match(String((request.questions.depth as { instructions?: string }).instructions ?? ""), /detailed/);
      }
      return Response.json({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "add_shape", confidence: 0.84 },
          needs_xml_edit: { type: "noul", noul: 0.91 },
          depth: { type: "choice", choice: "many", confidence: 0.86 },
          next: { type: "choice", choice: "apply", confidence: 0.8 },
          confirm: { type: "noul", noul: 0.8 },
          color: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;

    for (const [prompt, expected] of [
      [KV, ["Clients", "Cache API", "Key Index", "Backing Store", "Peers"]],
      [QUEUE, ["Producers", "Broker", "Consumers", "Acknowledgements", "Retention"]],
    ] as const) {
      const result = await runKevTurn({
        messages: [{ role: "user", content: prompt }],
        currentXml: STARTER_XML,
      });
      assert.equal(result.intent, "add_shape", prompt);
      const report = assertClean(result.updatedXml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.deepEqual(labels, [...expected], prompt);
      assert.equal(labels.includes("General Purpose"), false);
      assert.equal(labels.includes("Storage"), false);
      assert.equal(labels.includes("Interactions"), false);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), prompt);
      assert.ok(report.edges.length >= 4, prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      for (const node of content(report.nodes)) {
        const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
        assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${node.label} ${fill}`);
      }
    }

    const across = await runKevTurn({
      messages: [{ role: "user", content: `${KV} left to right` }],
      currentXml: STARTER_XML,
    });
    const row = assertClean(across.updatedXml);
    const boxes = content(row.nodes);
    const ordered = [...boxes].sort((left, right) => left.x - right.x);
    assert.ok((ordered[0]?.x ?? 0) < (ordered[ordered.length - 1]?.x ?? 0));
    assert.equal(boxes.length >= 5, true);
  });
});
