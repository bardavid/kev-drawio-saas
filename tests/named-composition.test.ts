import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assessDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { PALETTE } from "../src/lib/drawio/styles";
import { STARTER_XML } from "../src/lib/drawio/starter";
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

function assertPastel(nodes: QualityNode[], prompt: string) {
  assert.ok(nodes.length >= 2, prompt);
  for (const node of nodes) {
    const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
    assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${prompt} ${node.label} fill ${fill}`);
  }
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
});
