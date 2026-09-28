import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assessDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { STARTER_XML } from "../src/lib/drawio/starter";
import { summarizeDiagram } from "../src/lib/drawio/xml";
import { isAdditiveExtension } from "../src/lib/kev/compose";
import { previewDemo } from "../src/lib/kev/demo";
import { parseArchitecture } from "../src/lib/kev/plan";
import { runKevTurn } from "../src/lib/kev/run";
import { isExpandFollowUp, pluralRoleOf, wantsRicherDiagram } from "../src/lib/kev/scale";

const ENV_KEYS = ["KEV_BASE_URL", "KEV_API_KEY", "KEV_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

function content(nodes: QualityNode[]): QualityNode[] {
  return nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor");
}

function labelsOf(xml: string): string[] {
  return content(assessDiagram(xml).nodes).map((node) => node.label);
}

describe("expand and enrich", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("grows an unnamed N-tier ask when the message also asks for scale", () => {
    const prompts = [
      "A three tier web app..make it complex with many nodes",
      "Draw a 3-tier web application and make it detailed with many components",
      "three tier architecture, lots of nodes",
      "a complex three-layer web app with several nodes",
    ];
    for (const prompt of prompts) {
      assert.equal(wantsRicherDiagram(prompt), true, prompt);
      const plan = parseArchitecture(prompt);
      assert.ok(plan, prompt);
      assert.ok(plan.nodes.length > 3, `${prompt} → ${plan.nodes.join(", ")}`);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called|Describe a diagram change/, prompt);
      const report = assessDiagram(drawn.xml);
      const boxes = content(report.nodes);
      assert.ok(boxes.length > 3, `${prompt} drew ${boxes.map((node) => node.label).join(", ")}`);
      assert.ok(boxes.some((node) => /cache/i.test(node.label)), prompt);
      assert.ok(boxes.filter((node) => /cylinder3/.test(node.style)).length >= 2, prompt);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), prompt);
      assert.ok(report.edges.length >= boxes.length - 1, prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      assert.deepEqual(report.overlaps, [], prompt);
    }
    assert.deepEqual(parseArchitecture("draw a 3 tier web app")?.nodes, ["Client", "App", "Postgres"]);
    assert.deepEqual(parseArchitecture("just a simple three tier web app")?.nodes, ["Client", "App", "Postgres"]);
    assert.deepEqual(parseArchitecture("draw a Complex 3 Tier Web App: Client → Postgres")?.nodes, [
      "Client",
      "App",
      "Postgres",
    ]);
    assert.deepEqual(parseArchitecture("three tier web app", { depth: "many" })?.nodes.length, 7);
    assert.deepEqual(parseArchitecture("three tier web app", { depth: "few" })?.nodes, ["Client", "App", "Postgres"]);
  });

  it("splices several databases onto an open 3-tier canvas", () => {
    const base = previewDemo("draw a 3 tier web app", STARTER_XML);
    const before = assessDiagram(base.xml);
    const beforeBoxes = content(before.nodes);
    const phrases = ["Many more databases", "add more databases", "extra databases please"];
    for (const phrase of phrases) {
      assert.equal(pluralRoleOf(phrase), "database", phrase);
      assert.equal(isAdditiveExtension(phrase), true, phrase);
      const edited = previewDemo(phrase, base.xml);
      assert.equal(edited.decision.intent, "add_shape", phrase);
      assert.doesNotMatch(edited.decision.reply, /What should the new shape be called|Describe a diagram change/, phrase);
      const report = assessDiagram(edited.xml);
      const boxes = content(report.nodes);
      for (const kept of beforeBoxes) {
        const after = boxes.find((node) => node.label === kept.label);
        assert.ok(after, `${phrase} dropped ${kept.label}`);
        assert.equal(after.x, kept.x, phrase);
        assert.equal(after.y, kept.y, phrase);
      }
      const added = boxes.filter((node) => !beforeBoxes.some((kept) => kept.label === node.label));
      assert.ok(added.length >= 2, `${phrase} added ${added.map((node) => node.label).join(", ")}`);
      assert.ok(added.every((node) => /cylinder3/.test(node.style)), phrase);
      const queries = report.edges.filter((edge) => edge.from === "App" && added.some((node) => node.label === edge.to));
      assert.ok(queries.length >= 2, phrase);
      assert.ok(queries.every((edge) => edge.label === "Query"), phrase);
      assert.deepEqual(report.overlaps, [], phrase);
    }
  });

  it("expands a scale complaint instead of asking what to draw", async () => {
    const base = previewDemo("three tier web app", STARTER_XML);
    const before = labelsOf(base.xml);
    const phrases = [
      "Okay but I asked many nodes",
      "I asked for many nodes",
      "make it more complex",
      "more nodes please",
    ];
    for (const phrase of phrases) {
      assert.equal(isExpandFollowUp(phrase), true, phrase);
      const edited = previewDemo(phrase, base.xml);
      assert.equal(edited.decision.intent, "add_shape", phrase);
      assert.doesNotMatch(edited.decision.reply, /Describe a diagram change|What should I draw|What should the new shape/, phrase);
      const labels = labelsOf(edited.xml);
      for (const kept of before) assert.ok(labels.includes(kept), `${phrase} dropped ${kept}`);
      assert.ok(labels.length > before.length, `${phrase} → ${labels.join(", ")}`);
      assert.deepEqual(assessDiagram(edited.xml).overlaps, [], phrase);
    }

    const turned = await runKevTurn({
      messages: [
        { role: "user", content: "draw a 3 tier web app" },
        { role: "assistant", content: "Drew it." },
        { role: "user", content: "Okay but I asked many nodes" },
      ],
      currentXml: base.xml,
    });
    assert.equal(turned.intent, "add_shape");
    assert.doesNotMatch(turned.reply, /Describe a diagram change/);
    const turnedLabels = labelsOf(turned.updatedXml);
    for (const kept of before) assert.ok(turnedLabels.includes(kept));
    assert.ok(turnedLabels.length > before.length);
  });

  it("composes a plural role that has no proper name", () => {
    for (const [phrase, role, shape] of [
      ["add databases", "database", "cylinder3"],
      ["add caches", "cache", "cylinder3"],
      ["add workers", "worker", "rounded=1"],
      ["add services", "service", "rounded=1"],
    ] as const) {
      assert.equal(pluralRoleOf(phrase), role, phrase);
      const drawn = previewDemo(phrase, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", phrase);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called/, phrase);
      const boxes = content(assessDiagram(drawn.xml).nodes);
      assert.ok(boxes.length >= 2, `${phrase} → ${boxes.map((node) => node.label).join(", ")}`);
      assert.ok(boxes.every((node) => node.style.includes(shape)), phrase);
      assert.ok(
        boxes.every((node) => /fillColor=#[0-9a-f]{6}/i.test(node.style) && !node.style.includes("fillColor=#ffffff")),
        phrase,
      );
    }
    assert.equal(pluralRoleOf("add Postgres and MySQL databases"), null);
  });

  it("composes a dense architecture from scale cues without a named box list", () => {
    const prompts = [
      "Sketch a richly detailed multi-tier web platform with lots of moving parts — N layers, complex internals",
      "Outline a denser layered service platform with intricate internals",
      "Map a complex multi-layer system that has plenty of machinery inside",
      "Build a richer n-tier web platform, depth and all",
    ];
    for (const prompt of prompts) {
      assert.equal(wantsRicherDiagram(prompt), true, prompt);
      const plan = parseArchitecture(prompt);
      assert.ok(plan, prompt);
      assert.ok((plan?.nodes.length ?? 0) >= 5, `${prompt} → ${plan?.nodes.join(", ")}`);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      assert.doesNotMatch(
        drawn.decision.reply,
        /Name the boxes|high-level sketch|What should the new shape be called|What should I draw/,
        prompt,
      );
      const report = assessDiagram(drawn.xml);
      const boxes = content(report.nodes);
      const labels = boxes.map((node) => node.label);
      assert.ok(labels.length >= 5, `${prompt} → ${labels.join(", ")}`);
      const families = new Set<string>();
      for (const label of labels) {
        const text = label.toLowerCase();
        if (/client|browser/.test(text)) families.add("client");
        if (/cdn|edge|gateway/.test(text)) families.add("edge");
        if (/^app$|service|api|worker/.test(text)) families.add(text === "worker" ? "worker" : "app");
        if (/cache/.test(text)) families.add("cache");
        if (/worker/.test(text)) families.add("worker");
        if (/postgres|replica|mysql|database|archive/.test(text)) families.add("db");
      }
      assert.ok(families.size >= 3, `${prompt} families ${[...families].join(", ")} from ${labels.join(", ")}`);
      assert.ok(report.nodes.some((node) => node.role === "cluster"), prompt);
      assert.ok(report.edges.length >= 4, prompt);
      assert.ok(report.edges.every((edge) => edge.label.length > 0), prompt);
      assert.ok(
        boxes.every((node) => /fillColor=#[0-9a-f]{6}/i.test(node.style) && !node.style.includes("fillColor=#ffffff")),
        prompt,
      );
      assert.deepEqual(report.overlaps, [], prompt);
    }
    assert.deepEqual(parseArchitecture("three tier web app")?.nodes, ["Client", "App", "Postgres"]);
    assert.deepEqual(parseArchitecture("just a simple three tier web app")?.nodes, ["Client", "App", "Postgres"]);
  });

  it("soft-composes a plural role even when the verb is not add", () => {
    const prompts = [
      "Drop a few databases onto the board",
      "Place a handful of databases on the canvas",
      "Put some database stores on the page",
      "Stick several db instances onto the sheet",
    ];
    for (const prompt of prompts) {
      assert.equal(pluralRoleOf(prompt), "database", prompt);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", `${prompt} → ${drawn.decision.reply}`);
      assert.doesNotMatch(drawn.decision.reply, /What should the new shape be called|Which shape should I delete/, prompt);
      const boxes = content(assessDiagram(drawn.xml).nodes);
      assert.ok(boxes.length >= 2, `${prompt} → ${boxes.map((node) => node.label).join(", ")}`);
      assert.ok(boxes.every((node) => /cylinder3/.test(node.style)), prompt);
      assert.ok(
        boxes.every((node) => /fillColor=#[0-9a-f]{6}/i.test(node.style) && !node.style.includes("fillColor=#ffffff")),
        prompt,
      );
    }

    const base = previewDemo("Draw a plain three-tier web app", STARTER_XML);
    const before = content(assessDiagram(base.xml).nodes);
    const followUps = [
      "Could you splice in several additional database stores for me?",
      "Splice a few extra database stores into the diagram",
    ];
    for (const phrase of followUps) {
      assert.equal(pluralRoleOf(phrase), "database", phrase);
      const edited = previewDemo(phrase, base.xml);
      assert.equal(edited.decision.intent, "add_shape", phrase);
      const boxes = content(assessDiagram(edited.xml).nodes);
      for (const kept of before) assert.ok(boxes.some((node) => node.label === kept.label), `${phrase} dropped ${kept.label}`);
      const added = boxes.filter((node) => !before.some((kept) => kept.label === node.label));
      assert.ok(added.length >= 2, `${phrase} added ${added.map((node) => node.label).join(", ")}`);
      assert.ok(added.every((node) => /cylinder3/.test(node.style)), phrase);
      assert.equal(added.some((node) => node.label === "CDN"), false, phrase);
      assert.equal(added.some((node) => node.label === "Worker"), false, phrase);
    }
  });

  it("still clarifies a bare draw and does not wipe the canvas on a replace phrase", () => {
    const bare = previewDemo("draw", STARTER_XML);
    assert.equal(bare.decision.intent, "clarify");
    assert.match(bare.decision.reply, /What should I draw/);
    assert.equal(bare.xml, STARTER_XML);

    assert.equal(isExpandFollowUp("instead make it more complex"), false);
    assert.equal(isExpandFollowUp("start over with many more nodes"), false);
    assert.equal(isAdditiveExtension("redraw from scratch with many databases"), false);

    const base = previewDemo("draw a 3 tier web app", STARTER_XML);
    const before = labelsOf(base.xml);
    const replaced = previewDemo("redraw this from scratch and make it more complex", base.xml);
    const after = labelsOf(replaced.xml);
    for (const kept of before) assert.ok(after.includes(kept), kept);
    assert.equal(summarizeDiagram(replaced.xml).vertices.length >= summarizeDiagram(base.xml).vertices.length, true);
  });
});
