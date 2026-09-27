import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { summarizeDiagram } from "../src/lib/drawio/xml";
import { previewDemo } from "../src/lib/kev/demo";
import { acceptArchitectureStep, acceptTemplateStep, buildOrchestratorStepRequest, buildSpecificityRequest } from "../src/lib/kev/orchestrate";
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

function labels(xml: string): string[] {
  return summarizeDiagram(xml).vertices.map((vertex) => vertex.label);
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
    assert.ok(labels(xml).includes("App"));
    assert.ok(summary.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
    assert.ok(summary.edges.some((edge) => edge.from === "App" && edge.to === "Postgres"));
    assert.ok(summary.vertices.every((vertex) => vertex.style.includes("fillColor=#ffe6cc")));
    assert.equal(new Set(summary.vertices.map((vertex) => vertex.y)).size, 1);
    const byLabel = new Map(summary.vertices.map((vertex) => [vertex.label, vertex.x]));
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
    assert.deepEqual(
      summary.vertices.map((vertex) => vertex.label),
      ["Client", "App", "Postgres"],
    );
    assert.deepEqual(
      summary.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Postgres"],
    );
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
    assert.match(request.state, /Current diagram mxfile/);
    assert.match(request.state, /value="API"/);
    assert.match(request.state, /Proposed next edit/);
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
    assert.equal(request.questions.specific?.type, "noul");
    assert.equal(request.questions.next?.type, "choice");
  });
});
