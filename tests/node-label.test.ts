import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDiagram } from "../src/lib/drawio/layout";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { parseNodeToEdgeLabel } from "../src/lib/kev/mutate";
import { OPEN_IDEA_REPLY } from "../src/lib/kev/scale";
import { runKevTurn } from "../src/lib/kev/run";
import { summarizeDiagram } from "../src/lib/drawio/xml";

function labelsOf(xml: string): string[] {
  return assessDiagram(xml)
    .nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor")
    .map((node) => node.label);
}

function edgeBetween(xml: string, from: string, to: string): string | undefined {
  return assessDiagram(xml).edges.find((edge) => edge.from === from && edge.to === to)?.label;
}

describe("node to edge label", () => {
  it("recognizes generic phrasing and ignores color edits", () => {
    assert.deepEqual(parseNodeToEdgeLabel("make Quill a label"), { query: "Quill" });
    assert.deepEqual(parseNodeToEdgeLabel("turn the Quill node into a label"), { query: "Quill" });
    assert.deepEqual(parseNodeToEdgeLabel("make Quill an edge label"), { query: "Quill" });
    assert.deepEqual(parseNodeToEdgeLabel("use Quill as an edge label"), { query: "Quill" });
    assert.deepEqual(parseNodeToEdgeLabel("labels instead of nodes for Quill"), { query: "Quill" });
    assert.deepEqual(parseNodeToEdgeLabel("Quill labels instead of nodes"), { query: "Quill" });
    assert.deepEqual(parseNodeToEdgeLabel("turn this node into a label"), { query: null });
    assert.deepEqual(parseNodeToEdgeLabel("make it an edge label"), { query: null });
    assert.equal(parseNodeToEdgeLabel("make Quill red"), null);
    assert.equal(parseNodeToEdgeLabel("make the arrows blue"), null);
    assert.equal(parseNodeToEdgeLabel("You figure out names"), null);
  });

  it("moves a middle node onto the bridge edge and deletes it", () => {
    const chain = previewDemo("Lantern → Quill → Bodega", STARTER_XML);
    assert.deepEqual(labelsOf(chain.xml).sort(), ["Bodega", "Lantern", "Quill"]);
    const edited = previewDemo("make Quill a label", chain.xml);
    assert.deepEqual(labelsOf(edited.xml).sort(), ["Bodega", "Lantern"]);
    assert.equal(edgeBetween(edited.xml, "Lantern", "Bodega"), "Quill");
    assert.match(edited.decision.reply, /Quill/);
    assert.doesNotMatch(edited.decision.reply, new RegExp(OPEN_IDEA_REPLY));
    assert.doesNotMatch(edited.decision.reply, /Which shape|Describe a diagram/);
    assert.equal(summarizeDiagram(edited.xml).vertices.some((vertex) => vertex.label === "Quill"), false);
  });

  it("puts a leaf node's text on the neighbor's other edge", () => {
    const chain = previewDemo("Bodega → Lantern → Quill", STARTER_XML);
    const edited = previewDemo("turn the Quill node into an edge label", chain.xml);
    assert.deepEqual(labelsOf(edited.xml).sort(), ["Bodega", "Lantern"]);
    assert.equal(edgeBetween(edited.xml, "Bodega", "Lantern"), "Quill");
    assert.equal(labelsOf(edited.xml).includes("Quill"), false);
  });

  it("leaves a lone node in place", () => {
    const alone = previewDemo("Add Quill", STARTER_XML);
    assert.ok(labelsOf(alone.xml).includes("Quill"));
    const edited = previewDemo("make Quill a label", alone.xml);
    assert.equal(edited.xml, alone.xml);
    assert.match(edited.decision.reply, /between two shapes/);
    assert.ok(labelsOf(edited.xml).includes("Quill"));
  });

  it("resolves a pronoun from the node just added", async () => {
    const base = previewDemo("Lantern → Bodega", STARTER_XML);
    const added = previewDemo("Add Quill between Lantern and Bodega", base.xml);
    assert.ok(labelsOf(added.xml).includes("Quill"), labelsOf(added.xml).join(", "));
    const result = await runKevTurn({
      messages: [
        { role: "user", content: "Add Quill between Lantern and Bodega" },
        { role: "assistant", content: added.decision.reply },
        { role: "user", content: "make it an edge label" },
      ],
      currentXml: added.xml,
    });
    assert.equal(labelsOf(result.updatedXml).includes("Quill"), false, labelsOf(result.updatedXml).join(", "));
    assert.equal(edgeBetween(result.updatedXml, "Lantern", "Bodega"), "Quill");
    assert.doesNotMatch(result.reply, /Which shape|Describe a diagram|needs its own components/);
  });

  it("accepts labels-instead-of-nodes for a named node", () => {
    const chain = previewDemo("Lantern → Quill → Bodega", STARTER_XML);
    const edited = previewDemo("labels instead of nodes for Quill", chain.xml);
    assert.equal(edgeBetween(edited.xml, "Lantern", "Bodega"), "Quill");
    assert.equal(labelsOf(edited.xml).includes("Quill"), false);
  });
});
