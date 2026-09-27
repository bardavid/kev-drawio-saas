import assert from "node:assert/strict";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import { DiagramXmlError, normalizeMxfile, summarizeDiagram } from "../src/lib/drawio/xml";
import { previewDemo } from "../src/lib/kev/demo";

function labels(xml: string): string[] {
  return summarizeDiagram(xml).vertices.map((vertex) => vertex.label);
}

describe("starter diagram", () => {
  it("opens on a blank page", () => {
    const summary = summarizeDiagram(STARTER_XML);
    assert.deepEqual(summary.vertices, []);
    assert.deepEqual(summary.edges, []);
    assert.match(STARTER_XML, /<mxGraphModel/);
    assert.equal(STARTER_XML.includes("Client"), false);
    assert.equal(STARTER_XML.includes("Postgres"), false);
    assert.equal(STARTER_XML.includes('value="API"'), false);
  });
});

describe("demo decisions", () => {
  it("adds a Postgres box connected to the API", () => {
    const { decision, xml } = previewDemo("Add a Postgres box connected to the API service", SEEDED_XML);
    assert.equal(decision.intent, "add_shape");
    assert.equal(decision.slots.shape, "cylinder");
    assert.equal(decision.slots.from, "API");
    const summary = summarizeDiagram(xml);
    assert.equal(summary.vertices.filter((vertex) => vertex.label === "Postgres").length, 2);
    assert.equal(summary.edges.filter((edge) => edge.from === "API" && edge.to === "Postgres").length, 2);
  });

  it("inserts Redis in front of the database and rewires the API", () => {
    const { decision, xml } = previewDemo("Add a Redis cache in front of the database", SEEDED_XML);
    assert.equal(decision.intent, "add_shape");
    assert.equal(decision.slots.place, "before");
    const summary = summarizeDiagram(xml);
    assert.ok(labels(xml).includes("Redis"));
    const redis = summary.vertices.find((vertex) => vertex.label === "Redis");
    const postgres = summary.vertices.find((vertex) => vertex.label === "Postgres");
    assert.ok(redis && postgres);
    assert.ok(redis.x < postgres.x);
    assert.ok(redis.style.includes("fillColor=#f8cecc"));
    assert.deepEqual(
      summary.edges.map((edge) => `${edge.from}->${edge.to}`).sort(),
      ["API->Redis", "Client->API", "Redis->Postgres"].sort(),
    );
  });

  it("connects an auth service from the client", () => {
    const { decision, xml } = previewDemo("Add an Auth service and connect the client to it", SEEDED_XML);
    assert.equal(decision.slots.label, "Auth");
    assert.equal(decision.slots.from, "Client");
    const summary = summarizeDiagram(xml);
    assert.ok(summary.edges.some((edge) => edge.from === "Client" && edge.to === "Auth"));
  });

  it("paints the API red without dropping rounded corners", () => {
    const { xml } = previewDemo("Make the API box red", SEEDED_XML);
    const api = summarizeDiagram(xml).vertices.find((vertex) => vertex.label === "API");
    assert.ok(api);
    assert.match(api.style, /fillColor=#f8cecc/);
    assert.match(api.style, /rounded=1/);
  });

  it("deletes the client and its edge", () => {
    const xml = previewDemo("Delete the client", SEEDED_XML).xml;
    const summary = summarizeDiagram(xml);
    assert.deepEqual(labels(xml), ["API", "Postgres"]);
    assert.equal(summary.edges.some((edge) => edge.from === "Client" || edge.to === "Client"), false);
    assert.match(xml, /id="0"/);
    assert.match(xml, /id="1"/);
  });

  it("connects the client to Postgres", () => {
    const xml = previewDemo("Connect the client to Postgres", SEEDED_XML).xml;
    assert.ok(summarizeDiagram(xml).edges.some((edge) => edge.from === "Client" && edge.to === "Postgres"));
  });

  it("reflows vertically onto one column", () => {
    const xml = previewDemo("Lay the diagram out vertically", SEEDED_XML).xml;
    const xs = summarizeDiagram(xml).vertices.map((vertex) => vertex.x);
    assert.equal(new Set(xs).size, 1);
  });

  it("renames the API", () => {
    const xml = previewDemo("Rename API to Gateway", SEEDED_XML).xml;
    assert.ok(labels(xml).includes("Gateway"));
    assert.equal(labels(xml).includes("API"), false);
  });

  it("leaves the diagram alone when the request is a greeting", () => {
    const { decision, xml } = previewDemo("hello", SEEDED_XML);
    assert.equal(decision.intent, "clarify");
    assert.equal(xml, SEEDED_XML);
  });
});

describe("mxfile compression", () => {
  it("inflates a raw-deflate diagram page and still accepts edits", () => {
    const model = summarizeDiagram(SEEDED_XML);
    assert.ok(model.vertices.length > 0);
    const normalized = normalizeMxfile(SEEDED_XML);
    const modelMatch = normalized.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/);
    assert.ok(modelMatch);
    const payload = encodeURIComponent(modelMatch[0]);
    const compressed = zlib.deflateRawSync(Buffer.from(payload)).toString("base64");
    const wrapped = `<mxfile host="embed.diagrams.net"><diagram id="architecture" name="Architecture">${compressed}</diagram></mxfile>`;
    const expanded = normalizeMxfile(wrapped);
    assert.match(expanded, /<mxGraphModel/);
    assert.equal(expanded.includes(compressed), false);
    assert.ok(labels(expanded).includes("Client"));
    const edited = previewDemo("Make the API box red", expanded).xml;
    const api = summarizeDiagram(edited).vertices.find((vertex) => vertex.label === "API");
    assert.match(api?.style ?? "", /fillColor=#f8cecc/);
  });

  it("rejects markup that is not a diagram", () => {
    assert.throws(() => normalizeMxfile("<not-a-diagram/>"), DiagramXmlError);
  });
});
