import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDiagram, type QualityNode, type QualityReport } from "../src/lib/drawio/layout";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { renderComposition } from "../src/lib/kev/compose";
import { composeFromBrief } from "../src/lib/kev/templates";

function content(nodes: QualityNode[]): QualityNode[] {
  return nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor");
}

function assertClean(xml: string): QualityReport {
  const report = assessDiagram(xml);
  assert.deepEqual(report.overlaps, [], `overlaps: ${JSON.stringify(report.overlaps)}`);
  assert.deepEqual(report.crossings, [], `crossings: ${JSON.stringify(report.crossings)}`);
  return report;
}

function box(report: QualityReport, label: string): QualityNode {
  const found = content(report.nodes).find((node) => node.label === label);
  assert.ok(found, label);
  return found;
}

function linked(report: QualityReport, from: string, to: string, label?: string) {
  const found = report.edges.find(
    (edge) => edge.from === from && edge.to === to && (label === undefined || edge.label === label),
  );
  assert.ok(found, `${from} -> ${to}${label ? ` (${label})` : ""}`);
}

function exitY(style: string): number {
  return Number(style.match(/exitY=([0-9.]+)/)?.[1] ?? "0");
}

function sameRow(report: QualityReport, labels: string[]) {
  const nodes = labels.map((label) => box(report, label));
  const first = nodes[0];
  assert.ok(first);
  for (const node of nodes.slice(1)) {
    assert.equal(node.y, first.y, node.label);
    assert.ok(Math.abs(node.x - first.x) > 40);
  }
  const ordered = [...nodes].sort((a, b) => a.x - b.x);
  assert.deepEqual(
    ordered.map((node) => node.label),
    labels,
  );
}

function above(report: QualityReport, upper: string, lower: string) {
  const a = box(report, upper);
  const b = box(report, lower);
  assert.ok(a.y + a.height < b.y, `${upper} should sit above ${lower}`);
}

interface Fixture {
  prompt: string;
  labels: string[];
  edges: Array<[string, string, string?]>;
  rows?: string[][];
  above?: Array<[string, string]>;
  messages?: string[];
  clusters?: string[];
}

const FIXTURES: Fixture[] = [
  {
    prompt: "draw a microservices architecture",
    labels: ["Client", "API Gateway", "Orders", "Catalog", "Payments", "Orders DB", "Catalog DB", "Payments DB"],
    edges: [
      ["Client", "API Gateway", "HTTPS"],
      ["API Gateway", "Orders", "Route"],
      ["API Gateway", "Catalog", "Route"],
      ["API Gateway", "Payments", "Route"],
      ["Orders", "Orders DB", "SQL"],
      ["Catalog", "Catalog DB", "SQL"],
      ["Payments", "Payments DB", "SQL"],
    ],
    rows: [
      ["Orders", "Catalog", "Payments"],
      ["Orders DB", "Catalog DB", "Payments DB"],
    ],
    above: [
      ["Client", "API Gateway"],
      ["API Gateway", "Orders"],
      ["Orders", "Orders DB"],
    ],
    clusters: ["Clients", "Edge", "Services", "Data"],
  },
  {
    prompt: "draw a CQRS architecture",
    labels: ["Client", "API", "Commands", "Queries", "Write DB", "Read DB"],
    edges: [
      ["Client", "API"],
      ["API", "Commands", "Command"],
      ["API", "Queries", "Query"],
      ["Commands", "Write DB"],
      ["Queries", "Read DB"],
    ],
    above: [
      ["Commands", "API"],
      ["API", "Queries"],
      ["Write DB", "Read DB"],
    ],
  },
  {
    prompt: "draw an event-driven architecture",
    labels: ["Web", "Worker", "Event broker", "Billing", "Mail"],
    edges: [
      ["Web", "Event broker", "Publish"],
      ["Worker", "Event broker", "Publish"],
      ["Event broker", "Billing", "Deliver"],
      ["Event broker", "Mail", "Deliver"],
    ],
    rows: [
      ["Web", "Worker"],
      ["Billing", "Mail"],
    ],
    above: [
      ["Web", "Event broker"],
      ["Event broker", "Billing"],
    ],
    clusters: ["Producers", "Bus", "Consumers"],
  },
  {
    prompt: "draw a cache-aside diagram",
    labels: ["Client", "App", "Cache", "Database"],
    edges: [
      ["Client", "App", "Request"],
      ["App", "Cache", "GET"],
      ["Cache", "App", "Miss"],
      ["App", "Database", "Load"],
      ["Database", "App", "Value"],
      ["App", "Cache", "SET"],
      ["App", "Client", "Response"],
    ],
    messages: ["Request", "GET", "Miss", "Load", "Value", "SET", "Response"],
  },
  {
    prompt: "draw a CDN architecture",
    labels: ["Browser", "CDN", "Origin", "Object storage"],
    edges: [
      ["Browser", "CDN", "GET"],
      ["CDN", "Origin", "Miss"],
      ["Origin", "Object storage", "Read"],
    ],
    above: [
      ["Browser", "CDN"],
      ["CDN", "Origin"],
      ["Origin", "Object storage"],
    ],
    clusters: ["Clients", "Edge", "Origin", "Storage"],
  },
  {
    prompt: "draw a load balancer architecture",
    labels: ["Client", "Load balancer", "App A", "App B", "Database"],
    edges: [
      ["Client", "Load balancer", "Request"],
      ["Load balancer", "App A", "Forward"],
      ["Load balancer", "App B", "Forward"],
      ["App A", "Database", "SQL"],
      ["App B", "Database", "SQL"],
    ],
    rows: [["App A", "App B"]],
    above: [
      ["Client", "Load balancer"],
      ["Load balancer", "App A"],
      ["App A", "Database"],
    ],
  },
  {
    prompt: "draw a checkout sequence diagram",
    labels: ["User", "Browser", "Checkout", "Payment", "Orders"],
    edges: [
      ["User", "Browser", "Place order"],
      ["Browser", "Checkout", "POST /checkout"],
      ["Checkout", "Payment", "Charge"],
      ["Payment", "Checkout", "Approved"],
      ["Checkout", "Orders", "Save order"],
    ],
    messages: ["Place order", "POST /checkout", "Charge", "Approved", "Save order", "Saved", "Confirmation", "Receipt"],
  },
  {
    prompt: "draw an OAuth login sequence",
    labels: ["User", "Browser", "App", "Auth server"],
    edges: [
      ["Browser", "App", "GET /login"],
      ["App", "Auth server", "Exchange code"],
      ["Auth server", "App", "Access token"],
    ],
    messages: [
      "Click login",
      "GET /login",
      "Redirect",
      "Authorize",
      "Code",
      "Callback",
      "Exchange code",
      "Access token",
      "Session",
      "Logged in",
    ],
  },
  {
    prompt: "draw an API call sequence diagram",
    labels: ["Client", "API", "Service", "Database"],
    edges: [
      ["Client", "API", "HTTP request"],
      ["API", "Service", "Call"],
      ["Service", "Database", "Query"],
      ["API", "Client", "HTTP 200"],
    ],
    messages: ["HTTP request", "Call", "Query", "Rows", "Result", "HTTP 200"],
  },
  {
    prompt: "draw an approval workflow",
    labels: ["Submit request", "Manager review", "Approved", "Rejected", "Complete"],
    edges: [
      ["Submit request", "Manager review"],
      ["Manager review", "Approved", "Yes"],
      ["Manager review", "Rejected", "No"],
      ["Approved", "Complete"],
    ],
    rows: [["Submit request", "Manager review"]],
    above: [
      ["Approved", "Manager review"],
      ["Manager review", "Rejected"],
    ],
  },
  {
    prompt: "draw an e-commerce data model",
    labels: ["Customer", "Order", "Line item", "Product", "Payment"],
    edges: [
      ["Customer", "Order", "places"],
      ["Order", "Line item", "contains"],
      ["Line item", "Product", "for"],
      ["Order", "Payment", "paid with"],
    ],
    rows: [["Customer", "Order", "Line item", "Product"]],
    above: [["Order", "Payment"]],
  },
  {
    prompt: "draw an AWS VPC architecture with an ALB, ECS, and RDS",
    labels: ["Internet", "ALB", "ECS", "RDS"],
    edges: [
      ["Internet", "ALB", "HTTPS"],
      ["ALB", "ECS", "HTTP"],
      ["ECS", "RDS", "SQL"],
    ],
    above: [
      ["Internet", "ALB"],
      ["ALB", "ECS"],
      ["ECS", "RDS"],
    ],
    clusters: ["Edge", "Public subnet", "Private subnet", "Data subnet"],
  },
  {
    prompt: "draw a kubernetes deployment",
    labels: ["User", "Ingress", "Service", "Pod A", "Pod B", "Volume"],
    edges: [
      ["User", "Ingress", "HTTPS"],
      ["Ingress", "Service", "Route"],
      ["Service", "Pod A", "Forward"],
      ["Service", "Pod B", "Forward"],
      ["Pod A", "Volume", "Mount"],
      ["Pod B", "Volume", "Mount"],
    ],
    rows: [["Pod A", "Pod B"]],
    above: [
      ["User", "Ingress"],
      ["Ingress", "Service"],
      ["Service", "Pod A"],
      ["Pod A", "Volume"],
    ],
    clusters: ["Clients", "Edge", "Service", "Pods", "Storage"],
  },
  {
    prompt: "draw an order state machine",
    labels: ["Placed", "Paid", "Shipped", "Delivered", "Cancelled", "Refunded"],
    edges: [
      ["Placed", "Paid", "Pay"],
      ["Paid", "Shipped", "Ship"],
      ["Shipped", "Delivered", "Deliver"],
      ["Placed", "Cancelled", "Cancel"],
      ["Paid", "Refunded", "Refund"],
    ],
    rows: [["Placed", "Paid", "Shipped", "Delivered"]],
    above: [
      ["Placed", "Cancelled"],
      ["Paid", "Refunded"],
    ],
  },
  {
    prompt: "draw a network diagram with a firewall and a DMZ",
    labels: ["Internet", "Firewall", "Web server", "Bastion", "App server", "Database"],
    edges: [
      ["Internet", "Firewall", "Inbound"],
      ["Firewall", "Web server", "Allow"],
      ["Firewall", "Bastion", "Allow"],
      ["Web server", "App server", "Proxy"],
      ["App server", "Database", "SQL"],
    ],
    rows: [["Web server", "Bastion"]],
    above: [
      ["Internet", "Firewall"],
      ["Firewall", "Web server"],
      ["Web server", "App server"],
      ["App server", "Database"],
    ],
    clusters: ["Internet", "Perimeter", "DMZ", "Internal", "Private"],
  },
  {
    prompt: "draw a system architecture",
    labels: ["Browser", "Web", "API", "Database"],
    edges: [
      ["Browser", "Web", "HTTPS"],
      ["Web", "API", "Call"],
      ["API", "Database", "SQL"],
    ],
    above: [
      ["Browser", "Web"],
      ["Web", "API"],
      ["API", "Database"],
    ],
    clusters: ["Clients", "Web", "API", "Data"],
  },
];

describe("popular diagram templates", () => {
  for (const fixture of FIXTURES) {
    it(fixture.prompt, () => {
      const drawn = previewDemo(fixture.prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape");
      assert.equal(drawn.decision.reply.includes("No diagram change"), false);
      assert.notEqual(drawn.xml, STARTER_XML);
      const report = assertClean(drawn.xml);
      for (const label of fixture.labels) box(report, label);
      assert.ok(content(report.nodes).every((node) => node.style.includes("fillColor=#ffffff")));
      for (const [from, to, label] of fixture.edges) linked(report, from, to, label);
      for (const row of fixture.rows ?? []) sameRow(report, row);
      for (const [upper, lower] of fixture.above ?? []) above(report, upper, lower);
      if (fixture.messages) {
        const messages = report.edges
          .filter((edge) => edge.label)
          .sort((a, b) => exitY(a.style) - exitY(b.style));
        assert.deepEqual(
          messages.map((edge) => edge.label),
          fixture.messages,
        );
      }
      if (fixture.clusters) {
        const clusters = fixture.clusters.map((label) => {
          const found = report.nodes.find((node) => node.label === label && node.role === "cluster");
          assert.ok(found, `cluster ${label}`);
          return found;
        });
        for (let index = 1; index < clusters.length; index += 1) {
          const previous = clusters[index - 1];
          const current = clusters[index];
          assert.ok(previous && current);
          assert.ok(previous.y < current.y, `${previous.label} above ${current.label}`);
        }
      }
    });
  }

  it("keeps a 3-tier web app on the chain planner", () => {
    const report = assertClean(previewDemo("draw a 3 tier system architecture", STARTER_XML).xml);
    assert.deepEqual(
      report.nodes.map((node) => node.label),
      ["Client", "App", "Postgres"],
    );
    assert.equal(report.nodes.some((node) => node.role === "cluster"), false);
  });

  it("leaves an existing canvas in place instead of pasting a template over it", () => {
    const kept = previewDemo("draw a user login sequence diagram", SEEDED_XML);
    assert.equal(kept.decision.intent, "noop");
    assert.match(kept.decision.reply, /left it in place/i);
    assert.equal(kept.xml, SEEDED_XML);
  });

  it("does not redraw when the template is already on the canvas", () => {
    const first = previewDemo("draw a user login sequence diagram", STARTER_XML);
    const second = previewDemo("draw a user login sequence diagram", first.xml);
    assert.equal(second.decision.intent, "noop");
    assert.match(second.decision.reply, /canvas is unchanged/i);
    assert.match(second.decision.reply, /try again/i);
    assert.equal(second.xml, first.xml);
    const tier = previewDemo("draw a 3 tier web app", STARTER_XML);
    const again = previewDemo("draw a 3 tier web app", tier.xml);
    assert.equal(again.decision.intent, "noop");
    assert.match(again.decision.reply, /canvas is unchanged/i);
    assert.match(again.decision.reply, /try again/i);
    assert.equal(again.xml, tier.xml);
  });

  it("paints a named color and leaves clusters in the wireframe", () => {
    const report = assertClean(previewDemo("draw a microservices architecture in blue", STARTER_XML).xml);
    const services = content(report.nodes);
    assert.ok(services.every((node) => node.style.includes("fillColor=#dae8fc")));
    const clusters = report.nodes.filter((node) => node.role === "cluster");
    assert.ok(clusters.length >= 3);
    assert.ok(clusters.every((node) => node.style.includes("fillColor=#f1f5f9")));
  });

  it("draws Kafka, a blog model, a business process, and a document lifecycle", () => {
    const kafka = assertClean(previewDemo("draw a kafka architecture", STARTER_XML).xml);
    assert.ok(content(kafka.nodes).some((node) => node.label === "Kafka"));
    linked(kafka, "Web", "Kafka", "Publish");

    const blog = assertClean(previewDemo("draw a blog data model", STARTER_XML).xml);
    linked(blog, "User", "Post", "writes");
    linked(blog, "Post", "Comment", "has");
    linked(blog, "Post", "Tag", "tagged");

    const process = previewDemo("draw a business process flowchart", STARTER_XML);
    assert.match(process.decision.reply, /business process/i);
    linked(assertClean(process.xml), "Manager review", "Rejected", "No");

    const states = assertClean(previewDemo("draw a state machine", STARTER_XML).xml);
    linked(states, "Draft", "Review", "Submit");
    linked(states, "Review", "Published", "Approve");
    linked(states, "Review", "Rejected", "Reject");
  });

  it("leaves a generic sequence and flowchart alone", () => {
    const sequence = assertClean(previewDemo("draw a password reset sequence diagram", STARTER_XML).xml);
    assert.deepEqual(
      content(sequence.nodes).map((node) => node.label),
      ["User", "Service"],
    );
    const flow = assertClean(previewDemo("draw a flowchart for making coffee", STARTER_XML).xml);
    assert.ok(content(flow.nodes).some((node) => node.label === "Start"));
    assert.ok(content(flow.nodes).some((node) => node.label === "Done"));
  });

  it("turns a research brief into a clean diagram when no template matches", () => {
    const cache = composeFromBrief(
      "Draw a memcached diagram usage",
      "Memcached is a distributed memory caching system used to speed up dynamic web applications by holding recent values.",
    );
    assert.ok(cache);
    const cacheReport = assertClean(renderComposition(cache));
    linked(cacheReport, "App", "Memcached", "GET / SET");
    linked(cacheReport, "App", "Database", "Read on miss");

    const bus = composeFromBrief(
      "Draw a nats diagram architecture",
      "NATS is a message broker. Services publish to a subject and workers deliver each message from the queue.",
    );
    assert.ok(bus);
    const busReport = assertClean(renderComposition(bus));
    linked(busReport, "App", "Nats", "Publish");
    linked(busReport, "Nats", "Worker", "Deliver");

    const store = composeFromBrief(
      "Draw a minio diagram usage",
      "MinIO is an object storage server. Applications put and get objects from a bucket instead of a local disk.",
    );
    assert.ok(store);
    const storeReport = assertClean(renderComposition(store));
    linked(storeReport, "Minio", "Storage", "Put / Get");
    assert.equal(composeFromBrief("Make the API box red", "Redis is an in-memory data store used as a cache by applications."), null);
  });
});
