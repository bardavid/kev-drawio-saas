import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDiagram, type QualityNode, type QualityReport } from "../src/lib/drawio/layout";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { describeComposition, renderComposition, resolveComposition } from "../src/lib/kev/compose";
import { previewDemo } from "../src/lib/kev/demo";
import { composeFromBrief, matchTemplate } from "../src/lib/kev/templates";

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
    prompt: "draw an AWS serverless architecture with API Gateway, Lambda, and DynamoDB",
    labels: ["Client", "API Gateway", "Lambda", "DynamoDB"],
    edges: [
      ["Client", "API Gateway", "HTTPS"],
      ["API Gateway", "Lambda", "Invoke"],
      ["Lambda", "DynamoDB", "Read / write"],
    ],
    above: [
      ["Client", "API Gateway"],
      ["API Gateway", "Lambda"],
      ["Lambda", "DynamoDB"],
    ],
    clusters: ["Clients", "Edge", "Compute", "Data"],
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
    labels: ["User", "Ingress", "Service", "Deployment", "Pod A", "Pod B", "Volume"],
    edges: [
      ["User", "Ingress", "HTTPS"],
      ["Ingress", "Service", "Route"],
      ["Service", "Deployment", "Forward"],
      ["Deployment", "Pod A", "Run"],
      ["Deployment", "Pod B", "Run"],
      ["Pod A", "Volume", "Mount"],
      ["Pod B", "Volume", "Mount"],
    ],
    rows: [["Pod A", "Pod B"]],
    above: [
      ["User", "Ingress"],
      ["Ingress", "Service"],
      ["Service", "Deployment"],
      ["Deployment", "Pod A"],
      ["Pod A", "Volume"],
    ],
    clusters: ["Clients", "Edge", "Service", "Deployment", "Pods", "Storage"],
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
    prompt: "draw a GCP architecture with Cloud Load Balancing, Cloud Run, Cloud SQL, and Pub/Sub",
    labels: ["Internet", "Cloud Load Balancing", "Cloud Run", "Cloud SQL", "Pub/Sub"],
    edges: [
      ["Internet", "Cloud Load Balancing", "HTTPS"],
      ["Cloud Load Balancing", "Cloud Run", "HTTP"],
      ["Cloud Run", "Cloud SQL", "SQL"],
      ["Cloud Run", "Pub/Sub", "Publish"],
    ],
    above: [
      ["Internet", "Cloud Load Balancing"],
      ["Cloud Load Balancing", "Cloud Run"],
      ["Cloud Run", "Cloud SQL"],
      ["Cloud SQL", "Pub/Sub"],
    ],
    clusters: ["Clients", "Edge", "Compute", "Data"],
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
  {
    prompt:
      "Draw a clean 3-tier web application architecture: browser clients, CDN, load balancer, web/app servers, and a database tier. Label tiers clearly.",
    labels: ["Browser", "CDN", "Load balancer", "Web/app servers", "Database"],
    edges: [
      ["Browser", "CDN", "Request"],
      ["CDN", "Load balancer", "HTTPS"],
      ["Load balancer", "Web/app servers", "Forward"],
      ["Web/app servers", "Database", "SQL"],
    ],
    rows: [
      ["Browser", "CDN"],
      ["Load balancer", "Web/app servers"],
    ],
    above: [
      ["Browser", "Load balancer"],
      ["Load balancer", "Database"],
    ],
    clusters: ["Presentation tier", "Application tier", "Data tier"],
  },
  {
    prompt:
      "Draw an AWS architecture: VPC with public and private subnets, Application Load Balancer in public, ECS services in private, RDS in private data subnet. Show Internet Gateway and NAT. Label components clearly.",
    labels: ["Internet", "Internet Gateway", "NAT", "Application Load Balancer", "ECS", "RDS"],
    edges: [
      ["Internet", "Internet Gateway", "Ingress"],
      ["Internet Gateway", "Application Load Balancer", "HTTPS"],
      ["Application Load Balancer", "ECS", "Forward"],
      ["ECS", "RDS", "SQL"],
      ["ECS", "NAT", "Outbound"],
      ["NAT", "Internet Gateway", "Egress"],
    ],
    rows: [["NAT", "Application Load Balancer"]],
    above: [
      ["Internet", "Internet Gateway"],
      ["Internet Gateway", "NAT"],
      ["Application Load Balancer", "ECS"],
      ["ECS", "RDS"],
    ],
    clusters: ["Internet", "VPC", "Gateway", "Public subnet", "Private subnet", "Private data subnet"],
  },
  {
    prompt:
      "Draw a Redis cache-aside pattern: client, application servers, Redis cache, and primary database. Show cache hit vs miss paths clearly (hit returns from Redis; miss goes to DB then populates Redis).",
    labels: ["Client", "Application servers", "Redis", "Primary database"],
    edges: [
      ["Client", "Application servers", "Request"],
      ["Application servers", "Redis", "GET"],
      ["Redis", "Application servers", "Hit"],
      ["Application servers", "Client", "Return hit"],
      ["Redis", "Application servers", "Miss"],
      ["Application servers", "Primary database", "Load"],
      ["Application servers", "Redis", "Populate"],
    ],
    messages: ["Request", "GET", "Hit", "Return hit", "Miss", "Load", "Value", "Populate", "Response"],
  },
  {
    prompt:
      "Draw a UML sequence diagram for a login flow: User, Browser, Auth Service, User DB. Include request credentials, validate, DB lookup, session cookie set. Top-down sequence layout.",
    labels: ["User", "Browser", "Auth Service", "User DB"],
    edges: [
      ["User", "Browser", "Request credentials"],
      ["Browser", "Auth Service", "Validate"],
      ["Auth Service", "User DB", "DB lookup"],
      ["Auth Service", "Browser", "Session cookie set"],
    ],
    messages: ["Request credentials", "Validate", "DB lookup", "User record", "Session cookie set"],
  },
  {
    prompt: "draw a microservices architecture with API gateway, auth service, orders service, and Kafka",
    labels: ["Client", "API Gateway", "Auth Service", "Orders Service", "Kafka"],
    edges: [
      ["Client", "API Gateway", "HTTPS"],
      ["API Gateway", "Auth Service", "Route"],
      ["API Gateway", "Orders Service", "Route"],
      ["Auth Service", "Kafka", "Publish"],
      ["Orders Service", "Kafka", "Publish"],
    ],
    rows: [["Auth Service", "Orders Service"]],
    above: [
      ["Client", "API Gateway"],
      ["API Gateway", "Auth Service"],
      ["Auth Service", "Kafka"],
    ],
    clusters: ["Clients", "Edge", "Services", "Bus"],
  },
  {
    prompt: "draw a UML sequence diagram for user login with browser, auth service, and database",
    labels: ["User", "Browser", "Auth Service", "Database"],
    edges: [
      ["User", "Browser", "Enter credentials"],
      ["Browser", "Auth Service", "POST /login"],
      ["Auth Service", "Database", "Query"],
      ["Database", "Auth Service", "User record"],
      ["Auth Service", "Browser", "Session"],
    ],
    messages: ["Enter credentials", "POST /login", "Query", "User record", "Session", "Logged in"],
  },
  {
    prompt: "draw an AWS architecture with ALB, ECS Fargate, RDS, and ElastiCache",
    labels: ["Internet", "ALB", "ECS Fargate", "RDS", "ElastiCache"],
    edges: [
      ["Internet", "ALB", "HTTPS"],
      ["ALB", "ECS Fargate", "HTTP"],
      ["ECS Fargate", "RDS", "SQL"],
      ["ECS Fargate", "ElastiCache", "Cache"],
    ],
    above: [
      ["Internet", "ALB"],
      ["ALB", "ECS Fargate"],
      ["ECS Fargate", "RDS"],
      ["RDS", "ElastiCache"],
    ],
    clusters: ["Edge", "Public subnet", "Private subnet", "Data subnet"],
  },
  {
    prompt: "draw a GCP data pipeline with Pub/Sub, Dataflow, and BigQuery",
    labels: ["Pub/Sub", "Dataflow", "BigQuery"],
    edges: [
      ["Pub/Sub", "Dataflow", "Stream"],
      ["Dataflow", "BigQuery", "Load"],
    ],
    above: [
      ["Pub/Sub", "Dataflow"],
      ["Dataflow", "BigQuery"],
    ],
    clusters: ["Ingest", "Processing", "Warehouse"],
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
      assert.ok(
        report.nodes.every((node) => node.x >= 80),
        `${fixture.prompt} left edge ${Math.min(...report.nodes.map((node) => node.x))}`,
      );
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

  it("routes AWS serverless asks to API Gateway, Lambda, and DynamoDB before the VPC sketch", () => {
    const prompt = "draw an AWS serverless architecture with API Gateway, Lambda, and DynamoDB";
    const matched = matchTemplate(prompt);
    assert.equal(matched?.spec.title, "AWS serverless");
    const composition = resolveComposition(prompt);
    assert.ok(composition);
    const outline = describeComposition(composition);
    assert.match(outline, /API Gateway/);
    assert.match(outline, /Lambda/);
    assert.match(outline, /DynamoDB/);
    assert.doesNotMatch(outline, /\bALB\b/);
    assert.doesNotMatch(outline, /\bECS\b/);
    assert.doesNotMatch(outline, /\bRDS\b/);

    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.equal(drawn.decision.reply.includes("Which nodes should I draw"), false);
    assert.match(drawn.xml, /<mxfile[\s>]/);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["API Gateway", "Lambda", "DynamoDB"]) assert.ok(labels.includes(label), label);
    for (const stolen of ["ALB", "ECS", "RDS", "Application Load Balancer"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }

    for (const variant of [
      "draw a serverless architecture",
      "draw an API with API Gateway and Lambda",
      "draw an AWS architecture that uses DynamoDB",
      "sketch Amazon API Gateway calling Lambda",
    ]) {
      assert.equal(matchTemplate(variant)?.spec.title, "AWS serverless", variant);
      const variantLabels = content(assertClean(previewDemo(variant, STARTER_XML).xml).nodes).map((node) => node.label);
      assert.ok(variantLabels.includes("API Gateway"), variant);
      assert.ok(variantLabels.includes("Lambda"), variant);
      assert.ok(variantLabels.includes("DynamoDB"), variant);
      assert.equal(variantLabels.includes("ALB"), false, variant);
    }

    assert.equal(
      matchTemplate("draw an AWS VPC architecture with an ALB, ECS, and RDS")?.spec.title,
      "AWS VPC",
    );
    assert.equal(matchTemplate("draw a cloud architecture")?.spec.title, "AWS VPC");
    assert.equal(matchTemplate("draw a kubernetes deployment")?.spec.title, "Kubernetes");
    assert.equal(matchTemplate("draw a kubernetes serverless deployment")?.spec.title, "Kubernetes");
    assert.equal(matchTemplate("draw a GCP architecture")?.spec.title, "GCP");
    assert.equal(matchTemplate("draw a GCP serverless architecture with Cloud Functions")?.spec.title, "GCP");
    assert.equal(matchTemplate("draw a Serverless VPC Access connector")?.spec.title, "GCP");
    assert.equal(matchTemplate("draw Cloud Functions")?.spec.title, "GCP");
    const gcp = content(
      assertClean(
        previewDemo(
          "draw a GCP architecture with Cloud Load Balancing, Cloud Run, Cloud SQL, and Pub/Sub",
          STARTER_XML,
        ).xml,
      ).nodes,
    ).map((node) => node.label);
    assert.ok(gcp.includes("Cloud Run"));
    assert.equal(gcp.includes("Lambda"), false);
    assert.equal(gcp.includes("DynamoDB"), false);
  });

  it("routes Azure architecture to named Azure services before the generic chain and the VPC sketch", () => {
    const prompt = "draw an Azure architecture with Application Gateway, App Service, Azure SQL, and Service Bus";
    const matched = matchTemplate(prompt);
    assert.equal(matched?.spec.title, "Azure");
    const composition = resolveComposition(prompt);
    assert.ok(composition);
    const outline = describeComposition(composition);
    assert.match(outline, /Application Gateway/);
    assert.match(outline, /App Service/);
    assert.match(outline, /Azure SQL/);
    assert.match(outline, /Service Bus/);
    assert.doesNotMatch(outline, /\bALB\b/);
    assert.doesNotMatch(outline, /\bECS\b/);
    assert.doesNotMatch(outline, /\bRDS\b/);

    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.equal(drawn.decision.reply.includes("Which nodes should I draw"), false);
    assert.doesNotMatch(drawn.decision.reply, /Gateway → Service → Sql/);
    assert.match(drawn.xml, /<mxfile[\s>]/);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["Application Gateway", "App Service", "Azure SQL", "Service Bus"]) {
      assert.ok(labels.includes(label), label);
    }
    for (const stolen of ["Gateway", "Service", "Sql", "ALB", "ECS", "RDS", "Lambda", "DynamoDB"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }
    above(report, "Application Gateway", "App Service");
    above(report, "App Service", "Azure SQL");
    above(report, "Azure SQL", "Service Bus");
    linked(report, "Application Gateway", "App Service", "HTTP");
    linked(report, "App Service", "Azure SQL", "SQL");
    linked(report, "App Service", "Service Bus", "Publish");

    for (const variant of [
      "draw an Azure architecture",
      "draw an Azure cloud architecture",
      "draw an Azure serverless architecture",
      "draw Application Gateway, App Service, Azure SQL, and Service Bus",
      "sketch an architecture with App Gateway, App Service, Azure SQL, and Service Bus",
    ]) {
      assert.equal(matchTemplate(variant)?.spec.title, "Azure", variant);
      const variantLabels = content(assertClean(previewDemo(variant, STARTER_XML).xml).nodes).map((node) => node.label);
      for (const label of ["Application Gateway", "App Service", "Azure SQL", "Service Bus"]) {
        assert.ok(variantLabels.includes(label), `${variant} missing ${label}`);
      }
      assert.equal(variantLabels.includes("ALB"), false, variant);
      assert.equal(variantLabels.includes("Lambda"), false, variant);
    }

    assert.equal(matchTemplate("draw a cloud architecture")?.spec.title, "AWS VPC");
    assert.equal(
      matchTemplate("draw an AWS serverless architecture with API Gateway, Lambda, and DynamoDB")?.spec.title,
      "AWS serverless",
    );
    assert.equal(matchTemplate("draw a GCP architecture")?.spec.title, "GCP");
    assert.equal(matchTemplate("draw a kubernetes deployment")?.spec.title, "Kubernetes");
  });

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

  it("includes Deployment when a Kubernetes prompt names Ingress, Service, Deployment, and Pods", () => {
    const report = assertClean(
      previewDemo(
        "draw a Kubernetes deployment with Ingress, Service, Deployment, and Pods",
        STARTER_XML,
      ).xml,
    );
    for (const label of ["Ingress", "Service", "Deployment", "Pod A", "Pod B"]) box(report, label);
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

  it("draws a sourdough feeding schedule as states, not a document lifecycle", () => {
    const drawn = previewDemo("draw a sourdough starter feeding schedule as a state machine", STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Client → App → Postgres/);
    assert.doesNotMatch(drawn.decision.reply, /Draft/);
    const report = assertClean(drawn.xml);
    assert.deepEqual(content(report.nodes).map((node) => node.label), [
      "Hungry",
      "Discard",
      "Feed",
      "Ferment",
      "Peak",
    ]);
    linked(report, "Hungry", "Discard", "Refresh");
    linked(report, "Feed", "Ferment", "Rest");
    linked(report, "Ferment", "Peak", "Doubled");
  });

  it("uses states named in the request instead of a document lifecycle", () => {
    const report = assertClean(previewDemo("draw a state machine: Mix → Bulk → Proof → Bake", STARTER_XML).xml);
    assert.deepEqual(
      content(report.nodes).map((node) => node.label),
      ["Mix", "Bulk", "Proof", "Bake"],
    );
    linked(report, "Mix", "Bulk", "Next");
    linked(report, "Proof", "Bake", "Next");
  });

  it("does not force an unrelated lifecycle onto documents", () => {
    const report = assertClean(previewDemo("draw a subscription lifecycle", STARTER_XML).xml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.ok(labels.some((label) => /subscription/i.test(label)));
    assert.equal(labels.includes("Draft"), false);
    assert.equal(labels.includes("Published"), false);
  });

  it("keeps a bare Pub/Sub ask on the event-driven template", () => {
    for (const prompt of ["draw a Pub/Sub architecture", "draw a pubsub diagram", "draw an event-driven architecture"]) {
      const report = assertClean(previewDemo(prompt, STARTER_XML).xml);
      assert.ok(content(report.nodes).some((node) => node.label === "Event broker"), prompt);
      assert.equal(
        content(report.nodes).some((node) => node.label === "Cloud Run"),
        false,
        prompt,
      );
    }
  });

  it("draws the harsh GCP prompt with native service labels, not the event bus", () => {
    const prompt =
      "Draw a GCP architecture with Cloud Load Balancing in front of Cloud Run services, Cloud SQL for Postgres, and Pub/Sub for async events. Include a VPC connector if needed. Label GCP services.";
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.match(drawn.decision.reply, /Cloud Load Balancing/);
    assert.match(drawn.decision.reply, /VPC connector/);
    assert.equal(/event-driven|Event broker/i.test(drawn.decision.reply), false);
    const report = assertClean(drawn.xml);
    for (const label of ["Cloud Load Balancing", "Cloud Run", "Cloud SQL", "Pub/Sub", "VPC connector"]) {
      box(report, label);
    }
    for (const stolen of ["Event broker", "Web", "Worker", "Billing", "Mail"]) {
      assert.equal(
        content(report.nodes).some((node) => node.label === stolen),
        false,
        stolen,
      );
    }
    above(report, "Cloud Load Balancing", "Cloud Run");
    above(report, "Cloud Run", "VPC connector");
    above(report, "VPC connector", "Cloud SQL");
    above(report, "Cloud SQL", "Pub/Sub");
    linked(report, "Cloud Load Balancing", "Cloud Run", "HTTP");
    linked(report, "Cloud Run", "VPC connector", "Private");
    linked(report, "VPC connector", "Cloud SQL", "SQL");
    linked(report, "Cloud Run", "Pub/Sub", "Publish");
    assert.equal(
      composeFromBrief(
        prompt,
        "Pub/Sub is a message bus. Producers publish events and workers deliver them to billing and mail systems.",
      ),
      null,
    );
  });

  it("does not keyword-match the event bus when a GCP service is named", () => {
    for (const prompt of ["draw Cloud Run and Pub/Sub", "draw Cloud SQL and Kafka", "draw a VPC connector and Pub/Sub"]) {
      const report = assertClean(previewDemo(prompt, STARTER_XML).xml);
      assert.equal(content(report.nodes).some((node) => node.label === "Event broker"), false, prompt);
      assert.equal(content(report.nodes).some((node) => node.label === "Kafka"), false, prompt);
      assert.equal(content(report.nodes).some((node) => node.label === "Web"), false, prompt);
    }
    const kafka = assertClean(previewDemo("draw a kafka architecture", STARTER_XML).xml);
    assert.ok(content(kafka.nodes).some((node) => node.label === "Kafka"));
  });

  it("does not let Pub/Sub steal a multi-service GCP architecture", () => {
    const prompts = [
      "draw a GCP architecture with Cloud Load Balancing, Cloud Run, Cloud SQL, and Pub/Sub",
      "draw Cloud Run, Cloud SQL, Cloud Load Balancing, and Pub/Sub",
      "draw a Google Cloud architecture with Cloud Run and Cloud SQL",
    ];
    for (const prompt of prompts) {
      const report = assertClean(previewDemo(prompt, STARTER_XML).xml);
      assert.equal(content(report.nodes).some((node) => node.label === "Event broker"), false, prompt);
      assert.equal(content(report.nodes).some((node) => node.label === "ALB"), false, prompt);
      assert.ok(content(report.nodes).some((node) => node.label === "Cloud Run"), prompt);
      assert.ok(content(report.nodes).some((node) => node.label === "Cloud SQL"), prompt);
    }
    const full = assertClean(
      previewDemo(
        "draw a GCP architecture with Cloud Load Balancing, Cloud Run, Cloud SQL, and Pub/Sub",
        STARTER_XML,
      ).xml,
    );
    for (const label of ["Cloud Load Balancing", "Cloud Run", "Cloud SQL", "Pub/Sub"]) box(full, label);
  });

  it("keeps named microservices and Kafka instead of the generic event bus", () => {
    const prompt = "draw a microservices architecture with API gateway, auth service, orders service, and Kafka";
    assert.equal(matchTemplate(prompt)?.spec.title, "Microservices");
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Client → App → Postgres/);
    assert.equal(drawn.decision.reply.includes("Which nodes should I draw"), false);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["API Gateway", "Auth Service", "Orders Service", "Kafka"]) {
      assert.ok(labels.includes(label), label);
    }
    for (const stolen of ["App", "Postgres", "Event broker", "Web", "Worker", "Billing", "Mail", "Catalog", "Payments"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }
    const kafka = assertClean(previewDemo("draw a kafka architecture", STARTER_XML).xml);
    assert.ok(content(kafka.nodes).some((node) => node.label === "Kafka"));
    assert.ok(content(kafka.nodes).some((node) => node.label === "Web"));
    const plain = assertClean(previewDemo("draw a microservices architecture", STARTER_XML).xml);
    assert.ok(content(plain.nodes).some((node) => node.label === "Catalog"));
    assert.equal(content(plain.nodes).some((node) => node.label === "Kafka"), false);
  });

  it("keeps a named database on a UML login sequence", () => {
    const prompt = "draw a UML sequence diagram for user login with browser, auth service, and database";
    const report = assertClean(previewDemo(prompt, STARTER_XML).xml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.deepEqual(labels, ["User", "Browser", "Auth Service", "Database"]);
    assert.ok(content(report.nodes).every((node) => node.style.includes("umlLifeline")));
    const plain = content(assertClean(previewDemo("draw a user login sequence diagram", STARTER_XML).xml).nodes).map(
      (node) => node.label,
    );
    assert.deepEqual(plain, ["User", "Browser", "Auth Service"]);
  });

  it("keeps ElastiCache and Fargate on an AWS container architecture", () => {
    const prompt = "draw an AWS architecture with ALB, ECS Fargate, RDS, and ElastiCache";
    assert.equal(matchTemplate(prompt)?.spec.title, "AWS VPC");
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    for (const label of ["ALB", "ECS Fargate", "RDS", "ElastiCache"]) assert.ok(labels.includes(label), label);
    for (const stolen of ["API Gateway", "Lambda", "DynamoDB"]) assert.equal(labels.includes(stolen), false, stolen);
    const serverless = content(
      assertClean(previewDemo("draw an AWS serverless architecture with API Gateway, Lambda, and DynamoDB", STARTER_XML).xml)
        .nodes,
    ).map((node) => node.label);
    assert.ok(serverless.includes("API Gateway"));
    assert.equal(serverless.includes("ElastiCache"), false);
    assert.equal(serverless.includes("ALB"), false);
    const vpc = content(
      assertClean(previewDemo("draw an AWS VPC architecture with an ALB, ECS, and RDS", STARTER_XML).xml).nodes,
    ).map((node) => node.label);
    assert.ok(vpc.includes("ECS"));
    assert.equal(vpc.includes("ECS Fargate"), false);
    assert.equal(vpc.includes("ElastiCache"), false);
  });

  it("draws a GCP data pipeline as Pub/Sub, Dataflow, and BigQuery", () => {
    const prompt = "draw a GCP data pipeline with Pub/Sub, Dataflow, and BigQuery";
    assert.equal(matchTemplate(prompt)?.spec.title, "GCP data pipeline");
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "add_shape");
    assert.doesNotMatch(drawn.decision.reply, /Client → App → Postgres/);
    assert.equal(drawn.decision.reply.includes("Which nodes should I draw"), false);
    assert.doesNotMatch(drawn.decision.reply, /Cloud Run/);
    const report = assertClean(drawn.xml);
    const labels = content(report.nodes).map((node) => node.label);
    assert.deepEqual(labels, ["Pub/Sub", "Dataflow", "BigQuery"]);
    for (const stolen of ["Cloud Load Balancing", "Cloud Run", "Cloud SQL", "Event broker", "Web"]) {
      assert.equal(labels.includes(stolen), false, stolen);
    }
    above(report, "Pub/Sub", "Dataflow");
    above(report, "Dataflow", "BigQuery");
    const web = content(
      assertClean(
        previewDemo("draw a GCP architecture with Cloud Load Balancing, Cloud Run, Cloud SQL, and Pub/Sub", STARTER_XML)
          .xml,
      ).nodes,
    ).map((node) => node.label);
    for (const label of ["Cloud Load Balancing", "Cloud Run", "Cloud SQL", "Pub/Sub"]) {
      assert.ok(web.includes(label), label);
    }
    assert.equal(web.includes("Dataflow"), false);
    assert.equal(matchTemplate("draw a Pub/Sub architecture")?.spec.title, "Event-driven");
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
