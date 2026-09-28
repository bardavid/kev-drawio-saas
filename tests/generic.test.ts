import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDiagram, type QualityNode, type QualityReport } from "../src/lib/drawio/layout";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { composeNamed } from "../src/lib/kev/generic";
import { matchTemplate } from "../src/lib/kev/templates";

function content(nodes: QualityNode[]): QualityNode[] {
  return nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor");
}

function assertClean(xml: string): QualityReport {
  const report = assessDiagram(xml);
  assert.deepEqual(report.overlaps, [], `overlaps: ${JSON.stringify(report.overlaps)}`);
  assert.deepEqual(report.crossings, [], `crossings: ${JSON.stringify(report.crossings)}`);
  return report;
}

const PASTEL_FILL = /fillColor=#(?:dae8fc|d5e8d4|ffe6cc|fff2cc|f8cecc|e1d5e7|f5f5f5|d5e8e4|fad7e4)\b/i;

describe("generic named composition", () => {
  it("draws a novel cloud phrasing without a dedicated template", () => {
    const prompt = "Sketch a checkout platform with Cloudflare, a Go API, Postgres, and Redis.";
    assert.equal(matchTemplate(prompt)?.spec.title, "Architecture");
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.equal(drawn.decision.reply.includes("Which nodes should I draw"), false);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["Cloudflare", "Go API", "Postgres", "Redis"]) {
      assert.ok(labels.includes(label), label);
    }
    for (const stolen of ["API Gateway", "Lambda", "DynamoDB", "ALB", "ECS", "Cloud Run", "Event broker"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }
    assert.ok(content(report.nodes).every((node) => PASTEL_FILL.test(node.style)));
    assert.ok(report.edges.length > 0 && report.edges.every((edge) => edge.label.trim().length > 0));
    const clusters = report.nodes.filter((node) => node.role === "cluster").map((node) => node.label);
    for (const label of ["Clients", "Edge", "Compute", "Data", "Cache"]) {
      assert.ok(clusters.includes(label), label);
    }
  });

  it("draws a paraphrased delivery pipeline that is not the CI/CD sentence", () => {
    const prompt = "Please diagram a delivery pipeline: Lint, then Compile, then Ship.";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.equal(drawn.decision.reply.includes("Which nodes should I draw"), false);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.deepEqual(labels, ["Lint", "Compile", "Ship"]);
    assert.equal(labels.includes("GitHub Actions"), false);
    assert.equal(labels.includes("Deploy to Vercel"), false);
    assert.ok(content(report.nodes).every((node) => PASTEL_FILL.test(node.style)));
    assert.ok(report.edges.every((edge) => edge.label.trim().length > 0));
    assert.ok(report.edges.some((edge) => edge.from === "Lint" && edge.to === "Compile" && edge.label === "Compile"));
    assert.ok(report.edges.some((edge) => edge.from === "Compile" && edge.to === "Ship" && edge.label === "Ship"));
  });

  it("draws synonym queue names and does not steal the serverless stack", () => {
    const prompt =
      "Illustrate an amazon setup that uses a content network called CloudFront, Simple Storage Service, a Lambda function, and DynamoDB.";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.reply.includes("Which nodes should I draw"), false);
    const labels = content(assertClean(drawn.xml).nodes).map((node) => node.label);
    for (const label of ["CloudFront", "S3", "Lambda", "DynamoDB"]) assert.ok(labels.includes(label), label);
    assert.equal(labels.includes("API Gateway"), false);
    assert.equal(labels.includes("SQS"), false);
  });

  it("draws named states from a paraphrase instead of the order lifecycle", () => {
    const prompt = "Map this state machine — queued, packing, handed off, received.";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    const labels = content(assertClean(drawn.xml).nodes).map((node) => node.label);
    assert.deepEqual(labels, ["Queued", "Packing", "Handed Off", "Received"]);
    for (const stolen of ["Placed", "Paid", "Shipped", "Draft", "Published"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }
  });

  it("does not compose an insert-between edit as a new diagram", () => {
    assert.equal(composeNamed("add Test between Build and Deploy"), null);
  });
});
