import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { PALETTE } from "../src/lib/drawio/styles";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { parseArchitecture } from "../src/lib/kev/plan";
import { researchTopic, wikipediaTitle } from "../src/lib/kev/research";

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

function assertPastel(nodes: QualityNode[], prompt: string) {
  assert.ok(nodes.length >= 2, prompt);
  for (const node of nodes) {
    const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
    assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", `${prompt} ${node.label} fill ${fill}`);
  }
}

function labelsOf(xml: string): { nodes: string[]; clusters: string[] } {
  const report = assertClean(xml);
  return {
    nodes: content(report.nodes).map((node) => node.label),
    clusters: report.nodes.filter((node) => node.role === "cluster").map((node) => node.label),
  };
}

describe("subsystem expansion", () => {
  const kvPrompts = [
    "Draw a subsystem of general purpose KV caching storage and its interactions",
    "draw a subsystem of general purpose kv caching storage and its interactions",
    "Sketch a subsystem of general-purpose KV caching storage and its interactions",
  ];

  for (const prompt of kvPrompts) {
    it(`expands a KV cache subsystem instead of noun scraps: ${prompt}`, () => {
      assert.equal(parseArchitecture(prompt), null);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape");
      const report = assertClean(drawn.xml);
      const nodes = content(report.nodes);
      const labels = nodes.map((node) => node.label);
      assert.ok(labels.length >= 6, labels.join(", "));
      for (const expected of ["Clients", "Cache API", "Cache tier", "Key index", "Eviction / TTL", "Replication", "Backing store"]) {
        assert.ok(labels.includes(expected), `${prompt} missing ${expected}: ${labels.join(", ")}`);
      }
      assert.equal(labels.includes("General Purpose"), false, labels.join(", "));
      assert.equal(labels.includes("Storage"), false, labels.join(", "));
      assert.equal(labels.includes("Interactions"), false, labels.join(", "));
      const clusters = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
      assert.ok(clusters.length >= 4, clusters.join(", "));
      for (const cluster of ["Clients", "Edge", "Cache", "Storage"]) {
        assert.ok(clusters.includes(cluster), clusters.join(", "));
      }
      assert.ok(report.edges.length >= 6);
      assert.ok(report.edges.every((edge) => edge.label.length > 0));
      assertPastel(nodes, prompt);
    });
  }

  it("keeps a left-to-right KV subsystem in one row without overlaps", () => {
    const prompt = "Draw a subsystem of general purpose KV caching storage and its interactions left to right";
    const drawn = previewDemo(prompt, STARTER_XML);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.ok(labels.includes("Cache tier"));
    assert.ok(labels.includes("Backing store"));
    const boxes = content(report.nodes);
    const ordered = [...boxes].sort((left, right) => left.x - right.x);
    assert.ok((ordered[0]?.x ?? 0) < (ordered[ordered.length - 1]?.x ?? 0));
    assert.equal(labels.includes("General Purpose"), false);
  });

  it("expands a message-queue subsystem the same way", () => {
    const prompts = [
      "Draw a subsystem of message queueing and its interactions",
      "Sketch how a message broker subsystem works",
    ];
    for (const prompt of prompts) {
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      const report = assertClean(drawn.xml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.length >= 6, `${prompt} ${labels.join(", ")}`);
      for (const expected of ["Producers", "Broker", "Consumers", "Acknowledgements", "Retention", "Dead-letter queue"]) {
        assert.ok(labels.includes(expected), `${prompt} missing ${expected}: ${labels.join(", ")}`);
      }
      assert.equal(labels.includes("Queueing"), false, prompt);
      assert.equal(labels.includes("Interactions"), false, prompt);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      assertPastel(content(report.nodes), prompt);
    }
  });

  it("expands an unknown subsystem from the topic instead of two noun phrases", () => {
    const prompts = [
      { text: "Draw a subsystem of feature flag delivery and its interactions", stem: /feature flag/i },
      { text: "Draw a subsystem of distributed rate limiting and its interactions", stem: /rate limiting/i },
    ];
    for (const prompt of prompts) {
      const drawn = previewDemo(prompt.text, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt.text);
      const report = assertClean(drawn.xml);
      const labels = content(report.nodes).map((node) => node.label);
      assert.ok(labels.length >= 6, `${prompt.text} ${labels.join(", ")}`);
      assert.ok(labels.some((label) => prompt.stem.test(label)), `${prompt.text} ${labels.join(", ")}`);
      for (const expected of ["Clients", "Coordinator", "Policy", "State store", "Peers"]) {
        assert.ok(labels.includes(expected), `${prompt.text} missing ${expected}`);
      }
      assert.equal(labels.includes("Interactions"), false, prompt.text);
      assert.ok(report.nodes.filter((node) => node.role === "cluster").length >= 4, prompt.text);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt.text);
      assertPastel(content(report.nodes), prompt.text);
    }
  });

  it("keeps a short N-tier stack, a named chain, and listed components", () => {
    const tier = labelsOf(previewDemo("draw a 3-tier web app", STARTER_XML).xml);
    assert.deepEqual(tier.nodes, ["Client", "App", "Postgres"]);

    const chain = labelsOf(previewDemo("Client → App → Postgres", STARTER_XML).xml);
    assert.deepEqual(chain.nodes, ["Client", "App", "Postgres"]);

    const named = labelsOf(
      previewDemo("Draw a subsystem of Client, API, and Postgres and its interactions", STARTER_XML).xml,
    );
    assert.deepEqual(named.nodes, ["Client", "API", "Postgres"]);
    assert.equal(named.nodes.includes("Cache tier"), false);
    assert.equal(named.nodes.includes("Interactions"), false);
  });

  it("restyles connector strokes without moving a stack", () => {
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

  it("researches an open subsystem from a built-in brief when the network is down", async () => {
    const prompt = "Draw a subsystem of general purpose KV caching storage and its interactions";
    assert.equal(wikipediaTitle(prompt), "Cache (computing)");
    assert.equal(wikipediaTitle("draw a 3 tier web app"), null);
    assert.equal(wikipediaTitle("Make the API box red"), null);
    let called = false;
    const brief = await researchTopic(prompt, {
      network: true,
      fetch: async () => {
        called = true;
        throw new Error("offline");
      },
    });
    assert.equal(called, true);
    assert.equal(brief?.source, "builtin");
    assert.equal(brief?.topic, "Cache (computing)");
    assert.match(brief?.summary ?? "", /backing store/);
    assert.match(brief?.summary ?? "", /eviction/i);

    const offline = await researchTopic("Draw a subsystem of feature flag delivery and its interactions", {
      network: false,
    });
    assert.equal(offline?.source, "builtin");
    assert.match(offline?.summary ?? "", /feature flag/i);
  });
});
