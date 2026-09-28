import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDiagram, type QualityNode } from "../src/lib/drawio/layout";
import { PALETTE } from "../src/lib/drawio/styles";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { previewDemo } from "../src/lib/kev/demo";
import { composeNamedDiagram, extractNamedEntities, maxSparseEdges } from "../src/lib/kev/entities";
import { overNamedCapacity, resolveComposition } from "../src/lib/kev/compose";

const PASTEL = new Set(Object.values(PALETTE).map((color) => color.fill.toLowerCase()));

function content(nodes: QualityNode[]): QualityNode[] {
  return nodes.filter((node) => node.role !== "lifeline" && node.role !== "cluster" && node.role !== "anchor");
}

const MEGA =
  "Sketch our live multi-region SaaS stack end to end: edge traffic hits Cloudflare CDN plus WAF; the app is Next.js hosted on Vercel with Auth0 for login and Stripe Billing for payments; an API Gateway fans out to Users, Orders, and Inventory microservices, each backed by its own Postgres; put Redis in front for hot reads; Kafka carries domain events; Elasticsearch handles search; S3 stores media uploads; background workers run on Fly.io talking to Tigris object storage and Upstash Redis; wire OpenTelemetry into Grafana; CI is GitHub Actions flowing Build then Test then Deploy.";

const DENSE =
  "Draw a dense production SaaS architecture diagram with named brands kept intact. Front door: Cloudflare CDN and Cloudflare WAF. App tier: Next.js on Vercel, Auth0 login, Stripe Billing. Behind an API Gateway sit three services — Users service, Orders service, Inventory service — each with its own Postgres database. Caching via Redis; events on Kafka; search on Elasticsearch; media on S3. Worker fleet on Fly.io using Tigris for objects and Upstash Redis for queues. Observability: OpenTelemetry exporting to Grafana. Use topic containers, pastel fills, and labeled edges.";

const TOPOLOGY =
  "Sketch a multi-tier topology: browser clients, Cloudflare CDN, Next.js on Vercel, Auth0, an API gateway, Orders and Inventory services, Postgres, and a Redis cache-aside in front of the primary database. Kafka carries events and S3 holds uploads.";

describe("dense composition", () => {
  it("does not send a multi-service ask to one micro-template", () => {
    for (const prompt of [MEGA, TOPOLOGY]) {
      const composed = resolveComposition(prompt);
      assert.ok(composed, prompt);
      assert.doesNotMatch(composed.spec.reply, /Drew a CI\/CD pipeline/, prompt);
      assert.doesNotMatch(composed.spec.reply, /cache-aside/i, prompt);
      const drawn = previewDemo(prompt, STARTER_XML);
      assert.equal(drawn.decision.intent, "add_shape", prompt);
      const labels = content(assessDiagram(drawn.xml).nodes).map((node) => node.label);
      for (const brand of ["Postgres", "Kafka", "S3", "API Gateway"]) {
        assert.ok(
          labels.some((label) => label.toLowerCase().includes(brand.toLowerCase())),
          `${prompt} missing ${brand} in ${labels.join(", ")}`,
        );
      }
      assert.ok(labels.length >= 8, `${labels.length} labels`);
    }
  });

  it("strips style and grammar tokens from vertex candidates", () => {
    const labels = extractNamedEntities(DENSE).map((entity) => entity.label);
    for (const junk of ["Each", "Own", "Pastel", "Pastel Fills", "Fills", "Labeled", "Label", "Containers"]) {
      assert.equal(labels.includes(junk), false, `${junk} in ${labels.join(", ")}`);
    }
    const drawn = content(assessDiagram(previewDemo(DENSE, STARTER_XML).xml).nodes).map((node) => node.label);
    for (const junk of ["Each", "Own", "Pastel Fills", "Labeled"]) {
      assert.equal(drawn.includes(junk), false, junk);
    }
  });

  it("keeps brand tokens beside role words instead of synonymizing them away", () => {
    const labels = extractNamedEntities(DENSE).map((entity) => entity.label);
    for (const brand of ["Stripe", "Postgres", "Kafka", "S3", "API Gateway", "Cloudflare", "OpenTelemetry", "Grafana"]) {
      assert.ok(
        labels.some((label) => label.toLowerCase().includes(brand.toLowerCase())),
        `${brand} missing from ${labels.join(", ")}`,
      );
    }
    assert.equal(labels.includes("Billing"), false, labels.join(", "));
    assert.equal(labels.includes("Events"), false, labels.join(", "));
    assert.equal(labels.includes("Own"), false, labels.join(", "));

    const drawn = previewDemo(DENSE, STARTER_XML);
    const report = assessDiagram(drawn.xml);
    const drawnLabels = content(report.nodes).map((node) => node.label);
    for (const brand of ["Stripe", "Postgres", "Kafka", "S3", "Grafana"]) {
      assert.ok(drawnLabels.some((label) => label.toLowerCase().includes(brand.toLowerCase())), brand);
    }
    assert.ok(report.nodes.some((node) => node.role === "cluster"));
    for (const node of content(report.nodes)) {
      const fill = node.style.match(/fillColor=(#[0-9a-f]{6})/i)?.[1]?.toLowerCase();
      assert.ok(fill && PASTEL.has(fill) && fill !== "#ffffff", node.label);
    }
    assert.ok(report.edges.every((edge) => edge.label.length > 0));
  });

  it("bounds edges to a sparse tier topology", () => {
    const named = composeNamedDiagram(DENSE);
    assert.ok(named);
    assert.ok(named.edges.length <= maxSparseEdges(named.participants.length), `${named.edges.length} edges`);
    assert.ok(named.edges.length < named.participants.length * 3);

    const report = assessDiagram(previewDemo(DENSE, STARTER_XML).xml);
    const nodes = content(report.nodes);
    assert.ok(report.edges.length <= maxSparseEdges(nodes.length), `${report.edges.length} for ${nodes.length}`);
    assert.deepEqual(report.overlaps, []);
  });

  it("splices an additive CI strip onto an open canvas", () => {
    const base = previewDemo(
      "Draw a Redis cache-aside pattern: client, application servers, Redis cache, and primary database.",
      STARTER_XML,
    );
    assert.match(base.decision.reply, /cache-aside/i);
    const before = content(assessDiagram(base.xml).nodes).map((node) => node.label);

    const extended = previewDemo(
      "Also attach a CI strip: GitHub Actions flowing Build then Test then Deploy.",
      base.xml,
    );
    assert.equal(extended.decision.intent, "add_shape");
    assert.doesNotMatch(extended.decision.reply, /left it in place/i);
    assert.match(extended.decision.reply, /Added/);
    const labels = content(assessDiagram(extended.xml).nodes).map((node) => node.label);
    for (const kept of before) assert.ok(labels.includes(kept), kept);
    for (const added of ["GitHub Actions", "Build", "Test", "Deploy"]) {
      assert.ok(labels.includes(added), `${added} in ${labels.join(", ")}`);
    }
    assert.deepEqual(assessDiagram(extended.xml).overlaps, []);
  });

  it("still refuses to paste a full diagram over an unrelated canvas", () => {
    const kept = previewDemo("draw a user login sequence diagram", SEEDED_XML);
    assert.equal(kept.decision.intent, "noop");
    assert.match(kept.decision.reply, /left it in place/i);
    assert.equal(kept.xml, SEEDED_XML);
  });

  it("clarifies instead of drawing when the ask is over capacity", () => {
    const prompt = `Draw ${Array.from({ length: 45 }, (_, index) => `Service${index}`).join(", ")}.`;
    assert.equal(overNamedCapacity(prompt), true);
    const drawn = previewDemo(prompt, STARTER_XML);
    assert.equal(drawn.decision.intent, "clarify");
    assert.match(drawn.decision.reply, /more services than fit/i);
    assert.equal(drawn.xml, STARTER_XML);
  });
});
