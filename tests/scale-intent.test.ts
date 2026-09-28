import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assessDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { PALETTE } from "../src/lib/drawio/styles";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { parseArchitecture } from "../src/lib/kev/plan";
import { DEPTH_INSTRUCTIONS, STRATEGY_BLOCK, compositionNextInstructions } from "../src/lib/kev/prompt-guide";
import { buildSystemPrompt } from "../src/lib/kev/prompt";
import { runKevTurn } from "../src/lib/kev/run";
import { extractNamedEntities } from "../src/lib/kev/entities";
import { isLimitInstruction, stripTrailingLimits } from "../src/lib/kev/plan";
import { topicLookupCandidates } from "../src/lib/kev/research";
import { architectureFromIdea, isScrapLabel } from "../src/lib/kev/invent";
import {
  componentsFromBrief,
  depthFromOpenAnswer,
  ideaSubject,
  longUnlistedDescription,
  OPEN_IDEA_REPLY,
  openIdeaDepthFollowUp,
} from "../src/lib/kev/scale";
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
      // Check before deepEqual: node:assert narrows labels to the expected literals.
      assert.equal(labels.includes("General Purpose"), false);
      assert.equal(labels.includes("Storage"), false);
      assert.equal(labels.includes("Interactions"), false);
      assert.deepEqual(labels, [...expected], prompt);
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

  it("does not draw leftover clause crumbs for rich paraphrases", () => {
    const prompts = [
      "Walk through notification leaves and its interactions",
      "Walk through how notification leaves get to workers in a delivery subsystem and its interactions",
      "Picture a shared lookup of cached values beside services and its interactions",
      "Trace the interacting parts of a general purpose key value cache",
      "Describe how producers, a broker, workers, an inbox, and a push path interact in message delivery",
    ];
    for (const prompt of prompts) {
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "clarify", `${prompt} → ${drawn.decision.reply}`);
      assert.equal(drawn.xml, STARTER_XML, prompt);
      assert.match(drawn.decision.reply, /high-level|detailed|components/, prompt);
      assert.deepEqual(content(assessDiagram(drawn.xml).nodes).map((node) => node.label), [], prompt);
    }
  });

  it("keeps few-box paraphrases small and does not mint a limiter", () => {
    const prompts = [
      "Only draw Ingress and Egress",
      "Draw only Ingress and Egress",
      "two boxes: Ingress and Egress",
      "Ingress → Egress",
    ];
    for (const prompt of prompts) {
      const labels = content(assertClean(previewDemo(prompt, STARTER_XML).xml).nodes).map((node) => node.label);
      assert.deepEqual(labels, ["Ingress", "Egress"], prompt);
      assert.equal(labels.includes("Only"), false, prompt);
    }
  });

  it("researches a rich paraphrase when depth is many and stays blank when depth is unknown", async () => {
    const prompts = [
      "Walk through notification leaves and its interactions",
      "Picture how a shared lookup sits beside services and its interactions",
    ];
    const notes =
      "Callers send to the hub. The hub delivers to handlers. Handlers write receipts. The hub persists to a log.";
    for (const prompt of prompts) {
      const blank = previewDemo(prompt, STARTER_XML);
      assert.equal(blank.decision.intent, "clarify", prompt);
      assert.equal(blank.xml, STARTER_XML, prompt);
    }

    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async () => {
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
        extract: notes,
      });
    }) as typeof fetch;

    for (const prompt of prompts) {
      const result = await runKevTurn({
        messages: [{ role: "user", content: prompt }],
        currentXml: STARTER_XML,
      });
      assert.equal(result.intent, "add_shape", prompt);
      const report = assertClean(result.updatedXml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.length >= 4, `${prompt} → ${labels.join(", ")}`);
      assert.equal(labels.includes("Walk"), false, prompt);
      assert.equal(labels.includes("Notification Leaves"), false, prompt);
      assert.equal(labels.includes("Picture"), false, prompt);
      assert.equal(labels.includes("General Purpose"), false, prompt);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), prompt);
      assert.ok(report.edges.length >= 3, prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      for (const node of content(report.nodes)) {
        const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
        assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${node.label} ${fill}`);
      }
    }
  });

  it("strips trailing limit phrases and does not mint them as boxes", () => {
    const prompts: Array<[string, string[]]> = [
      ["only draw Harbor and Pier — add nothing beyond that pair", ["Harbor", "Pier"]],
      ["Only draw Harbor and Pier — Add Nothing Beyond That Pair", ["Harbor", "Pier"]],
      ["Draw Harbor and Pier, Add Nothing Beyond That Pair", ["Harbor", "Pier"]],
      ["Draw Harbor and Pier — just those two", ["Harbor", "Pier"]],
      ["Draw Source and Sink — nothing else", ["Source", "Sink"]],
      ["two boxes: Source and Sink, nothing else", ["Source", "Sink"]],
      ["Source → Sink — add nothing beyond that pair", ["Source", "Sink"]],
      ["Draw Source and Sink — Just Those Two", ["Source", "Sink"]],
    ];
    for (const [prompt, wanted] of prompts) {
      assert.equal(isLimitInstruction("Add Nothing Beyond That Pair"), true, prompt);
      assert.equal(isLimitInstruction("Place Order"), false, prompt);
      assert.equal(stripTrailingLimits(prompt).toLowerCase().includes("nothing"), false, prompt);
      const labels = content(assertClean(previewDemo(prompt, STARTER_XML).xml).nodes).map((node) => node.label);
      assert.deepEqual(labels, wanted, prompt);
      assert.equal(
        labels.some((label) => /nothing|beyond|else|those|pair/i.test(label)),
        false,
        prompt,
      );
    }

    const stages = "checkout workflow: Place Order, Pack Carton, Ship Parcel — Add Nothing Beyond That Pair";
    const stageLabels = content(assertClean(previewDemo(stages, STARTER_XML).xml).nodes).map((node) => node.label);
    assert.deepEqual(stageLabels, ["Place Order", "Pack Carton", "Ship Parcel"]);
    assert.equal(extractNamedEntities(stages).some((entity) => entity.label === "Place Order"), true);
    assert.equal(extractNamedEntities(stages).some((entity) => /nothing beyond/i.test(entity.label)), false);
  });

  it("asks for depth when every topic brief is unusable, and composes a shorter brief when one names parts", async () => {
    const memo = "Walk through a hot-key memo fabric and its interactions";
    const fabric = "Draw a subsystem of harbor pier delivery fabric and its interactions";
    const blank = previewDemo(memo, STARTER_XML);
    assert.equal(blank.decision.intent, "clarify");
    assert.equal(blank.xml, STARTER_XML);
    assert.equal(blank.decision.reply, OPEN_IDEA_REPLY);
    assert.doesNotMatch(blank.decision.reply, /topic notes did not name/);

    const subject = ideaSubject(fabric);
    assert.ok(subject);
    const candidates = topicLookupCandidates(subject ?? "");
    assert.ok(candidates.length >= 2);
    assert.ok((candidates[1]?.length ?? 0) < (candidates[0]?.length ?? 0));

    const unusable = "A hot-key memo fabric is a single coastal metaphor with no listed machinery.";
    const usable =
      "Callers send to the memo. The memo delivers to the pier. The pier writes receipts. The memo persists to a log.";
    assert.equal(componentsFromBrief(unusable), null);
    assert.ok((componentsFromBrief(usable)?.nodes.length ?? 0) >= 4);

    process.env.KEV_BASE_URL = "http://kev.local";
    const titles: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/page/summary/")) {
        const title = decodeURIComponent(url.split("/page/summary/")[1] ?? "").replace(/_/g, " ");
        titles.push(title);
        const extract = title === candidates[0] ? unusable : usable;
        return Response.json({ extract });
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

    const composed = await runKevTurn({
      messages: [{ role: "user", content: fabric }],
      currentXml: STARTER_XML,
    });
    assert.equal(titles[0], candidates[0]);
    assert.ok(titles.length >= 2);
    assert.notEqual(titles.at(-1), candidates[0]);
    assert.equal(composed.intent, "add_shape");
    assert.doesNotMatch(composed.reply, /topic notes did not name/);
    const report = assertClean(composed.updatedXml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.ok(labels.length >= 4, labels.join(", "));
    assert.equal(labels.includes("Add Nothing Beyond That Pair"), false);
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    assert.ok(report.edges.length >= 3);
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
    for (const node of content(report.nodes)) {
      const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
      assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${node.label} ${fill}`);
    }

    titles.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/page/summary/")) {
        const title = decodeURIComponent(url.split("/page/summary/")[1] ?? "").replace(/_/g, " ");
        titles.push(title);
        return Response.json({ extract: unusable });
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

    const stalled = await runKevTurn({
      messages: [{ role: "user", content: memo }],
      currentXml: STARTER_XML,
    });
    assert.ok(titles.length >= 2);
    assert.equal(stalled.intent, "clarify");
    assert.equal(stalled.updatedXml, STARTER_XML);
    assert.equal(stalled.reply, OPEN_IDEA_REPLY);
    assert.doesNotMatch(stalled.reply, /topic notes did not name/);

    titles.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        titles.push(url);
        return Response.json({ extract: usable });
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
    const high = await runKevTurn({
      messages: [{ role: "user", content: memo }],
      currentXml: STARTER_XML,
    });
    assert.equal(titles.length, 0);
    assert.equal(high.intent, "add_shape");
    const highLabels = content(assertClean(high.updatedXml).nodes).map((node) => node.label);
    assert.equal(highLabels.length, 1);
    assert.match(highLabels[0] ?? "", /Memo/);
    assert.doesNotMatch(high.reply, /topic notes did not name/);
  });
});

const STORAGE_IDEA =
  "Draw a distributed storage system that uses ibverbs and io uring for zero syscall zero copy data transfer";
const STORAGE_ANSWER = "Detailed diagram, you give the names";
const STORAGE_NOTES =
  "Applications send to the storage nodes. The storage nodes replicate to the peers. The peers persist to the journal. The journal notifies the applications.";

describe("open idea depth follow-up", { concurrency: 1 }, () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  it("treats a depth answer as a continuation only after the open-idea question", () => {
    assert.equal(depthFromOpenAnswer(STORAGE_ANSWER), "many");
    assert.equal(depthFromOpenAnswer("you name the boxes"), "many");
    assert.equal(depthFromOpenAnswer("you give the names"), "many");
    assert.equal(depthFromOpenAnswer("Detailed diagram — invent the component names yourself"), "many");
    assert.equal(depthFromOpenAnswer("detailed, pick the boxes for me"), "many");
    assert.equal(depthFromOpenAnswer("go detailed and name them"), "many");
    assert.equal(depthFromOpenAnswer("invent the component names yourself"), "many");
    assert.equal(depthFromOpenAnswer("pick the boxes for me"), "many");
    assert.equal(depthFromOpenAnswer("High-level sketch"), "few");
    assert.equal(depthFromOpenAnswer("High-level, you name the boxes"), "few");
    assert.equal(depthFromOpenAnswer("Draw it in detail"), "many");
    assert.equal(depthFromOpenAnswer("Draw a high-level sketch"), "few");
    assert.equal(depthFromOpenAnswer("Draw a detailed payment system"), null);
    assert.equal(depthFromOpenAnswer("draw"), null);
    assert.equal(depthFromOpenAnswer("three tier web app"), null);
    assert.equal(depthFromOpenAnswer("redraw this from scratch and make it more complex"), null);
    assert.equal(depthFromOpenAnswer("give the boxes a color"), null);
    assert.equal(depthFromOpenAnswer("You figure out names"), "many");
    assert.equal(depthFromOpenAnswer("figure out the names"), "many");
    assert.equal(depthFromOpenAnswer("you figure it out"), "many");
    assert.equal(depthFromOpenAnswer("you pick"), "many");
    assert.equal(depthFromOpenAnswer("you figure out the color"), null);

    const transcript = [
      { role: "user", content: STORAGE_IDEA },
      { role: "assistant", content: OPEN_IDEA_REPLY },
      { role: "user", content: STORAGE_ANSWER },
    ];
    assert.deepEqual(openIdeaDepthFollowUp(transcript), { idea: STORAGE_IDEA, depth: "many" });
    assert.equal(openIdeaDepthFollowUp([{ role: "user", content: STORAGE_ANSWER }]), null);
    const alone = previewDemo(STORAGE_ANSWER, STARTER_XML);
    assert.equal(alone.decision.reply, "Describe a diagram change.");
    assert.equal(alone.xml, STARTER_XML);
    const invented = "Detailed diagram — invent the component names yourself";
    const inventedAlone = previewDemo(invented, STARTER_XML);
    assert.equal(inventedAlone.decision.reply, "Describe a diagram change.");
    assert.equal(inventedAlone.xml, STARTER_XML);
    assert.equal(
      openIdeaDepthFollowUp([
        { role: "user", content: STORAGE_IDEA },
        { role: "assistant", content: OPEN_IDEA_REPLY },
        { role: "user", content: invented },
      ])?.depth,
      "many",
    );

    const roles = architectureFromIdea(STORAGE_IDEA);
    const roleLabels = roles?.nodes.map((node) => node.label) ?? [];
    assert.ok(roleLabels.length >= 4, roleLabels.join(", "));
    for (const scrap of [
      "Distributed Storage System",
      "Ibverbs",
      "Io Uring",
      "Zero Syscall",
      "Zero Copy",
      "Data Transfer",
      "RDMA Transport",
      "io_uring Path",
      "Registered Buffers",
      "Metadata Service",
      "Submission Path",
      "Completion Path",
    ]) {
      assert.equal(roleLabels.includes(scrap), false, scrap);
    }
    for (const label of roleLabels) assert.equal(isScrapLabel(label), false, label);
    assert.ok(roleLabels.includes("Clients"), roleLabels.join(", "));
    assert.ok(roleLabels.some((label) => /Storage/.test(label)), roleLabels.join(", "));
    assert.ok((roles?.edges.length ?? 0) >= 3);
    assert.ok(roles?.edges.every((edge) => edge.label.length > 0));

    assert.equal(isScrapLabel("From the kiln"), true);
    assert.equal(isScrapLabel("slow-while-drying"), true);
    assert.equal(isScrapLabel("Retries"), true);
    assert.equal(isScrapLabel("Baffles"), false);
    assert.equal(isScrapLabel("Flue"), false);
    assert.equal(isScrapLabel("Encrypted"), true);
    assert.equal(isScrapLabel("Latency"), true);
    assert.equal(isScrapLabel("Zero Copy"), true);

    const kiln = architectureFromIdea("Draw a hillside kiln that uses baffles and a flue for slow even drying");
    const kilnLabels = kiln?.nodes.map((node) => node.label) ?? [];
    assert.ok(kilnLabels.length >= 4, kilnLabels.join(", "));
    assert.equal(kilnLabels.includes("Hillside Kiln"), false);
    assert.equal(kilnLabels.includes("Slow Even Drying"), false);
    assert.ok(kilnLabels.includes("Clients"), kilnLabels.join(", "));
    assert.ok(kilnLabels.some((label) => /Kiln/.test(label)), kilnLabels.join(", "));
    assert.ok(kilnLabels.some((label) => /Baffle/.test(label)), kilnLabels.join(", "));
    assert.ok(kilnLabels.some((label) => /Flue/.test(label)), kilnLabels.join(", "));
    assert.ok(kiln?.edges.some((edge) => /Slow|Drying|Even/.test(edge.label)), kiln?.edges.map((edge) => edge.label).join(", "));

    const qualities = architectureFromIdea(
      "Draw a hillside kiln that uses baffles and a flue with low latency and encrypted drying",
    );
    const qualityLabels = qualities?.nodes.map((node) => node.label) ?? [];
    for (const scrap of ["Low Latency", "Latency", "Encrypted", "Encrypted Drying"]) {
      assert.equal(qualityLabels.includes(scrap), false, scrap);
    }
    assert.ok(qualityLabels.some((label) => /Baffle/.test(label)), qualityLabels.join(", "));
    assert.ok(qualityLabels.some((label) => /Flue/.test(label)), qualityLabels.join(", "));
    const qualityEdges = qualities?.edges.map((edge) => edge.label).join(" | ") ?? "";
    assert.match(qualityEdges, /Latency/i);
    assert.match(qualityEdges, /Encrypted/i);

    const absence = architectureFromIdea(
      "Draw a hillside kiln that uses baffles and a flue with zero copy and zero syscalls",
    );
    const absenceLabels = absence?.nodes.map((node) => node.label) ?? [];
    for (const scrap of ["Zero Copy", "Zero Syscall", "Zero Syscalls"]) {
      assert.equal(absenceLabels.includes(scrap), false, scrap);
    }
    assert.ok(absenceLabels.some((label) => /Baffle/.test(label)), absenceLabels.join(", "));
    assert.match(absence?.edges.map((edge) => edge.label).join(" | ") ?? "", /Zero Copy|Zero Syscall/i);
  });

  it("composes a detailed diagram when the user answers the open-idea question", async () => {
    const messages = [
      { role: "user" as const, content: STORAGE_IDEA },
      { role: "assistant" as const, content: OPEN_IDEA_REPLY },
      { role: "user" as const, content: STORAGE_ANSWER },
    ];

    let wiki = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        wiki += 1;
        return Response.json({ extract: STORAGE_NOTES });
      }
      return Response.json({ error: "system one should not run" }, { status: 500 });
    }) as typeof fetch;

    const demo = await runKevTurn({ messages, currentXml: STARTER_XML });
    assert.equal(demo.mode, "demo");
    assert.ok(wiki >= 1);
    assert.equal(demo.intent, "add_shape");
    assert.doesNotMatch(demo.reply, /Describe a diagram change/);
    assert.notEqual(demo.updatedXml, STARTER_XML);
    const demoReport = assertClean(demo.updatedXml);
    const demoLabels = content(demoReport.nodes).map((node) => node.label);
    assert.ok(demoLabels.length >= 4, demoLabels.join(", "));
    assert.ok(demoLabels.includes("Applications"), demoLabels.join(", "));
    assert.ok(demoLabels.includes("Journal"), demoLabels.join(", "));
    assert.ok(demoReport.nodes.some((node) => node.role === "cluster"));
    assert.ok(demoReport.edges.length >= 3);
    assert.ok(demoReport.edges.every((edge) => edge.label.length > 0));
    for (const node of content(demoReport.nodes)) {
      const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
      assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${node.label} ${fill}`);
    }

    process.env.KEV_BASE_URL = "http://kev.local";
    const states: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) return Response.json({ extract: STORAGE_NOTES });
      const request = JSON.parse(String(init?.body)) as { state?: string };
      states.push(request.state ?? "");
      return Response.json({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "clarify", confidence: 0.3 },
          needs_xml_edit: { type: "noul", noul: 0.1 },
          depth: { type: "choice", choice: "few", confidence: 0.4 },
          next: { type: "choice", choice: "clarify", confidence: 0.2 },
          confirm: { type: "noul", noul: 0.1 },
        },
      });
    }) as typeof fetch;

    const kev = await runKevTurn({ messages, currentXml: STARTER_XML });
    assert.equal(kev.mode, "kev");
    assert.match(
      states[0] ?? "",
      /Conversation:\nUser: Draw a distributed storage system that uses ibverbs[\s\S]*Assistant: That idea needs its own components[\s\S]*User: Detailed diagram, you give the names/,
    );
    assert.match(states[0] ?? "", /User message:\nDetailed diagram, you give the names/);
    assert.equal(kev.intent, "add_shape");
    assert.doesNotMatch(kev.reply, /Describe a diagram change/);
    const kevLabels = content(assertClean(kev.updatedXml).nodes).map((node) => node.label);
    assert.ok(kevLabels.length >= 4, kevLabels.join(", "));
    assert.deepEqual(kevLabels, demoLabels);
  });

  it("keeps bare draw, a thin three-tier ask, and a wipe on the existing guards", async () => {
    const bare = await runKevTurn({
      messages: [
        { role: "user", content: STORAGE_IDEA },
        { role: "assistant", content: OPEN_IDEA_REPLY },
        { role: "user", content: "draw" },
      ],
      currentXml: STARTER_XML,
    });
    assert.equal(bare.intent, "clarify");
    assert.match(bare.reply, /What should I draw/);
    assert.equal(bare.updatedXml, STARTER_XML);

    const tier = await runKevTurn({
      messages: [
        { role: "user", content: STORAGE_IDEA },
        { role: "assistant", content: OPEN_IDEA_REPLY },
        { role: "user", content: "three tier web app" },
      ],
      currentXml: STARTER_XML,
    });
    assert.equal(tier.intent, "add_shape");
    assert.deepEqual(content(assertClean(tier.updatedXml).nodes).map((node) => node.label), [
      "Client",
      "App",
      "Postgres",
    ]);

    const base = previewDemo("draw a 3 tier web app", STARTER_XML);
    const before = content(assessDiagram(base.xml).nodes).map((node) => node.label);
    const replaced = await runKevTurn({
      messages: [
        { role: "user", content: STORAGE_IDEA },
        { role: "assistant", content: OPEN_IDEA_REPLY },
        { role: "user", content: "redraw this from scratch and make it more complex" },
      ],
      currentXml: base.xml,
    });
    const after = content(assessDiagram(replaced.updatedXml).nodes).map((node) => node.label);
    for (const kept of before) assert.ok(after.includes(kept), kept);
    assert.equal(summarizeDiagram(replaced.updatedXml).vertices.length >= summarizeDiagram(base.xml).vertices.length, true);
  });

  it("composes the earlier idea when a detailed naming paraphrase has no usable notes", async () => {
    const answers = [
      "Detailed diagram — invent the component names yourself",
      "detailed, pick the boxes for me",
      "go detailed and name them",
    ];
    globalThis.fetch = (async () =>
      Response.json({
        extract: "A clustered file system is a file system which is shared by being simultaneously mounted on multiple servers.",
      })) as typeof fetch;

    for (const answer of answers) {
      const result = await runKevTurn({
        messages: [
          { role: "user", content: STORAGE_IDEA },
          { role: "assistant", content: OPEN_IDEA_REPLY },
          { role: "user", content: answer },
        ],
        currentXml: STARTER_XML,
      });
      assert.equal(result.intent, "add_shape", answer);
      assert.notEqual(result.reply, OPEN_IDEA_REPLY, answer);
      assert.doesNotMatch(result.reply, /Describe a diagram change/, answer);
      assert.notEqual(result.updatedXml, STARTER_XML, answer);
      const report = assertClean(result.updatedXml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.length >= 4, `${answer}: ${labels.join(", ")}`);
      for (const scrap of [
        "Distributed Storage System",
        "Ibverbs",
        "Io Uring",
        "Zero Syscall",
        "Zero Copy",
        "Data Transfer",
        "RDMA Transport",
        "Registered Buffers",
        "Metadata Service",
      ]) {
        assert.equal(labels.includes(scrap), false, `${answer}: ${scrap}`);
      }
      assert.ok(labels.includes("Clients"), `${answer}: ${labels.join(", ")}`);
      assert.ok(labels.some((label) => /Storage/.test(label)), answer);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), answer);
      assert.ok(report.edges.length >= 3, answer);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), answer);
      for (const node of content(report.nodes)) {
        const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
        assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${answer} ${node.label} ${fill}`);
      }
    }

    const head = topicLookupCandidates(ideaSubject(STORAGE_IDEA) ?? "");
    assert.equal(head[0], "Distributed Storage System");
    assert.equal(head.some((title) => /ibverbs/i.test(title)), false);
  });

  it("draws one subject box for a high-level answer and does not look up topic notes", async () => {
    let wiki = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("wikipedia.org")) wiki += 1;
      return Response.json({ extract: STORAGE_NOTES });
    }) as typeof fetch;
    const result = await runKevTurn({
      messages: [
        { role: "user", content: STORAGE_IDEA },
        { role: "assistant", content: OPEN_IDEA_REPLY },
        { role: "user", content: "High-level sketch" },
      ],
      currentXml: STARTER_XML,
    });
    assert.equal(wiki, 0);
    assert.equal(result.intent, "add_shape");
    assert.doesNotMatch(result.reply, /Describe a diagram change/);
    const labels = content(assertClean(result.updatedXml).nodes).map((node) => node.label);
    assert.equal(labels.length, 1);
    assert.match(labels[0] ?? "", /Storage/);
  });

  it("invents roles after “you figure out names” and does not re-ask or scrap the sentence", async () => {
    globalThis.fetch = (async () => Response.json({ extract: UNUSABLE_NOTES })) as typeof fetch;
    const cases = [
      {
        idea: STORAGE_IDEA,
        answer: "You figure out names",
        forbid: ["Distributed Storage System", "Ibverbs", "Io Uring", "Zero Syscall", "Zero Copy", "Data Transfer", "RDMA Transport", "Registered Buffers", "Metadata Service"],
        want: [/Clients/, /Storage/],
      },
      {
        idea: "Draw a multi-pop edge cache that serves from origin with stale-while-revalidate",
        answer: "you pick",
        forbid: ["Multi-pop Edge Cache", "From Origin", "Stale-while-revalidate", "Origins", "Placement"],
        want: [/Clients/, /Cache/, /Origin/],
        edge: /stale-while-revalidate/i,
      },
      {
        idea: "Draw a notification mesh that fans alerts across regions with retries",
        answer: "figure out the names",
        forbid: ["Notification Mesh", "Alerts", "Retries", "Regions"],
        want: [/Clients/, /Notification/],
        edge: /Retries/,
      },
      {
        idea: "Draw a hillside kiln that uses baffles and a flue for slow even drying",
        answer: "you figure it out",
        forbid: ["Hillside Kiln", "Slow Even Drying", "Even Drying"],
        want: [/Clients/, /Kiln/, /Baffle/, /Flue/],
        edge: /Slow|Drying|Even/,
      },
    ];
    for (const item of cases) {
      const result = await runKevTurn({
        messages: [
          { role: "user", content: item.idea },
          { role: "assistant", content: OPEN_IDEA_REPLY },
          { role: "user", content: item.answer },
        ],
        currentXml: STARTER_XML,
      });
      assert.equal(result.intent, "add_shape", item.answer);
      assert.notEqual(result.reply, OPEN_IDEA_REPLY, item.answer);
      const report = assertClean(result.updatedXml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.length >= 4, `${item.answer}: ${labels.join(", ")}`);
      assert.equal(labels.length === 1, false, labels.join(", "));
      for (const scrap of item.forbid) assert.equal(labels.includes(scrap), false, `${item.answer}: ${scrap} in ${labels.join(", ")}`);
      for (const pattern of item.want) assert.match(labels.join(" | "), pattern, labels.join(", "));
      assert.ok(report.nodes.some((node) => node.role === "cluster"), item.answer);
      assert.ok(report.edges.length >= 3 && report.edges.every((edge) => edge.label.length > 0), item.answer);
      if ("edge" in item && item.edge) {
        assert.match(report.edges.map((edge) => edge.label).join(" | "), item.edge, item.answer);
      }
      const groups = new Set(report.nodes.filter((node) => node.role === "cluster").map((node) => node.label));
      assert.ok(groups.size >= 3, `${item.answer}: ${[...groups].join(", ")}`);
    }
  });
});

const SPARSE_IDEAS = [
  "Picture a GPU inference farm that batches requests through a shared KV cache and a token ring so GPUs stay saturated — show the moving parts",
  "Picture a harbor crane yard that swings loads through a shared boom lock and a tag line so hulls stay steady — show the moving parts",
];

const INVENT_ANSWERS = [
  "Make it detailed and invent all the component names yourself",
  "Go detailed — pick the box names for me",
  "Detailed please — you give every box a name",
];

const UNUSABLE_NOTES = "A short note with no listed machinery and no interacting parts to draw.";

function assertDetailed(xml: string, answer: string) {
  const report = assertClean(xml);
  const labels = content(report.nodes).map((node) => node.label);
  assert.ok(labels.length >= 4, `${answer}: ${labels.join(", ")}`);
  assert.ok(report.nodes.some((node) => node.role === "cluster"), answer);
  assert.ok(report.edges.length >= 3, answer);
  assert.ok(report.edges.every((edge) => edge.label.length > 0), answer);
  for (const node of content(report.nodes)) {
    const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
    assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${answer} ${node.label} ${fill}`);
  }
  return labels;
}

describe("depth after a sparse open picture", { concurrency: 1 }, () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  it("composes a detailed diagram from the earlier idea when the first turn already drew scraps", async () => {
    globalThis.fetch = (async () => Response.json({ extract: UNUSABLE_NOTES })) as typeof fetch;

    let sawSparse = false;
    for (const idea of SPARSE_IDEAS) {
      const seed = previewDemo(idea, STARTER_XML);
      const seedLabels = content(assessDiagram(seed.xml).nodes).map((node) => node.label);
      const sparse = seed.decision.intent === "add_shape" && seedLabels.length < 4;
      const clarified = seed.decision.intent === "clarify" && seed.decision.reply === OPEN_IDEA_REPLY;
      assert.equal(sparse || clarified, true, `${idea} → ${seed.decision.intent} ${seedLabels.join(", ")}`);
      if (sparse) sawSparse = true;
      for (const answer of INVENT_ANSWERS) {
        const result = await runKevTurn({
          messages: [
            { role: "user", content: idea },
            { role: "assistant", content: seed.decision.reply },
            { role: "user", content: answer },
          ],
          currentXml: seed.xml,
        });
        assert.equal(result.intent, "add_shape", `${idea} / ${answer}`);
        assert.notEqual(result.reply, OPEN_IDEA_REPLY, answer);
        assert.doesNotMatch(result.reply, /Describe a diagram change|What should the new shape be called|Name the shape to edit/, answer);
        assert.notEqual(result.updatedXml, seed.xml, answer);
        const labels = assertDetailed(result.updatedXml, `${idea} / ${answer}`);
        assert.equal(
          labels.some((label) => /GPU|KV|Harbor|Boom|Cache|Ring|Lock|Line|Hull/i.test(label)),
          true,
          labels.join(", "),
        );
      }
    }
    assert.equal(sawSparse, true);
  });

  it("keeps composing when a later naming line follows a shape-name miss in the same chat", async () => {
    globalThis.fetch = (async () => Response.json({ extract: UNUSABLE_NOTES })) as typeof fetch;
    const idea = SPARSE_IDEAS[0]!;
    const seed = previewDemo(idea, STARTER_XML);
    const result = await runKevTurn({
      messages: [
        { role: "user", content: idea },
        { role: "assistant", content: seed.decision.reply },
        { role: "user", content: INVENT_ANSWERS[0]! },
        { role: "assistant", content: "What should the new shape be called?" },
        { role: "user", content: INVENT_ANSWERS[1]! },
      ],
      currentXml: seed.xml,
    });
    assert.equal(result.intent, "add_shape");
    assert.doesNotMatch(result.reply, /What should the new shape be called|Name the shape to edit|Describe a diagram change/);
    assertDetailed(result.updatedXml, INVENT_ANSWERS[1]!);
  });

  it("uses topic notes when they name the parts, including after a sparse drawing", async () => {
    const idea = SPARSE_IDEAS[0]!;
    const seed = previewDemo(idea, STARTER_XML);
    globalThis.fetch = (async () =>
      Response.json({
        extract:
          "Dispatchers send to the workers. The workers read the cache. The cache writes to the store. The store replicates to the peers.",
      })) as typeof fetch;
    const result = await runKevTurn({
      messages: [
        { role: "user", content: idea },
        { role: "assistant", content: seed.decision.reply },
        { role: "user", content: "Make it detailed and invent all the component names yourself" },
      ],
      currentXml: seed.xml,
    });
    const labels = assertDetailed(result.updatedXml, idea);
    assert.ok(labels.includes("Workers"), labels.join(", "));
    assert.ok(labels.includes("Cache"), labels.join(", "));
    assert.ok(labels.includes("Peers"), labels.join(", "));
  });

  it("collapses a sparse drawing to one subject box for a high-level answer", async () => {
    let wiki = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("wikipedia.org")) wiki += 1;
      return Response.json({ extract: UNUSABLE_NOTES });
    }) as typeof fetch;
    const idea = SPARSE_IDEAS[0]!;
    const seed = previewDemo(idea, STARTER_XML);
    const result = await runKevTurn({
      messages: [
        { role: "user", content: idea },
        { role: "assistant", content: seed.decision.reply },
        { role: "user", content: "Just the high-level overview" },
      ],
      currentXml: seed.xml,
    });
    assert.equal(wiki, 0);
    assert.equal(result.intent, "add_shape");
    assert.doesNotMatch(result.reply, /Name the shapes and the edit you want|Describe a diagram change/);
    const labels = content(assertClean(result.updatedXml).nodes).map((node) => node.label);
    assert.equal(labels.length, 1);
    assert.match(labels[0] ?? "", /Inference|Farm|GPU/);
  });

  it("still soft-fails a detailed naming sentence that has no earlier idea", () => {
    for (const answer of INVENT_ANSWERS) {
      const alone = previewDemo(answer, STARTER_XML);
      assert.equal(alone.decision.reply, "Describe a diagram change.", answer);
      assert.equal(alone.xml, STARTER_XML, answer);
    }
  });

  it("leaves bare draw, a thin three-tier ask, and a wipe alone after a sparse drawing", async () => {
    const idea = SPARSE_IDEAS[0]!;
    const seed = previewDemo(idea, STARTER_XML);
    const history = [
      { role: "user" as const, content: idea },
      { role: "assistant" as const, content: seed.decision.reply },
    ];

    const bare = await runKevTurn({
      messages: [...history, { role: "user", content: "draw" }],
      currentXml: seed.xml,
    });
    assert.equal(bare.intent, "clarify");
    assert.match(bare.reply, /What should I draw/);
    assert.equal(bare.updatedXml, seed.xml);

    const tier = await runKevTurn({
      messages: [...history, { role: "user", content: "three tier web app" }],
      currentXml: seed.xml,
    });
    const tierLabels = content(assertClean(tier.updatedXml).nodes).map((node) => node.label);
    assert.ok(tierLabels.includes("Client") && tierLabels.includes("App") && tierLabels.includes("Postgres"), tierLabels.join(", "));

    const before = content(assessDiagram(seed.xml).nodes).map((node) => node.label);
    const replaced = await runKevTurn({
      messages: [...history, { role: "user", content: "redraw this from scratch and make it more complex" }],
      currentXml: seed.xml,
    });
    const after = content(assessDiagram(replaced.updatedXml).nodes).map((node) => node.label);
    for (const kept of before) assert.ok(after.includes(kept), kept);
  });

  it("composes the earlier idea when Kev would otherwise ask for a shape name", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    const idea = SPARSE_IDEAS[0]!;
    const seed = previewDemo(idea, STARTER_XML);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) return Response.json({ extract: UNUSABLE_NOTES });
      return Response.json({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "add_shape", confidence: 0.4 },
          needs_xml_edit: { type: "noul", noul: 0.2 },
          depth: { type: "choice", choice: "few", confidence: 0.3 },
          shape: { type: "choice", choice: "none" },
          next: { type: "choice", choice: "clarify", confidence: 0.2 },
          confirm: { type: "noul", noul: 0.1 },
        },
      });
    }) as typeof fetch;
    const result = await runKevTurn({
      messages: [
        { role: "user", content: idea },
        { role: "assistant", content: seed.decision.reply },
        { role: "user", content: "Detailed please — you give every box a name" },
      ],
      currentXml: seed.xml,
    });
    assert.equal(result.mode, "kev");
    assert.equal(result.intent, "add_shape");
    assert.doesNotMatch(result.reply, /What should the new shape be called|Name the shape to edit|Describe a diagram change/);
    assert.notEqual(result.reply, OPEN_IDEA_REPLY);
    assertDetailed(result.updatedXml, idea);
  });
});

const LAYOUT_OPEN_ASKS = [
  "Lay out an edge CDN that fans origin pulls through regional POPs with stale-while-revalidate so origins stay cool — show the moving parts",
  "Lay out a packet ferry that hops sealed crates through regional sheds with stale manifests so docks stay quiet — show the moving parts",
  "Arrange a harbor crane yard that swings loads through a shared boom lock and a tag line so hulls stay steady — show the moving parts",
];

describe("layout-led open ask on a blank page", { concurrency: 1 }, () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  it("asks for depth instead of a shape name or a reflow", async () => {
    for (const idea of LAYOUT_OPEN_ASKS) {
      const drawn = previewDemo(idea, STARTER_XML);
      assert.equal(drawn.decision.intent, "clarify", idea);
      assert.equal(drawn.decision.reply, OPEN_IDEA_REPLY, idea);
      assert.equal(drawn.xml, STARTER_XML, idea);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called|Name the shape to edit|Reflowed/, idea);
    }

    const reflow = previewDemo("Lay the diagram out vertically", SEEDED_XML);
    assert.equal(reflow.decision.intent, "layout");
    assert.match(reflow.decision.reply, /Reflowed/);
    const xs = summarizeDiagram(reflow.xml).vertices.map((vertex) => vertex.x);
    assert.equal(new Set(xs).size, 1);
  });

  it("keeps asking when Kev reads the open ask as a nameless add, even at high-level depth", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    const idea = LAYOUT_OPEN_ASKS[0]!;
    for (const depth of ["many", "few"] as const) {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("wikipedia.org")) return Response.json({ extract: UNUSABLE_NOTES });
        return Response.json({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "add_shape", confidence: 0.86 },
            needs_xml_edit: { type: "noul", noul: 0.9 },
            depth: { type: "choice", choice: depth, confidence: 0.8 },
            shape: { type: "choice", choice: "none" },
            next: { type: "choice", choice: "apply", confidence: 0.7 },
            confirm: { type: "noul", noul: 0.4 },
          },
        });
      }) as typeof fetch;
      const result = await runKevTurn({
        messages: [{ role: "user", content: idea }],
        currentXml: STARTER_XML,
      });
      assert.equal(result.mode, "kev", depth);
      assert.equal(result.intent, "clarify", depth);
      assert.equal(result.reply, OPEN_IDEA_REPLY, depth);
      assert.equal(result.updatedXml, STARTER_XML, depth);
      assert.doesNotMatch(result.reply, /What should the new shape be called|Name the shape to edit|Describe a diagram change/, depth);
    }
  });

  it("composes the earlier idea when invent, pick, or give follows a shape-name miss on blank", async () => {
    globalThis.fetch = (async () => Response.json({ extract: UNUSABLE_NOTES })) as typeof fetch;
    for (const idea of LAYOUT_OPEN_ASKS) {
      for (const answer of INVENT_ANSWERS) {
        const result = await runKevTurn({
          messages: [
            { role: "user", content: idea },
            { role: "assistant", content: "What should the new shape be called?" },
            { role: "user", content: answer },
          ],
          currentXml: STARTER_XML,
        });
        assert.equal(result.intent, "add_shape", `${idea} / ${answer}`);
        assert.notEqual(result.reply, OPEN_IDEA_REPLY, answer);
        assert.doesNotMatch(
          result.reply,
          /What should the new shape be called|Name the shape to edit|Describe a diagram change|Name the shapes and the edit/,
          answer,
        );
        assert.notEqual(result.updatedXml, STARTER_XML, answer);
        const labels = assertDetailed(result.updatedXml, `${idea} / ${answer}`);
        assert.equal(
          labels.some((label) => /^(?:Lay Out|Arrange)$/i.test(label)),
          false,
          labels.join(", "),
        );
        assert.equal(
          labels.some((label) => /CDN|POP|Ferry|Shed|Harbor|Boom|Lock|Hull/i.test(label)),
          true,
          labels.join(", "),
        );
      }
    }
  });

  it("composes after a shape-name miss when Kev would ask for a label again", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    const idea = LAYOUT_OPEN_ASKS[1]!;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) return Response.json({ extract: UNUSABLE_NOTES });
      return Response.json({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "edit_shape", confidence: 0.4 },
          needs_xml_edit: { type: "noul", noul: 0.2 },
          depth: { type: "choice", choice: "few", confidence: 0.3 },
          shape: { type: "choice", choice: "none" },
          next: { type: "choice", choice: "clarify", confidence: 0.2 },
          confirm: { type: "noul", noul: 0.1 },
        },
      });
    }) as typeof fetch;
    const result = await runKevTurn({
      messages: [
        { role: "user", content: idea },
        { role: "assistant", content: "Name the shape to edit." },
        { role: "user", content: "Go detailed — pick the box names for me" },
      ],
      currentXml: STARTER_XML,
    });
    assert.equal(result.mode, "kev");
    assert.equal(result.intent, "add_shape");
    assert.doesNotMatch(result.reply, /What should the new shape be called|Name the shape to edit|Describe a diagram change/);
    const labels = assertDetailed(result.updatedXml, idea);
    assert.equal(labels.some((label) => /Ferry|Shed|Crate|Dock|Manifest/i.test(label)), true, labels.join(", "));
  });

  it("draws one subject box when a high-level answer follows the shape-name miss", async () => {
    let wiki = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("wikipedia.org")) wiki += 1;
      return Response.json({ extract: UNUSABLE_NOTES });
    }) as typeof fetch;
    const result = await runKevTurn({
      messages: [
        { role: "user", content: LAYOUT_OPEN_ASKS[0]! },
        { role: "assistant", content: "What should the new shape be called?" },
        { role: "user", content: "Just the high-level overview" },
      ],
      currentXml: STARTER_XML,
    });
    assert.equal(wiki, 0);
    assert.equal(result.intent, "add_shape");
    const labels = content(assertClean(result.updatedXml).nodes).map((node) => node.label);
    assert.equal(labels.length, 1);
    assert.match(labels[0] ?? "", /CDN|Edge/);
    assert.doesNotMatch(labels[0] ?? "", /Lay Out/);
  });

  it("still soft-fails invent with no earlier idea, and keeps a thin tier", async () => {
    for (const answer of INVENT_ANSWERS) {
      const alone = previewDemo(answer, STARTER_XML);
      assert.equal(alone.decision.reply, "Describe a diagram change.", answer);
      assert.equal(alone.xml, STARTER_XML, answer);
    }
    const tier = await runKevTurn({
      messages: [
        { role: "user", content: LAYOUT_OPEN_ASKS[0]! },
        { role: "assistant", content: "What should the new shape be called?" },
        { role: "user", content: "three tier web app" },
      ],
      currentXml: STARTER_XML,
    });
    assert.deepEqual(content(assertClean(tier.updatedXml).nodes).map((node) => node.label), [
      "Client",
      "App",
      "Postgres",
    ]);
  });
});

const FUNICULAR_IDEA =
  "Draw a canyon funicular that uses trestles and a cog wheel through muffled fluxometry for zero jolts so wardens see steady rides";

const RELIC_NOTES =
  "Common relics include amber beads, cedar masks, river shells, and bone flutes. Museums keep such goods on display.";

describe("invent replies use the prior idea", { concurrency: 1 }, () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  it("keeps concrete path nouns and moves properties and clause scraps onto edges", () => {
    assert.equal(depthFromOpenAnswer("Show a detailed diagram and invent the component names yourself"), "many");
    assert.equal(depthFromOpenAnswer("Sketch the detailed version — invent every box"), "many");
    assert.equal(
      depthFromOpenAnswer("Draw it in detail and name the parts, including amber beads, cedar masks, river shells, and bone flutes"),
      "many",
    );
    assert.equal(depthFromOpenAnswer("Draw a detailed payment system"), null);
    assert.equal(depthFromOpenAnswer("High-level, you name the boxes"), "few");
    assert.equal(depthFromOpenAnswer("give the boxes a color"), null);

    const roles = architectureFromIdea(FUNICULAR_IDEA);
    const labels = roles?.nodes.map((node) => node.label) ?? [];
    assert.ok(labels.length >= 4, labels.join(", "));
    for (const scrap of [
      "Muffled Fluxometry",
      "Muffled Fluxometry Path",
      "Wardens See Steady",
      "Zero Jolts",
      "Canyon Funicular",
    ]) {
      assert.equal(labels.includes(scrap), false, `${scrap} in ${labels.join(", ")}`);
    }
    for (const label of labels) assert.equal(isScrapLabel(label), false, label);
    assert.ok(labels.includes("Clients"), labels.join(", "));
    assert.ok(labels.some((label) => /Funicular/.test(label)), labels.join(", "));
    assert.ok(labels.some((label) => /Trestle/.test(label)), labels.join(", "));
    assert.ok(labels.some((label) => /Cog/.test(label)), labels.join(", "));
    const edges = roles?.edges.map((edge) => edge.label).join(" | ") ?? "";
    assert.match(edges, /Fluxometry/);
    assert.match(edges, /Zero Jolt/);
    assert.ok(roles?.edges.every((edge) => edge.label.length > 0));
  });

  it("draws the prior idea's roles when an invent reply follows, even if notes are a category list", async () => {
    globalThis.fetch = (async () => Response.json({ extract: RELIC_NOTES })) as typeof fetch;
    const answers = [
      "Show a detailed diagram and invent the component names yourself",
      "Sketch the detailed version — invent every box",
      "Draw it in detail and name the parts, including amber beads, cedar masks, river shells, and bone flutes",
      "Detailed diagram — invent the names, such as amber beads, cedar masks, river shells, and bone flutes",
    ];
    for (const answer of answers) {
      const result = await runKevTurn({
        messages: [
          { role: "user", content: FUNICULAR_IDEA },
          { role: "assistant", content: OPEN_IDEA_REPLY },
          { role: "user", content: answer },
        ],
        currentXml: STARTER_XML,
      });
      assert.equal(result.intent, "add_shape", answer);
      assert.notEqual(result.reply, OPEN_IDEA_REPLY, answer);
      assert.doesNotMatch(result.reply, /Describe a diagram change|What should the new shape be called|Name the shape to edit/, answer);
      const report = assertClean(result.updatedXml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.length >= 4, `${answer}: ${labels.join(", ")}`);
      assert.ok(labels.includes("Clients"), `${answer}: ${labels.join(", ")}`);
      assert.ok(labels.some((label) => /Funicular|Trestle|Cog/.test(label)), `${answer}: ${labels.join(", ")}`);
      for (const stolen of [
        "Amber Beads",
        "Cedar Masks",
        "River Shells",
        "Bone Flutes",
        "Muffled Fluxometry",
        "Muffled Fluxometry Path",
        "Wardens See Steady",
        "Zero Jolts",
      ]) {
        assert.equal(labels.includes(stolen), false, `${answer}: ${stolen} in ${labels.join(", ")}`);
      }
      assert.match(report.edges.map((edge) => edge.label).join(" | "), /Fluxometry/);
      assert.match(report.edges.map((edge) => edge.label).join(" | "), /Zero Jolt/);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), answer);
      assert.ok(report.edges.length >= 3 && report.edges.every((edge) => edge.label.length > 0), answer);
      for (const node of content(report.nodes)) {
        const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
        assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${answer} ${node.label} ${fill}`);
      }
    }
  });
});
