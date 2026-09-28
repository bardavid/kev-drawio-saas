import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assessDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { PALETTE } from "../src/lib/drawio/styles";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { cellLabel, geometryOf, listVertices, openDiagram } from "../src/lib/drawio/xml";
import { previewDemo } from "../src/lib/kev/demo";
import { extractNamedEntities } from "../src/lib/kev/entities";
import { runKevTurn } from "../src/lib/kev/run";

const ENV_KEYS = ["KEV_BASE_URL", "KEV_API_KEY", "KEV_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;
const originalFetch = globalThis.fetch;

const PASTEL = new Set(Object.values(PALETTE).map((color) => color.fill.toLowerCase()));

function content(nodes: QualityNode[]): QualityNode[] {
  return nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor");
}

function assertClean(xml: string) {
  const report = assessDiagram(xml);
  assert.deepEqual(report.overlaps, [], `overlaps: ${JSON.stringify(report.overlaps)}`);
  assert.deepEqual(report.crossings, [], `crossings: ${JSON.stringify(report.crossings)}`);
  return report;
}

function boxes(xml: string) {
  return geometrySignature(xml);
}

function geometrySignature(xml: string) {
  const report = assessDiagram(xml);
  return content(report.nodes).map((node) => ({
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  }));
}

function rawOverlapArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

/** Parent-relative boxes read as page coordinates must not collide across containers. */
function assertRawDisjoint(xml: string, prompt: string) {
  const doc = openDiagram(xml);
  const vertices = listVertices(doc).map((vertex) => ({
    id: vertex.getAttribute("id") ?? "",
    parent: vertex.getAttribute("parent") ?? "",
    label: cellLabel(vertex),
    box: geometryOf(vertex),
  }));
  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      const a = vertices[i];
      const b = vertices[j];
      if (!a || !b) continue;
      if (a.parent === b.id || b.parent === a.id) continue;
      const area = rawOverlapArea(a.box, b.box);
      assert.equal(area, 0, `${prompt} ${a.label} overlaps ${b.label} by ${area}`);
    }
  }
}

function assertContainerParents(xml: string, prompt: string) {
  const doc = openDiagram(xml);
  const vertices = listVertices(doc);
  const byId = new Map(vertices.map((vertex) => [vertex.getAttribute("id") ?? "", vertex]));
  const contentCells = vertices.filter((vertex) => (vertex.getAttribute("style") ?? "").includes("drawai=node"));
  assert.ok(contentCells.length >= 2, prompt);
  for (const vertex of contentCells) {
    const parentId = vertex.getAttribute("parent") ?? "";
    const parent = byId.get(parentId);
    assert.ok(parent, `${prompt} ${cellLabel(vertex)} has no container parent`);
    assert.match(parent?.getAttribute("style") ?? "", /drawai=cluster/, `${prompt} ${cellLabel(vertex)}`);
    const box = geometryOf(vertex);
    const frame = geometryOf(parent!);
    assert.ok(box.x >= -1 && box.y >= -1, `${prompt} ${cellLabel(vertex)} relative origin`);
    assert.ok(box.x + box.width <= frame.width + 2, `${prompt} ${cellLabel(vertex)} width`);
    assert.ok(box.y + box.height <= frame.height + 2, `${prompt} ${cellLabel(vertex)} height`);
  }
}

function assertPastel(nodes: QualityNode[], prompt: string) {
  assert.ok(nodes.length >= 2, prompt);
  for (const node of nodes) {
    const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
    assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${prompt} ${node.label} fill ${fill}`);
  }
}

/** HLS hue in degrees. Magenta sits near 300; pink sits near 340 and is outside the band. */
function hexHue(hex: string): number {
  const raw = hex.replace("#", "");
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return hue;
}

describe("named composition", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  it("draws a paraphrased AWS messaging path from the service names", () => {
    const prompt = "APIGW sits ahead of Lambda on AWS, then the call fans out through SQS and SNS.";
    assert.deepEqual(
      extractNamedEntities(prompt).map((entity) => entity.label),
      ["API Gateway", "Lambda", "SQS", "SNS"],
    );
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Which nodes should I draw/);
    assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
    const report = assertClean(drawn.xml);
    const labels = report.nodes.map((node) => node.label);
    for (const label of ["API Gateway", "Lambda", "SQS", "SNS"]) assert.ok(labels.includes(label), label);
    for (const stolen of ["DynamoDB", "CloudFront", "ALB", "RDS"]) assert.equal(labels.includes(stolen), false, stolen);
    assert.ok(report.edges.filter((edge) => edge.label).length >= 3);
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    assertPastel(content(report.nodes), prompt);
  });

  it("draws a paraphrased Azure APIM stack from synonyms", () => {
    const prompt = "Azure footprint: APIM up front, Functions behind it, Cosmos for the records, and Event Hubs for the stream.";
    const labels = extractNamedEntities(prompt).map((entity) => entity.label);
    for (const label of ["API Management", "Azure Functions", "Cosmos DB", "Event Hubs"]) {
      assert.ok(labels.includes(label), label);
    }
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Client → App → Postgres/);
    const report = assertClean(drawn.xml);
    const drawnLabels = report.nodes.map((node) => node.label);
    for (const label of ["API Management", "Azure Functions", "Cosmos DB", "Event Hubs"]) {
      assert.ok(drawnLabels.includes(label), label);
    }
    assert.equal(drawnLabels.includes("ALB"), false);
    assert.ok(report.edges.some((edge) => edge.label.length > 0));
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    assertPastel(content(report.nodes), prompt);
  });

  it("draws a paraphrased Stripe sequence, mapping webhook receiver to the handler", () => {
    const prompt = "Card payment sequence — shopper browser, Stripe checkout page, webhook receiver, then the database.";
    const labels = extractNamedEntities(prompt).map((entity) => entity.label);
    for (const label of ["Browser", "Stripe Checkout", "Webhook handler", "Database"]) {
      assert.ok(labels.includes(label), `${label} from ${labels.join(", ")}`);
    }
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
    const report = assertClean(drawn.xml);
    const drawnLabels = content(report.nodes).map((node) => node.label);
    assert.deepEqual(drawnLabels, ["Browser", "Stripe Checkout", "Webhook handler", "Database"]);
    assert.ok(content(report.nodes).every((node) => node.style.includes("umlLifeline")));
    assert.ok(report.edges.some((edge) => /webhook/i.test(edge.label)));
    assert.equal(drawnLabels.includes("Payment"), false);
    assert.equal(drawnLabels.includes("Orders"), false);
    assertPastel(content(report.nodes), prompt);
  });

  it("composes a Cloudflare stack that has no memorized prompt", () => {
    const prompt = "Cloudflare edge: Workers plus D1, R2 object storage, and Queues.";
    assert.deepEqual(
      extractNamedEntities(prompt).map((entity) => entity.label),
      ["Workers", "D1", "R2", "Queues"],
    );
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Which nodes should I draw/);
    const report = assertClean(drawn.xml);
    const labels = report.nodes.map((node) => node.label);
    for (const label of ["Workers", "D1", "R2", "Queues"]) assert.ok(labels.includes(label), label);
    for (const stolen of ["ALB", "Lambda", "Postgres", "S3", "API Gateway"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }
    assert.ok(report.edges.filter((edge) => edge.label).length >= 3);
    const clusters = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
    for (const label of ["Edge", "Data", "Storage", "Messaging"]) assert.ok(clusters.includes(label), label);
    assertPastel(content(report.nodes), prompt);
  });

  it("composes an ad-hoc gateway, two services, and a bus without a microservices preset", () => {
    const prompt = "Put an API gateway in front of Orders and Inventory, and hang a message bus off them.";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["API Gateway", "Orders", "Inventory", "Message bus"]) assert.ok(labels.includes(label), label);
    for (const stolen of ["Catalog", "Payments", "Billing", "Web", "Event broker"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    assertPastel(content(report.nodes), prompt);
  });

  it("keeps a named message bus on a gateway and two services", () => {
    const prompt = "A microservices sketch with a gateway, Auth service, Orders service, and a message bus.";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Which nodes should I draw/);
    assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["API Gateway", "Auth Service", "Orders Service", "Message bus"]) {
      assert.ok(labels.includes(label), `${label} in ${labels.join(", ")}`);
    }
    assert.equal(labels.includes("Event broker"), false);
    assert.ok(report.edges.some((edge) => edge.label === "Publish"));

    const cached = previewDemo("Put a cache ahead of Orders", drawn.xml);
    assert.equal(cached.decision.intent, "add_shape");
    assert.match(cached.decision.reply, /cache/i);
    const withCache = assessDiagram(cached.xml);
    assert.ok(content(withCache.nodes).some((node) => node.label === "Cache"));
    assert.ok(withCache.edges.some((edge) => edge.from === "Cache" && /Orders/.test(edge.to)));

    const before = boxes(cached.xml);
    const teal = previewDemo("Restyle the connectors teal", cached.xml);
    assert.equal(teal.decision.intent, "style");
    assert.equal(teal.decision.slots.colorName, "teal");
    assert.deepEqual(boxes(teal.xml), before);
    assert.ok(assessDiagram(teal.xml).edges.every((edge) => edge.style.includes("strokeColor=#0e8088")));
  });

  it("draws boxed client, API, and Postgres labels, then relabels the API", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const prompt = "Client box, API box, and a Postgres box";
    const drawn = await runKevTurn({
      messages: [{ role: "user", content: prompt }],
      currentXml: STARTER_XML,
    });
    assert.equal(drawn.intent, "add_shape");
    assert.doesNotMatch(drawn.reply, /What should the new shape be called/);
    const report = assertClean(drawn.updatedXml);
    assert.deepEqual(content(report.nodes).map((node) => node.label), ["Client", "API", "Postgres"]);

    const renamed = await runKevTurn({
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: drawn.reply },
        { role: "user", content: "Relabel the API so it reads Backend" },
      ],
      currentXml: drawn.updatedXml,
    });
    assert.equal(renamed.intent, "edit_shape");
    assert.deepEqual(content(assertClean(renamed.updatedXml).nodes).map((node) => node.label), [
      "Client",
      "Backend",
      "Postgres",
    ]);

    const nonsense = await runKevTurn({
      messages: [{ role: "user", content: "zzzzzyx nonsense blobble wibble not a real request" }],
      currentXml: renamed.updatedXml,
    });
    assert.equal(nonsense.intent, "clarify");
    assert.equal(nonsense.updatedXml, renamed.updatedXml);
  });

  it("draws one flowchart node per ordered step", () => {
    const prompt = "Flowchart of boarding a train: show ticket, pass the gate, find the seat, then depart";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.deepEqual(labels, ["Show Ticket", "Pass The Gate", "Find The Seat", "Depart"]);
    assert.deepEqual(
      report.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Show Ticket->Pass The Gate", "Pass The Gate->Find The Seat", "Find The Seat->Depart"],
    );
    assert.ok(report.edges.every((edge) => edge.label === "Next"));
  });

  it("renames a paraphrased client chain and restyles every box without moving it", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const prompt = "Client / API / Postgres";
    const drawn = await runKevTurn({
      messages: [{ role: "user", content: prompt }],
      currentXml: STARTER_XML,
    });
    assert.equal(drawn.intent, "add_shape");
    assert.doesNotMatch(drawn.reply, /Which nodes should I draw/);
    assert.doesNotMatch(drawn.reply, /What should the new shape be called/);
    const report = assertClean(drawn.updatedXml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.deepEqual(labels, ["Client", "API", "Postgres"]);
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    assertPastel(content(report.nodes), prompt);

    const renamed = await runKevTurn({
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: drawn.reply },
        { role: "user", content: "rename API to Backend" },
      ],
      currentXml: drawn.updatedXml,
      previousXml: STARTER_XML,
    });
    assert.equal(renamed.intent, "edit_shape");
    assert.match(renamed.reply, /Renamed API to Backend/);
    const renamedReport = assertClean(renamed.updatedXml);
    assert.deepEqual(content(renamedReport.nodes).map((node) => node.label), ["Client", "Backend", "Postgres"]);
    const beforePaint = boxes(renamed.updatedXml);

    const painted = await runKevTurn({
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: drawn.reply },
        { role: "user", content: "rename API to Backend" },
        { role: "assistant", content: renamed.reply },
        { role: "user", content: "Paint every box orange" },
      ],
      currentXml: renamed.updatedXml,
      previousXml: drawn.updatedXml,
    });
    assert.equal(painted.intent, "style");
    assert.match(painted.reply, /orange/i);
    assert.doesNotMatch(painted.reply, /What should the new shape be called/);
    const after = assertClean(painted.updatedXml);
    assert.deepEqual(content(after.nodes).map((node) => node.label), ["Client", "Backend", "Postgres"]);
    assert.deepEqual(boxes(painted.updatedXml), beforePaint);
    assert.ok(content(after.nodes).every((node) => node.style.includes("fillColor=#ffe6cc")));
    assert.ok(content(after.nodes).every((node) => node.style.includes("strokeColor=#d79b00")));
    assert.deepEqual(
      after.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->Backend", "Backend->Postgres"],
    );
  });

  it("draws a named stack when outline confirm says clarify", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions?: Record<string, { type: string }> };
      if (body.questions?.intent) {
        return Response.json({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "clarify", confidence: 0.3 },
            needs_xml_edit: { type: "noul", noul: 0.1 },
            color: { type: "choice", choice: "none" },
            shape: { type: "choice", choice: "none" },
            layout: { type: "choice", choice: "none" },
            anchor: { type: "choice", choice: "none" },
          },
        });
      }
      return Response.json({
        model: "kev-latest",
        answers: {
          next: { type: "choice", choice: "clarify", confidence: 0.3 },
          confirm: { type: "noul", noul: 0.2 },
        },
      });
    }) as typeof fetch;

    const prompt = "Cloudflare edge: Workers plus D1, R2 object storage, and Queues.";
    const drawn = await runKevTurn({
      messages: [{ role: "user", content: prompt }],
      currentXml: STARTER_XML,
    });
    assert.equal(drawn.intent, "add_shape");
    assert.equal(drawn.updatedXml === STARTER_XML, false);
    assert.doesNotMatch(drawn.reply, /Which nodes should I draw/);
    assert.doesNotMatch(drawn.reply, /What should the new shape be called/);
    const labels = assessDiagram(drawn.updatedXml).nodes.map((node) => node.label);
    for (const label of ["Workers", "D1", "R2", "Queues"]) assert.ok(labels.includes(label), label);
  });

  it("splices a stage between canvas labels when the sentence has trailing words", () => {
    const drawn = previewDemo(
      "draw a simple CI/CD pipeline with GitHub Actions, build, and deploy to Vercel",
      STARTER_XML,
    );
    const placed = (xml: string) =>
      content(assessDiagram(xml).nodes).map((node) => ({
        label: node.label,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      }));
    const before = placed(drawn.xml);
    const phrases = [
      "Insert Test between the Build and Deploy stages",
      "Put Test between Build and Deploy stages of the pipeline",
    ];
    for (const phrase of phrases) {
      const edited = previewDemo(phrase, drawn.xml);
      assert.equal(edited.decision.intent, "add_shape", phrase);
      const report = assertClean(edited.xml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.includes("Test"), phrase);
      assert.equal(labels.includes("Deploy Stages"), false, phrase);
      assert.equal(labels.includes("Stages"), false, phrase);
      assert.deepEqual(
        [...content(report.nodes)].sort((a, b) => a.x - b.x).map((node) => node.label),
        ["GitHub Actions", "Build", "Test", "Deploy to Vercel"],
        phrase,
      );
      assert.ok(report.edges.some((edge) => edge.from === "Build" && edge.to === "Test"), phrase);
      assert.ok(report.edges.some((edge) => edge.from === "Test" && edge.to === "Deploy to Vercel"), phrase);
      assert.equal(
        report.edges.some((edge) => edge.from === "Build" && edge.to === "Deploy to Vercel"),
        false,
        phrase,
      );
      const kept = placed(edited.xml);
      assert.deepEqual(
        kept.find((node) => node.label === "GitHub Actions"),
        before.find((node) => node.label === "GitHub Actions"),
        phrase,
      );
      assert.deepEqual(
        kept.find((node) => node.label === "Build"),
        before.find((node) => node.label === "Build"),
        phrase,
      );
    }

    const painted = previewDemo("Paint the Deploy stages teal", drawn.xml);
    assert.equal(painted.decision.intent, "style");
    assert.deepEqual(placed(painted.xml), before);
    const deploy = assessDiagram(painted.xml).nodes.find((node) => node.label === "Deploy to Vercel");
    assert.ok(deploy);
    assert.match(deploy.style, /fillColor=#d5e8e4/);
    assert.match(deploy.style, /strokeColor=#0e8088/);
    assert.equal(
      assessDiagram(painted.xml).nodes.some((node) => node.label === "Deploy Stages"),
      false,
    );
  });

  it("keeps uncommon brand tokens and still uses role words for shape and grouping", () => {
    const phrases = [
      "Draw Fly.io with Tigris object storage and Upstash Redis.",
      "fly.io plus tigris for object storage, and upstash for redis",
    ];
    for (const phrase of phrases) {
      const labels = extractNamedEntities(phrase).map((entity) => entity.label);
      for (const label of ["Fly.io", "Tigris", "Upstash"]) assert.ok(labels.includes(label), `${phrase} → ${labels.join(", ")}`);
      assert.equal(labels.includes("Object storage"), false, phrase);
      assert.equal(labels.includes("Redis"), false, phrase);

      const drawn = previewDemo(phrase, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", phrase);
      const report = assertClean(drawn.xml);
      const drawnLabels = report.nodes.map((node) => node.label);
      for (const label of ["Fly.io", "Tigris", "Upstash"]) assert.ok(drawnLabels.includes(label), phrase);
      assert.equal(drawnLabels.includes("Object storage"), false, phrase);
      assert.equal(drawnLabels.includes("Redis"), false, phrase);
      const tigris = content(report.nodes).find((node) => node.label === "Tigris");
      const upstash = content(report.nodes).find((node) => node.label === "Upstash");
      assert.ok(tigris?.style.includes("shape=cloud"), phrase);
      assert.ok(upstash?.style.includes("shape=cylinder3"), phrase);
      const clusters = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
      for (const label of ["Services", "Storage", "Data"]) assert.ok(clusters.includes(label), `${phrase} ${label}`);
      assert.ok(report.edges.filter((edge) => edge.label).length >= 2, phrase);
      assertPastel(content(report.nodes), phrase);
    }

    const generic = previewDemo("Draw object storage and Redis", STARTER_XML);
    const genericLabels = content(assertClean(generic.xml).nodes).map((node) => node.label);
    assert.ok(genericLabels.includes("Object storage"));
    assert.ok(genericLabels.includes("Redis"));
  });

  it("draws a release pipeline with pastel fills and a topic container", () => {
    const prompt = "Sketch the release pipeline. GitHub Actions runs Build, then it finishes at Deploy to Vercel";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    const report = assertClean(drawn.xml);
    assert.deepEqual(content(report.nodes).map((node) => node.label), ["GitHub Actions", "Build", "Deploy to Vercel"]);
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
    assertPastel(content(report.nodes), prompt);
  });

  it("splices a step onto the Build to Deploy edge when the anchors have trailing fluff", () => {
    const drawn = previewDemo(
      "Sketch the release pipeline. GitHub Actions runs Build, then it finishes at Deploy to Vercel",
      STARTER_XML,
    );
    const placed = (xml: string) =>
      content(assessDiagram(xml).nodes).map((node) => ({
        label: node.label,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      }));
    const before = placed(drawn.xml);
    const phrases = [
      "Splice a Test step into the pipeline between Build and the Deploy stages",
      "Wedge Test into the flow between Build and Deploy stages of this pipeline",
    ];
    for (const phrase of phrases) {
      const edited = previewDemo(phrase, drawn.xml);
      assert.equal(edited.decision.intent, "add_shape", phrase);
      assert.equal(edited.decision.slots.label, "Test", phrase);
      const report = assertClean(edited.xml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.includes("Test"), phrase);
      assert.equal(labels.includes("Stages"), false, phrase);
      assert.equal(labels.includes("Deploy Stages"), false, phrase);
      assert.deepEqual(
        [...content(report.nodes)].sort((a, b) => a.x - b.x).map((node) => node.label),
        ["GitHub Actions", "Build", "Test", "Deploy to Vercel"],
        phrase,
      );
      assert.ok(report.edges.some((edge) => edge.from === "Build" && edge.to === "Test"), phrase);
      assert.ok(report.edges.some((edge) => edge.from === "Test" && edge.to === "Deploy to Vercel"), phrase);
      assert.equal(
        report.edges.some((edge) => edge.from === "Build" && edge.to === "Deploy to Vercel"),
        false,
        phrase,
      );
      const kept = placed(edited.xml);
      assert.deepEqual(
        kept.find((node) => node.label === "GitHub Actions"),
        before.find((node) => node.label === "GitHub Actions"),
        phrase,
      );
      assert.deepEqual(
        kept.find((node) => node.label === "Build"),
        before.find((node) => node.label === "Build"),
        phrase,
      );
    }
  });

  it("keeps only the stage name when a between-insert has placement wording", () => {
    const drawn = previewDemo(
      "Sketch the release pipeline. GitHub Actions runs Build, then it finishes at Deploy to Vercel",
      STARTER_XML,
    );
    const placed = (xml: string) =>
      content(assessDiagram(xml).nodes).map((node) => ({
        label: node.label,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      }));
    const before = placed(drawn.xml);
    const phrases = [
      { text: "Drop Lint into place between Build and Deploy", label: "Lint" },
      { text: "Put Review into place between the Build and Deploy stages", label: "Review" },
      { text: "Splice QA into the pipeline between Build and Deploy", label: "QA" },
      { text: "Wedge Approval into the pipeline between Build and the Deploy stages", label: "Approval" },
      { text: "Drop Smoke Test into place between Build and Deploy", label: "Smoke Test" },
      { text: "Put Unit Tests into the pipeline between Build and Deploy stages", label: "Unit Tests" },
      { text: "Wedge Signoff in between Build and Deploy", label: "Signoff" },
      { text: "Drop Gate here between Build and Deploy", label: "Gate" },
      { text: "Put Canary there between Build and Deploy", label: "Canary" },
      { text: "Splice Rollback somewhere between Build and Deploy", label: "Rollback" },
      { text: "Wedge Hold anywhere between Build and Deploy", label: "Hold" },
      { text: "Drop Place Order into place between Build and Deploy", label: "Place Order" },
      { text: "Drop Integration Smoke midstream between Build and Deploy", label: "Integration Smoke" },
      { text: "Put Integration midstream Smoke between Build and Deploy", label: "Integration Smoke" },
      { text: "Wedge midstream Integration Smoke between Build and Deploy", label: "Integration Smoke" },
      { text: "Park Integration Smoke mid-stream between Build and Deploy", label: "Integration Smoke" },
      { text: "Tuck Integration Smoke in the midst between Build and Deploy", label: "Integration Smoke" },
      { text: "Drop Integration Smoke cleanly midstream between Build and Deploy", label: "Integration Smoke" },
      { text: "Put the stage named Integration Smoke so it sits midstream between Build and Deploy", label: "Integration Smoke" },
      { text: "Slot partway QA between Build and Deploy", label: "QA" },
      { text: "Nest QA midpoint between the Build and Deploy stages", label: "QA" },
      { text: "Drop QA midcourse between Build and Deploy", label: "QA" },
      { text: "Put QA midspan between Build and Deploy", label: "QA" },
      { text: "Splice QA midpath between Build and Deploy", label: "QA" },
      { text: "Wedge QA midflow between Build and Deploy", label: "QA" },
      { text: "Park QA betwixt between Build and Deploy", label: "QA" },
      { text: "Tuck QA amid between Build and Deploy", label: "QA" },
      { text: "Slot QA amidst between Build and Deploy", label: "QA" },
      { text: "Nest QA enroute between Build and Deploy", label: "QA" },
      { text: "Drop QA en-route between Build and Deploy", label: "QA" },
      { text: "Put QA neatly between Build and Deploy", label: "QA" },
      { text: "Splice QA cleanly between Build and Deploy", label: "QA" },
      { text: "Wedge QA directly between Build and Deploy", label: "QA" },
      { text: "Park QA squarely between Build and Deploy", label: "QA" },
      { text: "Drop Place midstream Order between Build and Deploy", label: "Place Order" },
      { text: "Splice Upstash Redis midstream between Build and Deploy", label: "Upstash Redis" },
      { text: "Wedge AWS Lambda halfway between Build and Deploy", label: "AWS Lambda" },
    ];
    for (const phrase of phrases) {
      const edited = previewDemo(phrase.text, drawn.xml);
      assert.equal(edited.decision.intent, "add_shape", phrase.text);
      assert.equal(edited.decision.slots.label, phrase.label, phrase.text);
      assert.equal(edited.decision.reply, `Added ${phrase.label} between Build and Deploy.`, phrase.text);
      const report = assertClean(edited.xml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.equal(labels.includes("Stages"), false, phrase.text);
      assert.equal(labels.includes("Deploy Stages"), false, phrase.text);
      assert.deepEqual(
        [...content(report.nodes)].sort((a, b) => a.x - b.x).map((node) => node.label),
        ["GitHub Actions", "Build", phrase.label, "Deploy to Vercel"],
        phrase.text,
      );
      assert.ok(report.edges.some((edge) => edge.from === "Build" && edge.to === phrase.label), phrase.text);
      assert.ok(
        report.edges.some((edge) => edge.from === phrase.label && edge.to === "Deploy to Vercel"),
        phrase.text,
      );
      assert.equal(
        report.edges.some((edge) => edge.from === "Build" && edge.to === "Deploy to Vercel"),
        false,
        phrase.text,
      );
      const order = [...content(report.nodes)].sort((a, b) => a.x - b.x);
      const build = order.find((node) => node.label === "Build");
      const inserted = order.find((node) => node.label === phrase.label);
      const deploy = order.find((node) => node.label === "Deploy to Vercel");
      assert.ok(build && inserted && deploy, phrase.text);
      assert.ok(build.x < inserted.x && inserted.x < deploy.x, phrase.text);
      const kept = placed(edited.xml);
      assert.deepEqual(
        kept.find((node) => node.label === "GitHub Actions"),
        before.find((node) => node.label === "GitHub Actions"),
        phrase.text,
      );
      assert.deepEqual(
        kept.find((node) => node.label === "Build"),
        before.find((node) => node.label === "Build"),
        phrase.text,
      );
    }
  });

  it("keeps Tigris beside blobs and does not mint a node from clause crumbs", () => {
    const prompt = "A Fly.io service keeps blobs in Tigris and uses Upstash Redis as its cache";
    const labels = extractNamedEntities(prompt).map((entity) => entity.label);
    for (const label of ["Fly.io", "Tigris", "Upstash"]) {
      assert.ok(labels.includes(label), `${prompt} → ${labels.join(", ")}`);
    }
    assert.equal(labels.includes("Caches"), false, labels.join(", "));
    assert.equal(labels.includes("Compute There"), false, labels.join(", "));
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    const report = assertClean(drawn.xml);
    const drawnLabels = report.nodes.map((node) => node.label);
    for (const label of ["Fly.io", "Tigris", "Upstash"]) assert.ok(drawnLabels.includes(label), label);
    assert.equal(drawnLabels.includes("Compute There"), false);
    const tigris = content(report.nodes).find((node) => node.label === "Tigris");
    const upstash = content(report.nodes).find((node) => node.label === "Upstash");
    assert.ok(tigris?.style.includes("shape=cloud"));
    assert.ok(upstash?.style.includes("shape=cylinder3"));
    const clusters = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
    for (const label of ["Services", "Storage", "Data"]) assert.ok(clusters.includes(label), clusters.join(", "));
    assertPastel(content(report.nodes), prompt);

    const alt = "Fly.io setup: compute there, Tigris for object storage, and Upstash Redis as the cache";
    const altLabels = extractNamedEntities(alt).map((entity) => entity.label);
    for (const label of ["Fly.io", "Tigris", "Upstash"]) {
      assert.ok(altLabels.includes(label), `${alt} → ${altLabels.join(", ")}`);
    }
    assert.equal(altLabels.includes("Compute There"), false, altLabels.join(", "));
    assert.equal(altLabels.includes("Compute"), false, altLabels.join(", "));
    const altDrawn = previewDemo(alt, STARTER_XML);
    const altNodes = assessDiagram(altDrawn.xml).nodes.map((node) => node.label);
    assert.equal(altNodes.includes("Compute There"), false);
    assert.ok(altNodes.includes("Tigris"));
  });

  it("draws one sequence lifeline per distinctly named actor", () => {
    const prompts = [
      "Login sequence: Client Browser talks to the Authorization Server; afterward the Resource Server checks the access token",
      "Sign-in sequence. The client browser talks with the authorization server. Later the resource server checks the token.",
    ];
    for (const prompt of prompts) {
      const labels = extractNamedEntities(prompt).map((entity) => entity.label);
      for (const label of ["Client Browser", "Authorization Server", "Resource Server"]) {
        assert.ok(labels.includes(label), `${prompt} → ${labels.join(", ")}`);
      }
      for (const stolen of ["User", "Auth Service", "Browser", "Talks", "Checks", "Sign-in", "Token"]) {
        assert.equal(labels.includes(stolen), false, `${prompt} stole ${stolen}`);
      }
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
      const report = assertClean(drawn.xml);
      assert.deepEqual(content(report.nodes).map((node) => node.label), [
        "Client Browser",
        "Authorization Server",
        "Resource Server",
      ]);
      assert.ok(content(report.nodes).every((node) => node.style.includes("umlLifeline")), prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      assertPastel(content(report.nodes), prompt);
    }
  });

  it("inserts only the stage name from midway, after, and before phrasing", () => {
    const drawn = previewDemo(
      "draw a simple CI/CD pipeline with GitHub Actions, build, and deploy to Vercel",
      STARTER_XML,
    );
    const restyled = previewDemo("make the arrows blue", drawn.xml);
    const placed = (xml: string) =>
      content(assessDiagram(xml).nodes).map((node) => ({
        label: node.label,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      }));
    const before = placed(restyled.xml);
    const phrases = [
      { text: "Park Test midway — after Build, before Deploy", label: "Test" },
      { text: "Insert the stage named Test so it sits between Build and Deploy", label: "Test" },
      { text: "Tuck Lint halfway after Build and before Deploy", label: "Lint" },
      { text: "Slot Review after the Build stage and before Deploy", label: "Review" },
      { text: "Integration Smoke midstream — after Build, before Deploy", label: "Integration Smoke" },
      { text: "QA mid-way after Build and before Deploy", label: "QA" },
      { text: "Lint part-way — after Build, before Deploy", label: "Lint" },
    ];
    for (const phrase of phrases) {
      const edited = previewDemo(phrase.text, restyled.xml);
      assert.equal(edited.decision.intent, "add_shape", phrase.text);
      assert.equal(edited.decision.slots.label, phrase.label, phrase.text);
      assert.equal(edited.decision.reply, `Added ${phrase.label} between Build and Deploy.`, phrase.text);
      const report = assertClean(edited.xml);
      const labels = content(report.nodes).map((node) => node.label);
      for (const fluff of ["Named Test So It Sits", "Test So", "So It Sits", "Midway", "Midstream", "Integration Smoke Midstream", "Stages"]) {
        assert.equal(labels.includes(fluff), false, `${phrase.text} → ${fluff}`);
      }
      assert.deepEqual(
        [...content(report.nodes)].sort((a, b) => a.x - b.x).map((node) => node.label),
        ["GitHub Actions", "Build", phrase.label, "Deploy to Vercel"],
        phrase.text,
      );
      assert.ok(report.edges.some((edge) => edge.from === "Build" && edge.to === phrase.label), phrase.text);
      assert.ok(
        report.edges.some((edge) => edge.from === phrase.label && edge.to === "Deploy to Vercel"),
        phrase.text,
      );
      assert.equal(
        report.edges.some((edge) => edge.from === "Build" && edge.to === "Deploy to Vercel"),
        false,
        phrase.text,
      );
      assert.ok(report.edges.every((edge) => edge.style.includes("strokeColor=#6c8ebf")), phrase.text);
      const kept = placed(edited.xml);
      assert.deepEqual(
        kept.find((node) => node.label === "GitHub Actions"),
        before.find((node) => node.label === "GitHub Actions"),
        phrase.text,
      );
      assert.deepEqual(
        kept.find((node) => node.label === "Build"),
        before.find((node) => node.label === "Build"),
        phrase.text,
      );
    }
  });

  it("draws every named process step and does not ask for a name", async () => {
    const prompts = [
      {
        text: "Library book checkout process: search catalog, reserve copy, pick up at desk, scan barcode, return by due date",
        title: "Library Book Checkout",
        steps: ["Search Catalog", "Reserve Copy", "Pick Up At Desk", "Scan Barcode", "Return By Due Date"],
      },
      {
        text: "Hiring process: screen resume, phone interview, onsite, extend offer",
        title: "Hiring",
        steps: ["Screen Resume", "Phone Interview", "Onsite", "Extend Offer"],
      },
    ];
    for (const prompt of prompts) {
      const drawn = previewDemo(prompt.text, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt.text);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
      assert.match(drawn.decision.reply, new RegExp(prompt.title));
      const report = assertClean(drawn.xml);
      assert.deepEqual(content(report.nodes).map((node) => node.label), prompt.steps, prompt.text);
      assert.ok(report.nodes.some((node) => node.role === "cluster" && node.label === "Steps"), prompt.text);
      assert.ok(report.edges.every((edge) => edge.label === "Next"), prompt.text);
      assertPastel(content(report.nodes), prompt.text);
      for (const stolen of ["User", "Payment", "Orders", "Checkout"]) {
        assert.equal(content(report.nodes).some((node) => node.label === stolen), false, `${prompt.text} ${stolen}`);
      }
    }

    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions?: Record<string, { type: string }> };
      if (body.questions?.intent) {
        return Response.json({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "clarify", confidence: 0.2 },
            needs_xml_edit: { type: "noul", noul: 0.1 },
            color: { type: "choice", choice: "none" },
            shape: { type: "choice", choice: "none" },
            layout: { type: "choice", choice: "none" },
            anchor: { type: "choice", choice: "none" },
          },
        });
      }
      return Response.json({
        model: "kev-latest",
        answers: {
          next: { type: "choice", choice: "clarify", confidence: 0.2 },
          confirm: { type: "noul", noul: 0.1 },
        },
      });
    }) as typeof fetch;

    const prompted = prompts[0]!;
    const kev = await runKevTurn({
      messages: [{ role: "user", content: prompted.text }],
      currentXml: STARTER_XML,
    });
    assert.equal(kev.intent, "add_shape");
    assert.doesNotMatch(kev.reply, /What should the new shape be called/);
    assert.doesNotMatch(kev.reply, /Which nodes should I draw/);
    assert.deepEqual(content(assertClean(kev.updatedXml).nodes).map((node) => node.label), prompted.steps);
  });

  it("renames from synonym phrasing without a confirm round", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const drawn = await runKevTurn({
      messages: [{ role: "user", content: "Client / API / Postgres" }],
      currentXml: STARTER_XML,
    });
    assert.deepEqual(content(assertClean(drawn.updatedXml).nodes).map((node) => node.label), [
      "Client",
      "API",
      "Postgres",
    ]);

    const phrases = [
      "Change API's name to Backend",
      "Change the name of API to Backend",
      "Update the API's name to Backend",
      "Please call API by the name Backend instead",
      "refer to API as Backend",
      "please call API Backend",
    ];
    for (const phrase of phrases) {
      process.env.KEV_BASE_URL = "http://kev.local";
      let called = 0;
      globalThis.fetch = (async () => {
        called += 1;
        throw new Error("rename must not ask Kev");
      }) as typeof fetch;
      const renamed = await runKevTurn({
        messages: [
          { role: "user", content: "Client / API / Postgres" },
          { role: "assistant", content: drawn.reply },
          { role: "user", content: phrase },
        ],
        currentXml: drawn.updatedXml,
      });
      assert.equal(called, 0, phrase);
      assert.equal(renamed.intent, "edit_shape", phrase);
      assert.match(renamed.reply, /Renamed API to Backend/);
      assert.deepEqual(content(assertClean(renamed.updatedXml).nodes).map((node) => node.label), [
        "Client",
        "Backend",
        "Postgres",
      ]);
    }

    const boxes = previewDemo("Change the boxes to red", drawn.updatedXml);
    assert.equal(boxes.decision.intent, "style");
    assert.deepEqual(content(assessDiagram(boxes.xml).nodes).map((node) => node.label), ["Client", "API", "Postgres"]);
  });

  it("keeps multi-word product tokens intact", () => {
    const prompts = [
      "DigitalOcean stack: App Platform hosts the app, Spaces holds objects, Managed Redis for cache",
      "Neon stack: App Platform hosts the app, Spaces holds objects, Managed Redis for cache",
    ];
    for (const prompt of prompts) {
      const labels = extractNamedEntities(prompt).map((entity) => entity.label);
      for (const label of ["App Platform", "Spaces", "Managed Redis"]) {
        assert.ok(labels.includes(label), `${prompt} → ${labels.join(", ")}`);
      }
      for (const stolen of ["Platform", "Managed", "Redis", "App", "Object storage", "Cache"]) {
        assert.equal(labels.includes(stolen), false, `${prompt} stole ${stolen}`);
      }
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      const report = assertClean(drawn.xml);
      const drawnLabels = report.nodes.map((node) => node.label);
      for (const label of ["App Platform", "Spaces", "Managed Redis"]) {
        assert.ok(drawnLabels.includes(label), prompt);
      }
      assert.equal(drawnLabels.includes("Platform"), false, prompt);
      assert.equal(drawnLabels.includes("Managed"), false, prompt);
      const redis = content(report.nodes).find((node) => node.label === "Managed Redis");
      const spaces = content(report.nodes).find((node) => node.label === "Spaces");
      assert.ok(redis?.style.includes("shape=cylinder3"), prompt);
      assert.ok(spaces?.style.includes("shape=cloud"), prompt);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      assertPastel(content(report.nodes), prompt);
    }
  });

  it("paints arrows violet and leaves node fills alone", () => {
    const drawn = previewDemo("Client / API / Postgres", STARTER_XML);
    const before = assessDiagram(drawn.xml);
    const fills = content(before.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]);
    const painted = previewDemo("Paint the arrows violet", drawn.xml);
    assert.equal(painted.decision.intent, "style");
    assert.equal(painted.decision.slots.colorName, "purple");
    assert.equal(painted.decision.slots.strokeColor, "#9673a6");
    const after = assertClean(painted.xml);
    assert.deepEqual(content(after.nodes).map((node) => node.label), ["Client", "API", "Postgres"]);
    assert.deepEqual(
      content(after.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]),
      fills,
    );
    assert.ok(after.edges.every((edge) => edge.style.includes("strokeColor=#9673a6")));
    assert.ok(after.edges.every((edge) => !edge.style.includes("fillColor=#dae8fc")));
  });

  it("gives a blank architecture pastel fills, labeled edges, and topic groups", () => {
    const prompts = [
      "draw a 3 tier web app",
      "Browser → Application → Database",
      "draw an architecture: Browser, Application, Database",
    ];
    for (const prompt of prompts) {
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      const report = assertClean(drawn.xml);
      const boxes = content(report.nodes);
      assert.ok(boxes.length >= 3, prompt);
      assert.ok(report.nodes.filter((node) => node.role === "cluster").length >= boxes.length, prompt);
      assert.ok(report.edges.length >= boxes.length - 1, prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      assertPastel(boxes, prompt);
      if (prompt.includes("Browser")) {
        assert.deepEqual(
          boxes.map((node) => node.label),
          ["Browser", "Application", "Database"],
          prompt,
        );
      }
    }
  });

  it("draws one node per named step when a flow lists four or more", () => {
    const prompts = [
      {
        text: "fulfillment flow listing receive order, pick items, pack box, print label, hand to carrier",
        steps: ["Receive Order", "Pick Items", "Pack Box", "Print Label", "Hand To Carrier"],
      },
      {
        text: "Draw a receiving flow: unload truck, inspect crates, sort bins, store pallet, escort to dock",
        steps: ["Unload Truck", "Inspect Crates", "Sort Bins", "Store Pallet", "Escort To Dock"],
      },
    ];
    for (const prompt of prompts) {
      const drawn = previewDemo(prompt.text, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt.text);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
      assert.doesNotMatch(drawn.decision.reply, /Which nodes should I draw/);
      const report = assertClean(drawn.xml);
      assert.deepEqual(content(report.nodes).map((node) => node.label), prompt.steps, prompt.text);
      assert.ok(report.edges.length >= prompt.steps.length - 1, prompt.text);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt.text);
    }
  });

  it("renames when asked to call a shape by another name", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const drawn = await runKevTurn({
      messages: [{ role: "user", content: "Client → Gateway → Database" }],
      currentXml: STARTER_XML,
    });
    assert.ok(content(assertClean(drawn.updatedXml).nodes).some((node) => node.label === "Gateway"));
    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async () => {
      throw new Error("rename must not ask Kev");
    }) as typeof fetch;
    const renamed = await runKevTurn({
      messages: [
        { role: "user", content: "Client → Gateway → Database" },
        { role: "assistant", content: drawn.reply },
        { role: "user", content: "Please call Gateway by the name Edge instead" },
      ],
      currentXml: drawn.updatedXml,
    });
    assert.equal(renamed.intent, "edit_shape");
    assert.match(renamed.reply, /Renamed Gateway to Edge/);
    const labels = content(assertClean(renamed.updatedXml).nodes).map((node) => node.label);
    assert.ok(labels.includes("Edge"));
    assert.equal(labels.includes("Gateway"), false);
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;

    const nonsense = await runKevTurn({
      messages: [{ role: "user", content: "zzzzzyx nonsense blobble wibble not a real request" }],
      currentXml: renamed.updatedXml,
    });
    assert.equal(nonsense.intent, "clarify");
    assert.equal(nonsense.updatedXml, renamed.updatedXml);
  });

  it("draws one vertex per named tier, including the client tier, inside its container", () => {
    const prompts = [
      {
        text: "Sketch a multi-tier web architecture: browser clients, an application tier, and a relational database",
        labels: ["Browser Clients", "Application", "Relational Database"],
        groups: ["Clients", "Services", "Data"],
      },
      {
        text: "Draw the tiers for a web system — clients, an app tier, and a database",
        labels: ["Client", "App", "Database"],
        groups: ["Clients", "Services", "Data"],
      },
      {
        text: "Map a tiered service: frontend, backend, and a relational database",
        labels: ["Frontend", "Backend", "Relational Database"],
        groups: ["Clients", "Services", "Data"],
      },
    ];
    for (const prompt of prompts) {
      const labels = extractNamedEntities(prompt.text).map((entity) => entity.label);
      assert.deepEqual(labels, prompt.labels, prompt.text);
      const drawn = previewDemo(prompt.text, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt.text);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
      const report = assertClean(drawn.xml);
      assert.deepEqual(content(report.nodes).map((node) => node.label), prompt.labels, prompt.text);
      const groups = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
      for (const group of prompt.groups) assert.ok(groups.includes(group), `${prompt.text} ${group}`);
      assert.ok(report.edges.length >= prompt.labels.length - 1, prompt.text);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt.text);
      assertPastel(content(report.nodes), prompt.text);
      assertContainerParents(drawn.xml, prompt.text);
    }
  });

  it("drops a role gloss when a product of that role is already named", () => {
    const prompt = "Postgres stores SQL, and Spaces holds object storage";
    const labels = extractNamedEntities(prompt).map((entity) => entity.label);
    assert.deepEqual(labels, ["Postgres", "Spaces"]);
    const drawn = previewDemo(prompt, STARTER_XML);
    const drawnLabels = content(assertClean(drawn.xml).nodes).map((node) => node.label);
    assert.ok(drawnLabels.includes("Postgres"));
    assert.ok(drawnLabels.includes("Spaces"));
    assert.equal(drawnLabels.includes("Sql"), false);
    assert.equal(drawnLabels.includes("SQL"), false);
    assert.equal(drawnLabels.includes("Object storage"), false);
  });

  it("draws one node per named tier and does not promote a leading verb", () => {
    const prompt =
      "Outline the product as three layers: a SPA for the interface, application servers for the domain, and a Postgres store underneath.";
    const labels = extractNamedEntities(prompt).map((entity) => entity.label);
    for (const label of ["SPA", "Application servers", "Postgres"]) assert.ok(labels.includes(label), labels.join(", "));
    for (const stolen of ["Outline", "Interface", "Domain", "Business logic", "UI", "Store"]) {
      assert.equal(labels.includes(stolen), false, `${stolen} in ${labels.join(", ")}`);
    }
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
    const report = assertClean(drawn.xml);
    const drawnLabels = content(report.nodes).map((node) => node.label);
    assert.deepEqual(drawnLabels, ["SPA", "Application servers", "Postgres"]);
    assert.ok(report.edges.length >= 2);
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    assertPastel(content(report.nodes), prompt);

    const tiers = "Sketch three layers: UI, business logic, and a database.";
    const tierLabels = extractNamedEntities(tiers).map((entity) => entity.label);
    for (const label of ["UI", "Business logic", "Database"]) assert.ok(tierLabels.includes(label), tierLabels.join(", "));
    assert.equal(tierLabels.includes("Sketch"), false);
    const tierDrawn = previewDemo(tiers, STARTER_XML);
    const tierReport = assertClean(tierDrawn.xml);
    const tierNodes = content(tierReport.nodes).map((node) => node.label);
    for (const label of ["UI", "Business logic", "Database"]) assert.ok(tierNodes.includes(label), tierNodes.join(", "));
    assert.equal(tierNodes.includes("Sketch"), false);
    assert.ok(tierReport.edges.length >= 2);
  });

  it("keeps a named database when a data-layer gloss describes it", () => {
    const prompt =
      "Show a product backend in three tiers: a single-page app up top, app servers handling business rules, and MySQL as the data layer";
    const labels = extractNamedEntities(prompt).map((entity) => entity.label);
    assert.deepEqual(labels, ["SPA", "Application servers", "MySQL"]);
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
    const report = assertClean(drawn.xml);
    assert.deepEqual(content(report.nodes).map((node) => node.label), ["SPA", "Application servers", "MySQL"]);
    const groups = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
    for (const group of ["Clients", "Services", "Data"]) assert.ok(groups.includes(group), group);
    assert.ok(report.edges.length >= 2);
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
    assertPastel(content(report.nodes), prompt);
    assertContainerParents(drawn.xml, prompt);
    assertRawDisjoint(drawn.xml, prompt);
    const stacked = content(report.nodes);
    const ys = stacked.map((node) => node.y);
    assert.deepEqual(ys, [...ys].sort((left, right) => left - right));

    const bare = "Sketch three layers: UI, business logic, and a data layer.";
    const bareLabels = extractNamedEntities(bare).map((entity) => entity.label);
    assert.deepEqual(bareLabels, ["UI", "Business logic", "Data"]);

    const rules = "Sketch three layers: UI, business rules, and a data layer.";
    assert.deepEqual(extractNamedEntities(rules).map((entity) => entity.label), ["UI", "Business Rules", "Data"]);

    const named = "Postgres for the data layer beside the API";
    assert.deepEqual(extractNamedEntities(named).map((entity) => entity.label), ["Postgres", "Api"]);
  });

  it("recolors arrows cyan on the stroke and leaves fills and geometry alone", () => {
    const prompt = "Woodpecker sketch: Bundle the artifact first, then Ship onto Render";
    const drawn = previewDemo(prompt, STARTER_XML);
    const report = assertClean(drawn.xml);
    assert.ok(report.edges.length >= 2, report.edges.map((edge) => `${edge.from}->${edge.to}`).join(", "));
    const before = boxes(drawn.xml);
    const fills = content(report.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]);
    const painted = previewDemo("Recolor all arrows cyan", drawn.xml);
    assert.equal(painted.decision.intent, "style");
    assert.equal(painted.decision.slots.colorName, "cyan");
    assert.equal(painted.decision.slots.target, "arrows");
    assert.deepEqual(boxes(painted.xml), before);
    const after = assessDiagram(painted.xml);
    assert.ok(after.edges.every((edge) => edge.style.includes("strokeColor=#0c8599")));
    assert.deepEqual(
      content(after.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]),
      fills,
    );
  });

  it("draws a sign-in choreography as a sequence with message edges", () => {
    const prompt =
      "Careful sign-in choreography: the Mobile App requests a one-time link from Auth0; later the Billing API checks the token.";
    const labels = extractNamedEntities(prompt).map((entity) => entity.label);
    for (const label of ["Mobile App", "Auth0", "Billing API"]) assert.ok(labels.includes(label), labels.join(", "));
    for (const stolen of ["Careful", "Sign-in", "Choreography", "Token", "Link"]) {
      assert.equal(labels.includes(stolen), false, `${stolen} in ${labels.join(", ")}`);
    }
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Drew Architecture/);
    assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
    const report = assertClean(drawn.xml);
    assert.deepEqual(content(report.nodes).map((node) => node.label), ["Mobile App", "Auth0", "Billing API"]);
    assert.ok(content(report.nodes).every((node) => node.style.includes("umlLifeline")));
    assert.ok(report.edges.length >= 2);
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
    assert.ok(report.edges.some((edge) => /link/i.test(edge.label)));
    assert.ok(report.edges.some((edge) => /token/i.test(edge.label)));
    assertPastel(content(report.nodes), prompt);
  });

  it("connects ordered pipeline stages so a connector tint can restyle the stroke", () => {
    const prompt = "Buildkite sketch: Bundle the artifact first, then Promote onto Fly.io";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["Buildkite", "Bundle", "Promote", "Fly.io"]) assert.ok(labels.includes(label), labels.join(", "));
    const ordered = [...content(report.nodes)].sort((left, right) => left.x - right.x).map((node) => node.label);
    for (let index = 1; index < ordered.length; index += 1) {
      const from = ordered[index - 1];
      const to = ordered[index];
      assert.ok(
        report.edges.some((edge) => edge.from === from && edge.to === to),
        `${from} -> ${to} missing from ${report.edges.map((edge) => `${edge.from}->${edge.to}`).join(", ")}`,
      );
    }
    assert.ok(report.edges.every((edge) => edge.label.length > 0));

    const before = boxes(drawn.xml);
    const fills = content(report.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]);
    const tinted = previewDemo("Tint every connector teal", drawn.xml);
    assert.equal(tinted.decision.intent, "style");
    assert.equal(tinted.decision.slots.colorName, "teal");
    assert.deepEqual(boxes(tinted.xml), before);
    const after = assessDiagram(tinted.xml);
    assert.ok(after.edges.length >= 3);
    assert.ok(after.edges.every((edge) => edge.style.includes("strokeColor=#0e8088")));
    assert.deepEqual(
      content(after.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]),
      fills,
    );
  });

  it("draws one node per named step on a path and does not ask for a name", async () => {
    const prompt = "Clinic intake path: greet the patient, record vitals, physician review, treatment, discharge";
    const steps = ["Greet Patient", "Record Vitals", "Physician Review", "Treatment", "Discharge"];
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/);
    assert.match(drawn.decision.reply, /Clinic Intake/);
    const report = assertClean(drawn.xml);
    assert.deepEqual(content(report.nodes).map((node) => node.label), steps);
    assert.ok(report.nodes.some((node) => node.role === "cluster" && node.label === "Steps"));
    assert.deepEqual(
      report.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Greet Patient->Record Vitals", "Record Vitals->Physician Review", "Physician Review->Treatment", "Treatment->Discharge"],
    );
    assert.ok(report.edges.every((edge) => edge.label === "Next"));
    assertPastel(content(report.nodes), prompt);

    process.env.KEV_BASE_URL = "http://kev.local";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions?: Record<string, { type: string }> };
      if (body.questions?.intent) {
        return Response.json({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "add_shape", confidence: 0.87 },
            needs_xml_edit: { type: "noul", noul: 0.9 },
            color: { type: "choice", choice: "none" },
            shape: { type: "choice", choice: "none" },
            layout: { type: "choice", choice: "none" },
            anchor: { type: "choice", choice: "none" },
          },
        });
      }
      return Response.json({
        model: "kev-latest",
        answers: {
          next: { type: "choice", choice: "clarify", confidence: 0.2 },
          confirm: { type: "noul", noul: 0.1 },
        },
      });
    }) as typeof fetch;

    const kev = await runKevTurn({
      messages: [{ role: "user", content: prompt }],
      currentXml: STARTER_XML,
    });
    assert.equal(kev.intent, "add_shape");
    assert.doesNotMatch(kev.reply, /What should the new shape be called/);
    assert.deepEqual(content(assertClean(kev.updatedXml).nodes).map((node) => node.label), steps);
  });

  it("recolors every connector magenta on the stroke and leaves fills and geometry alone", async () => {
    const drawn = previewDemo("Client / API / Postgres", STARTER_XML);
    const report = assertClean(drawn.xml);
    assert.ok(report.edges.length >= 2);
    const before = boxes(drawn.xml);
    const fills = content(report.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]);
    const phrases = ["Recolor every connector magenta", "Paint all connectors magenta", "Tint the arrows magenta"];
    for (const phrase of phrases) {
      const painted = previewDemo(phrase, drawn.xml);
      assert.equal(painted.decision.intent, "style", phrase);
      assert.equal(painted.decision.slots.colorName, "magenta", phrase);
      assert.match(painted.decision.slots.target ?? "", /^(?:arrows?|edges?|connectors?|lines?)$/i, phrase);
      assert.equal(painted.decision.slots.from ?? null, null, phrase);
      assert.equal(painted.decision.slots.to ?? null, null, phrase);
      assert.deepEqual(boxes(painted.xml), before, phrase);
      const after = assessDiagram(painted.xml);
      assert.equal(after.edges.length, report.edges.length, phrase);
      for (const edge of after.edges) {
        const stroke = edge.style.match(/strokeColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
        assert.ok(stroke, phrase);
        const hue = hexHue(stroke);
        assert.ok(hue >= 260 && hue <= 340, `${phrase} stroke ${stroke} hue ${hue}`);
        assert.equal(stroke, "#c026d3", phrase);
      }
      assert.deepEqual(
        content(after.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]),
        fills,
        phrase,
      );
      assert.ok(
        content(after.nodes).every((node) => !node.style.includes("fillColor=#fad7e4")),
        phrase,
      );
    }

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.KEV_BASE_URL = "http://kev.local";
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return Response.json({
        model: "kev-latest",
        answers: {
          intent: { type: "choice", choice: "style", confidence: 0.92 },
          needs_xml_edit: { type: "noul", noul: 0.9 },
          color: { type: "choice", choice: "pink" },
          anchor: { type: "choice", choice: "none" },
          source: { type: "choice", choice: "none" },
          target: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;
    const hosted = await runKevTurn({
      messages: [{ role: "user", content: "Recolor every connector magenta" }],
      currentXml: drawn.xml,
    });
    assert.equal(called, 0);
    assert.equal(hosted.intent, "style");
    assert.match(hosted.reply, /connector/i);
    assert.doesNotMatch(hosted.reply, /pink/i);
    const hostedReport = assessDiagram(hosted.updatedXml);
    assert.deepEqual(boxes(hosted.updatedXml), before);
    assert.ok(hostedReport.edges.every((edge) => edge.style.includes("strokeColor=#c026d3")));
    assert.deepEqual(
      content(hostedReport.nodes).map((node) => node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]),
      fills,
    );
  });

  it("draws one vertex per named product and does not steal a cache or vpc sketch", () => {
    const prompts = [
      "Outline a hosting runtime: Heroku Dyno, Heroku Postgres, and Redis Cloud.",
      "Diagram Heroku Dyno, Heroku Postgres, and Redis Cloud.",
      "A cloud architecture that includes a Heroku Dyno, Heroku Postgres, and Redis Cloud.",
    ];
    const wanted = ["Heroku Dyno", "Heroku Postgres", "Redis Cloud"];
    const stolen = ["Client", "App", "Redis cache", "Replica", "Persistence", "Database", "ALB", "ECS", "RDS", "Internet", "Heroku"];
    for (const prompt of prompts) {
      const labels = extractNamedEntities(prompt).map((entity) => entity.label);
      for (const label of wanted) assert.ok(labels.includes(label), `${prompt} → ${labels.join(", ")}`);
      for (const label of stolen) assert.equal(labels.includes(label), false, `${prompt} stole ${label}`);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      assert.doesNotMatch(drawn.decision.reply, /Redis cache usage/);
      assert.doesNotMatch(drawn.decision.reply, /AWS VPC/);
      assert.doesNotMatch(drawn.decision.reply, /Client → App/);
      const report = assertClean(drawn.xml);
      const drawnLabels = content(report.nodes).map((node) => node.label);
      assert.deepEqual(drawnLabels, wanted, prompt);
      const postgres = content(report.nodes).find((node) => node.label === "Heroku Postgres");
      const cache = content(report.nodes).find((node) => node.label === "Redis Cloud");
      assert.ok(postgres?.style.includes("shape=cylinder3"), prompt);
      assert.ok(cache?.style.includes("shape=cylinder3"), prompt);
      const groups = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
      assert.ok(groups.includes("Services"), prompt);
      assert.ok(groups.includes("Data"), prompt);
      assert.ok(report.edges.length >= 2, prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      assert.ok(
        report.edges.some((edge) => edge.from === "Heroku Dyno" && edge.to === "Heroku Postgres"),
        prompt,
      );
      assert.ok(
        report.edges.some((edge) => edge.from === "Heroku Dyno" && edge.to === "Redis Cloud"),
        prompt,
      );
      assertPastel(content(report.nodes), prompt);
      assertContainerParents(drawn.xml, prompt);
    }
  });
});
