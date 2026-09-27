import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffDiagrams, formatDiagramContext, formatDiagramDiff } from "../src/lib/drawio/diff";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { noteEditorXml, noteHostXml, previousForTurn } from "../src/lib/drawio/sync";
import { diagramState } from "../src/lib/kev/systemone";
import { summarizeDiagram } from "../src/lib/drawio/xml";

function withApiLabel(label: string): string {
  return STARTER_XML.replace('value="API"', `value="${label}"`);
}

describe("diagram diff", () => {
  it("reports a changed cell id and value", () => {
    const diff = diffDiagrams(STARTER_XML, withApiLabel("Gateway"));
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]?.id, "3");
    assert.equal(diff.changed[0]?.previousValue, "API");
    assert.equal(diff.changed[0]?.value, "Gateway");
    assert.ok(diff.changed[0]?.fields.includes("value"));
    const text = formatDiagramDiff(diff);
    assert.match(text, /id 3/);
    assert.match(text, /API/);
    assert.match(text, /Gateway/);
  });

  it("reports added and removed cells", () => {
    const removed = STARTER_XML.replace(/<mxCell id="2"[\s\S]*?<\/mxCell>/, "");
    const diff = diffDiagrams(STARTER_XML, removed);
    assert.ok(diff.removed.some((cell) => cell.id === "2" && cell.value === "Client"));
    assert.match(formatDiagramDiff(diff), /Removed:/);
  });

  it("says when there is no previous diagram", () => {
    const text = formatDiagramDiff(diffDiagrams(null, STARTER_XML));
    assert.match(text, /No manual edits/);
  });

  it("includes previous xml, current xml, and the diff in the prompt block", () => {
    const current = withApiLabel("Gateway");
    const diffText = formatDiagramDiff(diffDiagrams(STARTER_XML, current));
    const block = formatDiagramContext({
      previousXml: STARTER_XML,
      currentXml: current,
      diffText,
    });
    assert.match(block, /Previous diagram mxfile/);
    assert.match(block, /value="API"/);
    assert.match(block, /Current diagram mxfile/);
    assert.match(block, /value="Gateway"/);
    assert.match(block, /Diagram diff/);
    assert.match(block, /id 3/);
  });

  it("keeps the pre-edit baseline and sends it only after a hand edit", () => {
    const loaded = noteEditorXml(
      { currentXml: STARTER_XML, baselineXml: STARTER_XML, acceptEcho: true },
      "<mxfile>echo</mxfile>",
      false,
    );
    assert.equal(previousForTurn(loaded), undefined);
    const edited = noteEditorXml(loaded, "<mxfile>edited</mxfile>", false);
    assert.equal(edited.baselineXml, "<mxfile>echo</mxfile>");
    assert.equal(edited.currentXml, "<mxfile>edited</mxfile>");
    assert.equal(previousForTurn(edited), "<mxfile>echo</mxfile>");
    const applied = noteHostXml(edited, "<mxfile>kev</mxfile>");
    assert.equal(previousForTurn(applied), undefined);
    assert.equal(applied.currentXml, "<mxfile>kev</mxfile>");
  });

  it("puts the same diff on the Kev system one state", () => {
    const current = withApiLabel("Gateway");
    const diffText = formatDiagramDiff(diffDiagrams(STARTER_XML, current));
    const state = diagramState("see the change I just did?", summarizeDiagram(current), {
      diffText,
      previousXml: STARTER_XML,
      currentXml: current,
    });
    assert.match(state, /see the change I just did/);
    assert.match(state, /Diagram diff/);
    assert.match(state, /Previous diagram mxfile/);
    assert.match(state, /Current diagram mxfile/);
    assert.match(state, /Gateway/);
  });
});
