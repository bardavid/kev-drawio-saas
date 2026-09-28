import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDiagram } from "../src/lib/drawio/layout";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { cellLabel, geometryOf, listVertices, openDiagram, summarizeDiagram } from "../src/lib/drawio/xml";
import { previewDemo } from "../src/lib/kev/demo";
import {
  acceptArchitectureStep,
  acceptTemplateStep,
  buildCompositionRequest,
  buildOrchestratorStepRequest,
  buildSpecificityRequest,
} from "../src/lib/kev/orchestrate";
import { isArchitectureRequest, isBareDraw, parseArchitecture, planOperations } from "../src/lib/kev/plan";

const PROMPTS = [
  "draw a Complex 3 Tier Web App: Client → Postgres, orange, horizontal",
  "draw a Complex 3 Tier Web App Client to Postgres orange horizontal",
];

const EMPTY_XML = `<mxfile host="embed.diagrams.net" agent="draw.ai">
  <diagram id="architecture" name="Architecture">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

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
      if (!a || !b || a.parent === b.id || b.parent === a.id) continue;
      const width = Math.max(0, Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x));
      const height = Math.max(0, Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y));
      assert.equal(width * height, 0, `${prompt} ${a.label} overlaps ${b.label}`);
    }
  }
}

function assertContained(xml: string, prompt: string) {
  const doc = openDiagram(xml);
  const vertices = listVertices(doc);
  const byId = new Map(vertices.map((vertex) => [vertex.getAttribute("id") ?? "", vertex]));
  for (const vertex of vertices) {
    if (!(vertex.getAttribute("style") ?? "").includes("drawai=node")) continue;
    const parent = byId.get(vertex.getAttribute("parent") ?? "");
    assert.ok(parent, `${prompt} ${cellLabel(vertex)} has no container`);
    const box = geometryOf(vertex);
    const frame = geometryOf(parent!);
    assert.ok(box.x >= -1 && box.y >= -1, `${prompt} ${cellLabel(vertex)} origin`);
    assert.ok(box.x + box.width <= frame.width + 2, `${prompt} ${cellLabel(vertex)} width`);
    assert.ok(box.y + box.height <= frame.height + 2, `${prompt} ${cellLabel(vertex)} height`);
  }
}

describe("architecture plan", () => {
  for (const prompt of PROMPTS) {
    it(`reads a 3-tier chain from “${prompt.slice(0, 42)}…”`, () => {
      const plan = parseArchitecture(prompt);
      assert.ok(plan);
      assert.equal(plan.title, "Complex 3 Tier Web App");
      assert.deepEqual(plan.nodes, ["Client", "App", "Postgres"]);
      assert.equal(plan.colorName, "orange");
      assert.equal(plan.layout, "horizontal");
      assert.equal(isArchitectureRequest(prompt), true);
    });
  }

  it("asks what to draw when the message is only the verb", () => {
    const { decision, xml } = previewDemo("draw", STARTER_XML);
    assert.equal(decision.intent, "clarify");
    assert.match(decision.reply, /What should I draw/);
    assert.equal(xml, STARTER_XML);
  });

  it("does not treat a bare draw, a greeting, or a single edit as an architecture", () => {
    assert.equal(isBareDraw("draw"), true);
    assert.equal(isBareDraw("draw a diagram"), true);
    assert.equal(isBareDraw("draw a client"), false);
    assert.equal(parseArchitecture("draw"), null);
    assert.equal(parseArchitecture("hello"), null);
    assert.equal(parseArchitecture("Make the API box red"), null);
    assert.equal(parseArchitecture("Connect the client to Postgres"), null);
    assert.equal(parseArchitecture("Add a Redis cache in front of the database"), null);
    assert.equal(parseArchitecture("Lay the diagram out vertically"), null);
  });

  it("keeps an explicit three-node chain and defaults a bare 3-tier web app", () => {
    assert.deepEqual(parseArchitecture("draw Client → API → Postgres")?.nodes, ["Client", "API", "Postgres"]);
    assert.deepEqual(parseArchitecture("draw a 3 tier web app")?.nodes, ["Client", "App", "Postgres"]);
    assert.equal(parseArchitecture("draw a 3 tier web app")?.layout, "horizontal");
    assert.equal(parseArchitecture("draw a 3 tier web app vertically")?.layout, "vertical");
  });

  it("draws a default stack for a short N-tier ask that never says draw", () => {
    const prompts = [
      "three tier web app",
      "just a simple three tier web app",
      "3-tier architecture",
      "3 tier architecture",
      "a three-tier web application",
      "simple 3-tier system",
    ];
    for (const prompt of prompts) {
      const plan = parseArchitecture(prompt);
      assert.ok(plan, prompt);
      assert.equal(isArchitectureRequest(prompt), true, prompt);
      assert.deepEqual(plan.nodes, ["Client", "App", "Postgres"], prompt);
      assert.equal(plan.layout, "horizontal", prompt);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/, prompt);
      assert.match(drawn.decision.reply, /Client → App → Postgres/, prompt);
      const summary = summarizeDiagram(drawn.xml);
      const shapes = summary.vertices.filter((vertex) => !vertex.style.includes("drawai=cluster"));
      const clusters = summary.vertices.filter((vertex) => vertex.style.includes("drawai=cluster"));
      assert.deepEqual(
        shapes.map((vertex) => vertex.label),
        ["Client", "App", "Postgres"],
        prompt,
      );
      assert.deepEqual(
        summary.edges.map((edge) => `${edge.from}->${edge.to}`),
        ["Client->App", "App->Postgres"],
        prompt,
      );
      assert.deepEqual(
        summary.edges.map((edge) => edge.label),
        ["HTTPS", "Query"],
        prompt,
      );
      assert.deepEqual(
        clusters.map((vertex) => vertex.label),
        ["Clients", "Services", "Data"],
        prompt,
      );
      assert.ok(
        shapes.every((vertex) => /fillColor=#[0-9a-f]{6}/i.test(vertex.style) && !vertex.style.includes("fillColor=#ffffff")),
        prompt,
      );
      const client = shapes.find((vertex) => vertex.label === "Client");
      const app = shapes.find((vertex) => vertex.label === "App");
      const postgres = shapes.find((vertex) => vertex.label === "Postgres");
      assert.match(client?.style ?? "", /fillColor=#ffe6cc/, prompt);
      assert.match(app?.style ?? "", /fillColor=#d5e8d4/, prompt);
      assert.match(postgres?.style ?? "", /fillColor=#dae8fc/, prompt);
      assert.match(postgres?.style ?? "", /cylinder3/, prompt);
      assert.ok(client && app && postgres);
      assert.ok(client.x < app.x && app.x < postgres.x, prompt);
    }

    assert.deepEqual(parseArchitecture("two tier web app")?.nodes, ["Client", "API"]);
    assert.deepEqual(parseArchitecture("four tier architecture")?.nodes, ["Client", "App", "Service 2", "Postgres"]);
    assert.equal(parseArchitecture("Add a cache to the 3-tier web app"), null);
    assert.equal(isArchitectureRequest("Add a cache to the 3-tier web app"), false);
  });

  it("draws a default stack for layer-count paraphrases and keeps tier rows from stacking", () => {
    const prompts = [
      "a basic three-layer web application",
      "three-layer web application",
      "3-layer web application",
      "3 layer web app",
      "three layers web application",
      "plain 3 tier system for a website",
    ];
    for (const prompt of prompts) {
      const plan = parseArchitecture(prompt);
      assert.ok(plan, prompt);
      assert.deepEqual(plan.nodes, ["Client", "App", "Postgres"], prompt);
      assert.equal(plan.layout, "horizontal", prompt);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/, prompt);
      assert.match(drawn.decision.reply, /Client → App → Postgres/, prompt);
      const report = assessDiagram(drawn.xml);
      assert.deepEqual(report.overlaps, [], prompt);
      assert.deepEqual(report.crossings, [], prompt);
      const shapes = report.nodes.filter((node) => node.role !== "cluster");
      const clusters = report.nodes.filter((node) => node.role === "cluster");
      assert.deepEqual(
        shapes.map((node) => node.label),
        ["Client", "App", "Postgres"],
        prompt,
      );
      assert.deepEqual(
        report.edges.map((edge) => `${edge.from}->${edge.to}`),
        ["Client->App", "App->Postgres"],
        prompt,
      );
      assert.deepEqual(
        report.edges.map((edge) => edge.label),
        ["HTTPS", "Query"],
        prompt,
      );
      assert.deepEqual(
        clusters.map((node) => node.label),
        ["Clients", "Services", "Data"],
        prompt,
      );
      assert.ok(
        shapes.every((node) => /fillColor=#[0-9a-f]{6}/i.test(node.style) && !node.style.includes("fillColor=#ffffff")),
        prompt,
      );
      const client = shapes.find((node) => node.label === "Client");
      const app = shapes.find((node) => node.label === "App");
      const postgres = shapes.find((node) => node.label === "Postgres");
      assert.ok(client && app && postgres);
      assert.ok(client.x < app.x && app.x < postgres.x, prompt);
      assert.equal(client.y, app.y, prompt);
      assert.equal(app.y, postgres.y, prompt);
      assertRawDisjoint(drawn.xml, prompt);
      assertContained(drawn.xml, prompt);
    }

    assert.equal(parseArchitecture("Add a cache to the 3-layer web app"), null);
    assert.equal(isArchitectureRequest("Add a cache to the 3-layer web app"), false);
    assert.equal(parseArchitecture("Add a cache to the three-layer web application"), null);
  });

  it("keeps Redis on a 3-tier web app that asks for a Redis cache", () => {
    for (const prompt of [
      "draw a 3-tier web app with Redis cache",
      "draw a 3 tier web app with a Redis cache",
      "draw a three-tier web app with Redis",
      "draw a 3-tier web application diagram with Redis cache",
    ]) {
      assert.deepEqual(parseArchitecture(prompt)?.nodes, ["Client", "App", "Redis", "Postgres"], prompt);
      const drawn = previewDemo(prompt, EMPTY_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      assert.match(drawn.decision.reply, /Redis/, prompt);
      assert.doesNotMatch(drawn.decision.reply, /Client → App → Postgres\./, prompt);
      const summary = summarizeDiagram(drawn.xml);
      const shapes = summary.vertices.filter((vertex) => !vertex.style.includes("drawai=cluster"));
      assert.deepEqual(
        shapes.map((vertex) => vertex.label),
        ["Client", "App", "Redis", "Postgres"],
        prompt,
      );
      assert.ok(summary.vertices.some((vertex) => vertex.style.includes("drawai=cluster")), prompt);
      assert.ok(summary.edges.every((edge) => edge.label.length > 0), prompt);
      assert.deepEqual(
        summary.edges.map((edge) => `${edge.from}->${edge.to}`),
        ["Client->App", "App->Redis", "Redis->Postgres"],
        prompt,
      );
    }

    const drawn = previewDemo("draw a 3-tier web app with Redis cache", EMPTY_XML);
    const renamed = previewDemo("rename Redis to Cache", drawn.xml);
    assert.equal(renamed.decision.intent, "edit_shape");
    assert.match(renamed.decision.reply, /Renamed Redis to Cache/);
    const labelsAfter = summarizeDiagram(renamed.xml)
      .vertices.filter((vertex) => !vertex.style.includes("drawai=cluster"))
      .map((vertex) => vertex.label);
    assert.deepEqual(labelsAfter, ["Client", "App", "Cache", "Postgres"]);
    assert.deepEqual(
      summarizeDiagram(renamed.xml).edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Cache", "Cache->Postgres"],
    );
  });

  it("plans a new middle tier, a missing edge, orange, and a horizontal reflow on an existing architecture", () => {
    const operations = planOperations(PROMPTS[0]!, SEEDED_XML);
    assert.deepEqual(
      operations.map((operation) => operation.intent),
      ["add_shape", "connect", "style", "layout"],
    );
    assert.equal(operations[0]?.slots.label, "App");
    assert.equal(operations[0]?.slots.shape, "rectangle");
    assert.equal(operations[0]?.slots.from, "Client");
    assert.equal(operations[0]?.slots.fillColor, "#ffe6cc");
    assert.equal(operations[1]?.slots.from, "App");
    assert.equal(operations[1]?.slots.to, "Postgres");
    assert.equal(operations[2]?.slots.colorName, "orange");
    assert.equal(operations[2]?.slots.fillColor, "#ffe6cc");
    assert.equal(operations[2]?.slots.strokeColor, "#d79b00");
    assert.deepEqual(operations[3]?.slots.sequence, ["Client", "App", "Postgres"]);
  });

  it("draws the chain in demo mode without a model", () => {
    const { decision, xml } = previewDemo(PROMPTS[0]!, STARTER_XML);
    assert.equal(decision.intent, "add_shape");
    assert.equal(decision.slots.label, "Complex 3 Tier Web App");
    assert.equal(decision.slots.fillColor, "#ffe6cc");
    assert.equal(decision.slots.layout, "horizontal");
    assert.notEqual(xml, STARTER_XML);
    const summary = summarizeDiagram(xml);
    const shapes = summary.vertices.filter((vertex) => !vertex.style.includes("drawai=cluster"));
    assert.ok(shapes.some((vertex) => vertex.label === "App"));
    assert.ok(summary.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
    assert.ok(summary.edges.some((edge) => edge.from === "App" && edge.to === "Postgres"));
    assert.ok(summary.edges.every((edge) => edge.label.length > 0));
    assert.ok(summary.vertices.some((vertex) => vertex.style.includes("drawai=cluster")));
    assert.ok(shapes.every((vertex) => vertex.style.includes("fillColor=#ffe6cc")));
    const byLabel = new Map(shapes.map((vertex) => [vertex.label, vertex.x]));
    assert.ok((byLabel.get("Client") ?? 0) < (byLabel.get("App") ?? 0));
    assert.ok((byLabel.get("App") ?? 0) < (byLabel.get("Postgres") ?? 0));
  });

  it("edits an existing architecture instead of replacing it", () => {
    const { xml } = previewDemo("draw a 3 tier web app", SEEDED_XML);
    const summary = summarizeDiagram(xml);
    assert.ok(summary.vertices.some((vertex) => vertex.label === "API"));
    assert.ok(summary.vertices.some((vertex) => vertex.label === "App"));
    assert.ok(summary.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
  });

  it("creates client, app, and a postgres cylinder on an empty diagram", () => {
    const xml = previewDemo("draw a 3 tier web app", EMPTY_XML).xml;
    const summary = summarizeDiagram(xml);
    const shapes = summary.vertices.filter((vertex) => !vertex.style.includes("drawai=cluster"));
    assert.deepEqual(
      shapes.map((vertex) => vertex.label),
      ["Client", "App", "Postgres"],
    );
    assert.deepEqual(
      summary.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Postgres"],
    );
    assert.ok(summary.edges.every((edge) => edge.label.length > 0));
    assert.ok(summary.vertices.some((vertex) => vertex.style.includes("drawai=cluster")));
    const postgres = summary.vertices.find((vertex) => vertex.label === "Postgres");
    assert.match(postgres?.style ?? "", /cylinder3/);
  });
});

describe("architecture gate", () => {
  it("applies a planned edit when confirm is 0.43 and next is not apply", () => {
    assert.equal(acceptArchitectureStep("noop", 0.43), true);
    assert.equal(acceptArchitectureStep("clarify", 0.43), true);
    assert.equal(acceptArchitectureStep(null, 0.43), true);
    assert.equal(acceptArchitectureStep("apply", 0.43), true);
  });

  it("uses a template only when the model applies it", () => {
    assert.equal(acceptTemplateStep("apply", 0.43), true);
    assert.equal(acceptTemplateStep("noop", 0.43), false);
    assert.equal(acceptTemplateStep("clarify", 0.9), false);
    assert.equal(acceptTemplateStep(null, 0.2), false);
    assert.equal(acceptTemplateStep(null, 0.8), true);
  });
});

describe("orchestrator questions", () => {
  it("asks Jev to apply or refuse one proposed edit and to fill shape and color", () => {
    const [proposal] = planOperations(PROMPTS[1]!, SEEDED_XML);
    assert.ok(proposal);
    const request = buildOrchestratorStepRequest({
      userMessage: PROMPTS[1]!,
      summary: summarizeDiagram(SEEDED_XML),
      proposal,
      remaining: 3,
      applied: [],
      currentXml: SEEDED_XML,
    });
    assert.match(request.state, /STRATEGY/);
    assert.match(request.state, /Do not invent a Stage from placement fluff/);
    assert.match(request.state, /Current diagram mxfile/);
    assert.match(request.state, /value="API"/);
    assert.match(request.state, /Proposed next edit/);
    assert.match(request.questions.next?.instructions ?? "", /→ apply/);
    assert.match(request.questions.next?.instructions ?? "", /→ clarify/);
    assert.match(request.questions.next?.instructions ?? "", /→ noop/);
    assert.match(request.questions.confirm?.instructions ?? "", /→ yes/);
    assert.match(request.questions.confirm?.instructions ?? "", /→ no/);
    assert.match(request.questions.color?.instructions ?? "", /If a color word is present → that color/);
    assert.match(request.questions.color?.instructions ?? "", /Else → none/);
    assert.match(request.state, /App/);
    assert.equal(request.questions.next?.type, "choice");
    assert.equal(request.questions.confirm?.type, "noul");
    assert.equal(request.questions.shape?.type, "choice");
    assert.equal(request.questions.color?.type, "choice");
    const criteria = request.questions.next?.criteria as Record<string, string>;
    assert.match(criteria.apply ?? "", /App/);
    assert.equal(typeof criteria.noop, "string");
    assert.equal(typeof criteria.clarify, "string");
  });

  it("asks whether a bare draw names anything concrete", () => {
    const request = buildSpecificityRequest({
      userMessage: "draw",
      summary: summarizeDiagram(STARTER_XML),
    });
    assert.match(request.state, /STRATEGY/);
    assert.equal(request.questions.specific?.type, "noul");
    assert.match(request.questions.specific?.instructions ?? "", /→ yes/);
    assert.match(request.questions.specific?.instructions ?? "", /no subject → no/);
    assert.equal(request.questions.next?.type, "choice");
    assert.match(request.questions.next?.instructions ?? "", /→ clarify/);
    assert.match(request.questions.next?.instructions ?? "", /→ noop/);
  });

  it("asks composition phases with a style color fork", () => {
    const summary = summarizeDiagram(STARTER_XML);
    const outline = buildCompositionRequest({
      userMessage: "draw a login sequence",
      summary,
      plan: "Phase: outline\nConfirm these nodes",
      phase: "outline",
    });
    assert.match(outline.state, /STRATEGY/);
    assert.match(outline.state, /If it fits the request → use it/);
    assert.match(outline.questions.next?.instructions ?? "", /→ apply/);
    assert.match(outline.questions.next?.instructions ?? "", /→ clarify/);
    assert.match(outline.questions.confirm?.instructions ?? "", /→ yes/);
    assert.match(outline.questions.confirm?.instructions ?? "", /→ no/);
    assert.equal(outline.questions.color, undefined);

    const style = buildCompositionRequest({
      userMessage: "draw a login sequence",
      summary,
      plan: "Phase: style\nConfirm the drawing",
      phase: "style",
    });
    assert.match(style.questions.color?.instructions ?? "", /If a color word is present → that color/);
    assert.match(style.questions.color?.instructions ?? "", /Else → none/);
    assert.match(style.questions.next?.instructions ?? "", /Stage from placement fluff → clarify/);
  });
});
