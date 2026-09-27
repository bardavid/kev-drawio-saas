import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseBody } from "../src/app/api/chat/route";
import { assessDiagram, finalizeDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { runKevTurn } from "../src/lib/kev/run";

const ENV_KEYS = ["KEV_BASE_URL", "KEV_API_KEY", "KEV_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;
const originalFetch = globalThis.fetch;

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

const OVERLAP_XML = `<mxfile host="embed.diagrams.net" agent="draw.ai">
  <diagram id="architecture" name="Architecture">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="A" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="100" y="100" width="140" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="3" value="B" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="120" y="110" width="140" height="60" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

function content(nodes: QualityNode[]): QualityNode[] {
  return nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor");
}

function assertClean(xml: string) {
  const report = assessDiagram(xml);
  assert.deepEqual(report.overlaps, [], `overlaps: ${JSON.stringify(report.overlaps)}`);
  assert.deepEqual(report.crossings, [], `crossings: ${JSON.stringify(report.crossings)}`);
  return report;
}

function rowGaps(nodes: QualityNode[]): number[] {
  const row = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  const gaps: number[] = [];
  for (let index = 1; index < row.length; index += 1) {
    const previous = row[index - 1];
    const current = row[index];
    if (!previous || !current) continue;
    gaps.push(current.x - (previous.x + previous.width));
  }
  return gaps;
}

function geometrySignature(xml: string) {
  const report = assessDiagram(xml);
  return {
    nodes: report.nodes.map((node) => ({
      label: node.label,
      role: node.role,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    })),
    edges: report.edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.label })),
  };
}

function exitY(style: string): number {
  return Number(style.match(/exitY=([0-9.]+)/)?.[1] ?? "0");
}

describe("diagram quality", () => {
  it("separates boxes that were placed on top of each other", () => {
    assert.ok(assessDiagram(OVERLAP_XML).overlaps.length > 0);
    const fixed = finalizeDiagram(OVERLAP_XML);
    assert.deepEqual(assessDiagram(fixed).overlaps, []);
    const labels = assessDiagram(fixed).nodes.map((node) => node.label).sort();
    assert.deepEqual(labels, ["A", "B"]);
  });

  it("draws a 3 tier web app as an aligned chain", () => {
    const xml = previewDemo("draw a 3 tier web app", EMPTY_XML).xml;
    const report = assertClean(xml);
    assert.deepEqual(
      report.nodes.map((node) => node.label),
      ["Client", "App", "Postgres"],
    );
    assert.deepEqual(
      report.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Postgres"],
    );
    const postgres = report.nodes.find((node) => node.label === "Postgres");
    assert.match(postgres?.style ?? "", /cylinder3/);
    assert.equal(new Set(report.nodes.map((node) => node.y)).size, 1);
    const gaps = rowGaps(report.nodes);
    assert.ok(gaps.every((gap) => gap >= 48));
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1);
    const xs = report.nodes.map((node) => node.x);
    assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
    const fromStarter = assessDiagram(previewDemo("draw a 3 tier web app", STARTER_XML).xml);
    assert.deepEqual(
      fromStarter.nodes.map((node) => node.label),
      ["Client", "App", "Postgres"],
    );
    assert.deepEqual(
      fromStarter.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Postgres"],
    );
    assert.ok(fromStarter.edges.every((edge) => edge.label === ""));
  });

  it("routes a skip edge around the node sitting between its ends", () => {
    const xml = previewDemo("Connect the client to Postgres", SEEDED_XML).xml;
    const report = assertClean(xml);
    assert.ok(report.edges.some((edge) => edge.from === "Client" && edge.to === "Postgres"));
    const skip = report.edges.find((edge) => edge.from === "Client" && edge.to === "Postgres");
    assert.ok(skip && skip.points.length > 0);
  });

  it("draws a user login sequence with lifelines and ordered messages", () => {
    const xml = previewDemo("draw a user login sequence diagram", EMPTY_XML).xml;
    const report = assertClean(xml);
    const names = content(report.nodes).map((node) => node.label);
    assert.deepEqual(names, ["User", "Browser", "Auth Service"]);
    assert.ok(content(report.nodes).every((node) => node.style.includes("umlLifeline")));
    assert.ok(content(report.nodes).every((node) => node.style.includes("fontSize=13")));
    assert.ok(content(report.nodes).every((node) => node.style.includes("fillColor=#ffffff")));
    const messages = report.edges.filter((edge) => edge.label).sort((a, b) => exitY(a.style) - exitY(b.style));
    assert.deepEqual(
      messages.map((edge) => edge.label),
      ["Enter credentials", "POST /login", "Session", "Logged in"],
    );
    assert.ok(messages.slice(0, 2).every((edge) => !edge.style.includes("dashed=1")));
    assert.ok(messages.slice(2).every((edge) => edge.style.includes("dashed=1")));
    const ys = messages.map((edge) => exitY(edge.style));
    assert.equal(new Set(ys).size, ys.length);
    const headers = content(report.nodes);
    const headerGaps = rowGaps(headers);
    assert.ok(headerGaps.every((gap) => gap >= 48));
  });

  it("draws io_uring on XFS as stacked clusters", () => {
    const xml = previewDemo("draw io uring usage on XFS filesystem", EMPTY_XML).xml;
    const report = assertClean(xml);
    const labels = report.nodes.map((node) => node.label);
    for (const label of ["Userspace", "Kernel", "Storage", "Application", "io_uring", "XFS", "Block device"]) {
      assert.ok(labels.includes(label), label);
    }
    const cluster = (label: string) => report.nodes.find((node) => node.label === label && node.role === "cluster");
    const node = (label: string) => report.nodes.find((node) => node.label === label && node.role === "node");
    const userspace = cluster("Userspace");
    const kernel = cluster("Kernel");
    const storage = cluster("Storage");
    assert.ok(userspace && kernel && storage);
    assert.ok(userspace.y < kernel.y && kernel.y < storage.y);
    const inside = (child: QualityNode | undefined, parent: QualityNode | undefined) => {
      assert.ok(child && parent);
      const cx = child.x + child.width / 2;
      const cy = child.y + child.height / 2;
      assert.ok(cx > parent.x && cx < parent.x + parent.width);
      assert.ok(cy > parent.y && cy < parent.y + parent.height);
    };
    inside(node("Application"), userspace);
    inside(node("io_uring"), kernel);
    inside(node("XFS"), kernel);
    inside(node("Block device"), storage);
    assert.match(node("Block device")?.style ?? "", /cylinder3/);
    const edgeLabels = report.edges.map((edge) => edge.label).sort();
    assert.deepEqual(edgeLabels, ["Block I/O", "Complete CQE", "Read / write", "Submit SQE"].sort());
    const returning = report.edges.find((edge) => edge.label === "Complete CQE");
    assert.match(returning?.style ?? "", /dashed=1/);
    assert.ok((returning?.points.length ?? 0) > 0);
  });

  it("draws the US tax filing workflow left to right with a decision", () => {
    const xml = previewDemo("draw a workflow for tax filing process in US", EMPTY_XML).xml;
    const report = assertClean(xml);
    const byLabel = new Map(content(report.nodes).map((node) => [node.label, node]));
    const order = ["Collect documents", "Complete Form 1040", "Review return", "E-file", "Balance due?"];
    for (let index = 1; index < order.length; index += 1) {
      const previous = byLabel.get(order[index - 1] ?? "");
      const current = byLabel.get(order[index] ?? "");
      assert.ok(previous && current);
      assert.ok(previous.x < current.x);
      assert.equal(previous.y, current.y);
    }
    assert.match(byLabel.get("Balance due?")?.style ?? "", /rhombus/);
    const pay = byLabel.get("Pay the IRS");
    const refund = byLabel.get("Receive refund");
    const decision = byLabel.get("Balance due?");
    assert.ok(pay && refund && decision);
    assert.ok(pay.x > decision.x);
    assert.ok(refund.x > decision.x);
    assert.ok(pay.y < decision.y);
    assert.ok(refund.y > decision.y);
    assert.ok(report.edges.some((edge) => edge.label === "Yes" && edge.to === "Pay the IRS"));
    assert.ok(report.edges.some((edge) => edge.label === "No" && edge.to === "Receive refund"));
    const main = order.map((label) => byLabel.get(label)).filter((node): node is QualityNode => Boolean(node));
    const gaps = rowGaps(main);
    assert.ok(gaps.every((gap) => gap >= 48));
  });

  it("draws a Redis usage diagram for the exact prompt", () => {
    const prompt = "Draw a redis diagram usage";
    const { decision, xml } = previewDemo(prompt, STARTER_XML);
    assert.notEqual(xml, STARTER_XML);
    assert.equal(decision.reply.includes("Added Redis Diagram Usage"), false);
    assert.match(decision.reply, /Client → App → Redis cache/);
    assert.match(xml, /<mxGraphModel/);
    const report = assertClean(xml);
    const labels = report.nodes.map((node) => node.label);
    for (const label of [
      "Clients",
      "Application",
      "Redis",
      "Data",
      "Client",
      "App",
      "Redis cache",
      "Replica",
      "Persistence",
      "Database",
    ]) {
      assert.ok(labels.includes(label), label);
    }
    assert.ok(report.edges.length >= 4);
    assert.ok(report.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
    assert.ok(report.edges.some((edge) => edge.from === "App" && edge.to === "Redis cache"));
    assert.ok(report.edges.some((edge) => edge.label === "Replicate"));
    assert.ok(report.edges.some((edge) => edge.label === "Read on miss"));
    const cluster = (label: string) => report.nodes.find((node) => node.label === label && node.role === "cluster");
    const node = (label: string) => report.nodes.find((node) => node.label === label && node.role === "node");
    const redis = cluster("Redis");
    const clients = cluster("Clients");
    const application = cluster("Application");
    const data = cluster("Data");
    assert.ok(clients && application && redis && data);
    assert.ok(clients.y < application.y && application.y < redis.y && redis.y < data.y);
    const inside = (child: QualityNode | undefined, parent: QualityNode | undefined) => {
      assert.ok(child && parent);
      const cx = child.x + child.width / 2;
      const cy = child.y + child.height / 2;
      assert.ok(cx > parent.x && cx < parent.x + parent.width);
      assert.ok(cy > parent.y && cy < parent.y + parent.height);
    };
    inside(node("Client"), clients);
    inside(node("App"), application);
    inside(node("Redis cache"), redis);
    inside(node("Replica"), redis);
    inside(node("Persistence"), redis);
    inside(node("Database"), data);
    assert.match(node("Redis cache")?.style ?? "", /cylinder3/);
    assert.ok(content(report.nodes).length >= 4);
    assert.equal(report.nodes.some((node) => node.label === "Redis Diagram Usage"), false);
  });

  it("restyles every box red without moving the login sequence", () => {
    const drawn = previewDemo("draw a user login sequence diagram", STARTER_XML).xml;
    const before = geometrySignature(drawn);
    const restyled = previewDemo("change the boxes to red", drawn);
    assert.equal(restyled.decision.intent, "style");
    assert.equal(restyled.decision.slots.colorName, "red");
    assert.equal(restyled.decision.slots.fillColor, "#f8cecc");
    const after = assessDiagram(restyled.xml);
    assert.deepEqual(geometrySignature(restyled.xml), before);
    const boxes = after.nodes.filter((node) => node.role === "node");
    assert.ok(boxes.length >= 3);
    assert.ok(boxes.every((node) => node.style.includes("umlLifeline")));
    assert.ok(boxes.every((node) => node.style.includes("fillColor=#f8cecc")));
    assert.ok(boxes.every((node) => node.style.includes("strokeColor=#b85450")));
    assert.equal(after.edges.length, before.edges.length);
  });

  it("restyles an architecture in place", () => {
    const drawn = previewDemo("draw a 3 tier web app", EMPTY_XML).xml;
    const before = geometrySignature(drawn);
    const restyled = previewDemo("make all boxes red", drawn).xml;
    assert.deepEqual(geometrySignature(restyled), before);
    const report = assessDiagram(restyled);
    assert.ok(report.nodes.every((node) => node.style.includes("fillColor=#f8cecc")));
    assert.deepEqual(
      report.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Postgres"],
    );
  });
});

describe("composition gate", { concurrency: 1 }, () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  it("draws the login sequence when Jev confirm is 0.43", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    const calls: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }>; state?: string };
      calls.push(Object.keys(body.questions).sort().join(","));
      if (body.questions.intent) {
        return Response.json({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "noop", confidence: 0.4 },
            needs_xml_edit: { type: "noul", noul: 0.2 },
          },
        });
      }
      assert.match(body.state ?? "", /Enter credentials/);
      assert.match(body.state ?? "", /POST \/login/);
      return Response.json({
        model: "kev-latest",
        answers: {
          next: { type: "choice", choice: "noop", confidence: 0.55 },
          confirm: { type: "noul", noul: 0.43 },
          color: { type: "choice", choice: "blue" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "draw a user login sequence diagram" }],
      currentXml: STARTER_XML,
    });
    assert.deepEqual(calls, [
      "anchor,color,disruption,intent,layout,needs_xml_edit,place,shape,source,target",
      "confirm,next",
      "confirm,next",
      "color,confirm,next",
    ]);
    assert.equal(result.intent, "add_shape");
    assert.deepEqual(
      result.steps?.map((step) => step.detail),
      ["Confirm the node outline", "Confirm the edges", "Confirm the diagram style"],
    );
    assert.equal(result.steps?.every((step) => step.accepted && step.confirm === 0.43 && step.choice === "noop"), true);
    const report = assertClean(result.updatedXml);
    assert.deepEqual(content(report.nodes).map((node) => node.label), ["User", "Browser", "Auth Service"]);
    assert.ok(content(report.nodes).every((node) => node.style.includes("fillColor=#ffffff")));
    assert.equal(result.updatedXml.includes("Client"), false);
  });

  it("draws Redis usage from a blank page in demo mode", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const result = await runKevTurn({
      messages: [{ role: "user", content: "Draw a redis diagram usage" }],
      currentXml: STARTER_XML,
    });
    assert.equal(result.mode, "demo");
    assert.notEqual(result.updatedXml, STARTER_XML);
    assert.match(result.reply, /Redis cache/);
    assert.equal(result.reply.includes("Added Redis Diagram Usage"), false);
    const report = assertClean(result.updatedXml);
    assert.ok(report.nodes.some((node) => node.label === "Redis cache"));
    assert.ok(report.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
    assert.ok(report.edges.some((edge) => edge.from === "App" && edge.to === "Redis cache"));
    assert.ok(report.nodes.filter((node) => node.role === "node").length >= 4);
  });

  it("sends the current mxfile and fetched Redis context into the Jev plan", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    const states: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        return Response.json({
          extract: "Redis is an in-memory cache sitting between an application and its database.",
        });
      }
      const body = JSON.parse(String(init?.body)) as { state?: string; questions: Record<string, { type: string }> };
      states.push(body.state ?? "");
      if (body.questions.intent) {
        return Response.json({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "noop", confidence: 0.4 },
            needs_xml_edit: { type: "noul", noul: 0.2 },
          },
        });
      }
      return Response.json({
        model: "kev-latest",
        answers: {
          next: { type: "choice", choice: "noop", confidence: 0.55 },
          confirm: { type: "noul", noul: 0.43 },
          color: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "Draw a redis diagram usage" }],
      currentXml: STARTER_XML,
    });
    assert.ok(states.length >= 2);
    for (const state of states) {
      assert.match(state, /Current diagram mxfile/);
      assert.match(state, /<mxfile/);
      assert.match(state, /in-memory cache sitting between/);
    }
    assert.match(states[1] ?? "", /Topic context/);
    assert.match(states[1] ?? "", /Redis cache/);
    assert.equal(result.intent, "add_shape");
    assert.equal(result.steps?.[0]?.accepted, true);
    assert.equal(result.steps?.[0]?.confirm, 0.43);
    assert.equal(result.steps?.[0]?.choice, "noop");
    assert.match(result.reply, /Redis cache/);
    assert.equal(result.reply.includes("Added Redis Diagram Usage"), false);
    assert.notEqual(result.updatedXml, STARTER_XML);
    const report = assertClean(result.updatedXml);
    assert.ok(report.edges.some((edge) => edge.from === "Client" && edge.to === "App"));
    assert.ok(report.edges.some((edge) => edge.from === "App" && edge.to === "Redis cache"));
  });

  it("draws Redis from the builtin brief when Wikipedia is offline", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    const states: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("wikipedia.org")) throw new Error("offline");
      const body = JSON.parse(String(init?.body)) as { state?: string; questions: Record<string, { type: string }> };
      states.push(body.state ?? "");
      if (body.questions.intent) {
        return Response.json({
          answers: {
            intent: { type: "choice", choice: "add_shape", confidence: 0.2 },
            needs_xml_edit: { type: "noul", noul: 0.1 },
          },
        });
      }
      return Response.json({
        answers: {
          next: { type: "choice", choice: "clarify", confidence: 0.4 },
          confirm: { type: "noul", noul: 0.43 },
          color: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "Draw a redis diagram usage" }],
      currentXml: STARTER_XML,
    });
    const joined = states.join("\n");
    assert.match(joined, /in-memory data store/);
    assert.match(joined, /<mxfile/);
    assert.match(result.reply, /Redis cache/);
    assert.equal(result.reply.includes("Added Redis Diagram Usage"), false);
    const report = assertClean(result.updatedXml);
    assert.ok(report.nodes.filter((node) => node.role === "node").length >= 4);
    assert.ok(report.edges.some((edge) => edge.from === "App" && edge.to === "Redis cache"));
  });

  it("researches an unknown topic, then gates outline, structure, and style", async () => {
    process.env.KEV_BASE_URL = "http://kev.local";
    const phases: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        assert.match(url, /page\/summary\/Memcached$/);
        return Response.json({
          extract:
            "Memcached is a distributed memory caching system. Applications read it before a database and fill it after a miss.",
        });
      }
      const body = JSON.parse(String(init?.body)) as { state?: string; questions: Record<string, { type: string }> };
      const phase = body.state?.match(/Phase: (\w+)/)?.[1];
      if (phase) phases.push(phase);
      if (body.questions.intent) {
        return Response.json({
          model: "kev-latest",
          answers: {
            intent: { type: "choice", choice: "noop", confidence: 0.4 },
            needs_xml_edit: { type: "noul", noul: 0.2 },
          },
        });
      }
      if (phase === "outline") assert.match(body.state ?? "", /distributed memory caching/);
      return Response.json({
        model: "kev-latest",
        answers: {
          next: { type: "choice", choice: "apply", confidence: 0.8 },
          confirm: { type: "noul", noul: 0.91 },
          color: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;

    const result = await runKevTurn({
      messages: [{ role: "user", content: "Draw a memcached diagram usage" }],
      currentXml: STARTER_XML,
    });
    assert.deepEqual(phases, ["outline", "structure", "style"]);
    assert.deepEqual(
      result.steps?.map((step) => step.detail),
      ["Confirm the node outline", "Confirm the edges", "Confirm the diagram style"],
    );
    assert.equal(result.steps?.every((step) => step.accepted), true);
    assert.equal(result.intent, "add_shape");
    assert.match(result.reply, /Memcached/);
    assert.equal(result.reply.includes("No diagram change"), false);
    assert.notEqual(result.updatedXml, STARTER_XML);
    const report = assertClean(result.updatedXml);
    const labels = report.nodes.map((node) => node.label);
    for (const label of ["Client", "App", "Memcached", "Database"]) assert.ok(labels.includes(label), label);
    assert.ok(report.edges.some((edge) => edge.from === "App" && edge.to === "Memcached"));
    assert.ok(report.edges.some((edge) => edge.label === "Read on miss"));
    assert.equal(labels.includes("Redis cache"), false);
  });
});

describe("live kev architecture", { concurrency: 1 }, () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    globalThis.fetch = originalFetch;
  });

  function installKev(writer?: () => string) {
    process.env.KEV_BASE_URL = "http://kev.local";
    if (writer) process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as {
        questions?: Record<string, { type: string }>;
        state?: string;
      };
      if (url.includes("/chat/completions")) {
        const updatedXml = writer ? writer() : "";
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "style",
                  reply: "Set every shape to red.",
                  updatedXml,
                  slots: { colorName: "red", fillColor: "#f8cecc", strokeColor: "#b85450" },
                  operations: [],
                }),
              },
            },
          ],
        });
      }
      const state = body.state ?? "";
      const restyle = /change the boxes to red/i.test(state);
      if (body.questions?.intent) {
        return Response.json({
          model: "kev-latest",
          answers: restyle
            ? {
                intent: { type: "choice", choice: "style", confidence: 0.9 },
                needs_xml_edit: { type: "noul", noul: 0.92 },
                color: { type: "choice", choice: "red" },
                anchor: { type: "choice", choice: "none" },
                shape: { type: "choice", choice: "none" },
                layout: { type: "choice", choice: "none" },
              }
            : {
                intent: { type: "choice", choice: "noop", confidence: 0.4 },
                needs_xml_edit: { type: "noul", noul: 0.2 },
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
          next: { type: "choice", choice: "apply", confidence: 0.93 },
          confirm: { type: "noul", noul: 0.97 },
          shape: { type: "choice", choice: "none" },
          color: { type: "choice", choice: "none" },
          layout: { type: "choice", choice: "none" },
        },
      });
    }) as typeof fetch;
  }

  it("reads diagramXml when currentXml is omitted", () => {
    const diagramXml = `<mxfile host="embed.diagrams.net"><diagram id="d" name="D"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;
    const parsed = parseBody({
      messages: [{ role: "user", content: "draw a 3 tier web app" }],
      diagramXml,
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.currentXml, diagramXml);
    const preferred = parseBody({
      messages: [{ role: "user", content: "draw a 3 tier web app" }],
      currentXml: STARTER_XML,
      diagramXml,
    });
    assert.equal(preferred.ok, true);
    if (!preferred.ok) return;
    assert.equal(preferred.value.currentXml, STARTER_XML);
    const omitted = parseBody({
      messages: [{ role: "user", content: "Draw a redis diagram usage" }],
    });
    assert.equal(omitted.ok, true);
    if (!omitted.ok) return;
    assert.equal(omitted.value.currentXml, STARTER_XML);
    assert.equal(assessDiagram(omitted.value.currentXml).nodes.length, 0);
  });

  it("draws a 3 tier web app from the starter, then restyles without moving nodes", async () => {
    installKev();
    const drawn = await runKevTurn({
      messages: [{ role: "user", content: "draw a 3 tier web app" }],
      currentXml: STARTER_XML,
    });
    const report = assertClean(drawn.updatedXml);
    assert.deepEqual(
      report.nodes.map((node) => node.label),
      ["Client", "App", "Postgres"],
    );
    assert.deepEqual(
      report.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Postgres"],
    );
    assert.ok(report.edges.every((edge) => edge.label === ""));
    assert.equal(report.nodes.some((node) => node.label === "API"), false);
    assert.equal(new Set(report.nodes.map((node) => node.y)).size, 1);
    assert.match(report.nodes.find((node) => node.label === "Postgres")?.style ?? "", /cylinder3/);
    const before = geometrySignature(drawn.updatedXml);

    const restyled = await runKevTurn({
      messages: [
        { role: "user", content: "draw a 3 tier web app" },
        { role: "assistant", content: drawn.reply },
        { role: "user", content: "change the boxes to red" },
      ],
      currentXml: drawn.updatedXml,
      previousXml: STARTER_XML,
    });
    assert.equal(restyled.intent, "style");
    assert.equal(restyled.reply, "Set every shape to red.");
    assert.deepEqual(geometrySignature(restyled.updatedXml), before);
    const after = assessDiagram(restyled.updatedXml);
    assert.deepEqual(
      after.nodes.map((node) => node.label),
      ["Client", "App", "Postgres"],
    );
    assert.ok(after.nodes.every((node) => node.style.includes("fillColor=#f8cecc")));
    assert.ok(after.nodes.every((node) => node.style.includes("strokeColor=#b85450")));
    assert.deepEqual(
      after.edges.map((edge) => `${edge.from}->${edge.to}`),
      ["Client->App", "App->Postgres"],
    );
  });

  it("keeps architecture geometry when a style writer moves a node", async () => {
    let source = "";
    let written = "";
    installKev(() => {
      written = source.replace(/(value="Postgres"[\s\S]*?<mxGeometry )x="[^"]*" y="[^"]*"/, '$1x="610" y="168"');
      return written;
    });
    const drawn = await runKevTurn({
      messages: [{ role: "user", content: "draw a 3 tier web app" }],
      currentXml: STARTER_XML,
    });
    source = drawn.updatedXml;
    const before = geometrySignature(drawn.updatedXml);
    const restyled = await runKevTurn({
      messages: [{ role: "user", content: "change the boxes to red" }],
      currentXml: drawn.updatedXml,
    });
    const moved = assessDiagram(written);
    assert.equal(moved.nodes.length, before.nodes.length);
    assert.equal(moved.nodes.find((node) => node.label === "Postgres")?.x, 610);
    assert.equal(moved.nodes.find((node) => node.label === "Postgres")?.y, 168);
    assert.equal(restyled.intent, "style");
    assert.equal(restyled.repaired, true);
    assert.deepEqual(geometrySignature(restyled.updatedXml), before);
    const after = assessDiagram(restyled.updatedXml);
    assert.deepEqual(
      after.nodes.map((node) => node.label),
      ["Client", "App", "Postgres"],
    );
    assert.ok(after.nodes.every((node) => node.style.includes("fillColor=#f8cecc")));
    assert.ok(after.nodes.every((node) => node.style.includes("strokeColor=#b85450")));
  });

  it("draws login, io_uring, and tax workflows through the live gate", async () => {
    installKev();
    const prompts = [
      "draw a user login sequence diagram",
      "draw io uring usage on XFS filesystem",
      "draw a workflow for tax filing process in US",
      "Draw a redis diagram usage",
      "draw a microservices architecture",
      "draw a CQRS architecture",
      "draw an event-driven architecture",
      "draw a cache-aside diagram",
      "draw a CDN architecture",
      "draw a load balancer architecture",
      "draw a checkout sequence diagram",
      "draw an OAuth login sequence",
      "draw an API call sequence diagram",
      "draw an approval workflow",
      "draw an e-commerce data model",
      "draw an AWS VPC architecture with an ALB, ECS, and RDS",
      "draw a kubernetes deployment",
      "draw an order state machine",
      "draw a network diagram with a firewall and a DMZ",
      "draw a system architecture",
    ];
    for (const prompt of prompts) {
      const result = await runKevTurn({
        messages: [{ role: "user", content: prompt }],
        currentXml: STARTER_XML,
      });
      const expected = previewDemo(prompt, STARTER_XML).xml;
      assert.equal(result.intent, "add_shape", prompt);
      assert.deepEqual(geometrySignature(result.updatedXml), geometrySignature(expected), prompt);
      assertClean(result.updatedXml);
    }
  });
});
