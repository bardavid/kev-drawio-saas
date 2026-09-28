import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeComposition, resolveComposition } from "../src/lib/kev/compose";
import { REDIS_USAGE_BRIEF, researchIdea, researchTopic, wikipediaTitle } from "../src/lib/kev/research";

const PROMPT = "Draw a redis diagram usage";

describe("topic research", () => {
  it("plans Redis from the builtin brief without calling the network", () => {
    assert.equal(wikipediaTitle("Make the API box red"), null);
    assert.equal(wikipediaTitle("draw a 3 tier web app"), null);
    assert.equal(wikipediaTitle("draw a user login sequence diagram"), null);
    assert.equal(wikipediaTitle(PROMPT), "Redis");
    const composition = resolveComposition(PROMPT);
    assert.ok(composition);
    assert.equal(composition.researchQuery, "Redis");
    assert.equal(composition.context, REDIS_USAGE_BRIEF);
    const plan = describeComposition(composition);
    assert.match(plan, /Topic context/);
    assert.match(plan, /in-memory data store/);
    assert.match(plan, /Redis cache/);
    assert.match(plan, /Replicate/);
    assert.equal(resolveComposition("draw a user login sequence diagram")?.context, null);
  });

  it("keeps the builtin Redis brief when the lookup fails", async () => {
    let called = false;
    const brief = await researchTopic(PROMPT, {
      network: true,
      fetch: async () => {
        called = true;
        throw new Error("offline");
      },
    });
    assert.equal(called, true);
    assert.equal(brief?.source, "builtin");
    assert.equal(brief?.summary, REDIS_USAGE_BRIEF);
  });

  it("uses a fetched Redis summary when Wikipedia answers", async () => {
    const brief = await researchTopic(PROMPT, {
      network: true,
      fetch: async (input) => {
        assert.match(String(input), /wikipedia\.org\/api\/rest_v1\/page\/summary\/Redis$/);
        return new Response(
          JSON.stringify({
            extract: "Redis is an in-memory cache and data structure server used beside a primary database.",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    assert.equal(brief?.source, "web");
    assert.match(brief?.summary ?? "", /primary database/);
  });

  it("does not fetch for an ordinary edit", async () => {
    let called = false;
    const brief = await researchTopic("Make the API box red", {
      network: true,
      fetch: async () => {
        called = true;
        throw new Error("should not fetch");
      },
    });
    assert.equal(called, false);
    assert.equal(brief, null);
  });

  it("fetches an unfamiliar usage topic and stays empty offline", async () => {
    const offline = await researchTopic("Draw a memcached diagram usage", { network: false });
    assert.equal(offline, null);
    const live = await researchTopic("Draw a memcached diagram usage", {
      network: true,
      fetch: async (input) => {
        assert.match(String(input), /page\/summary\/Memcached$/);
        return new Response(
          JSON.stringify({
            extract: "Memcached is a distributed memory caching system used to speed up dynamic web applications.",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    assert.equal(live?.source, "web");
    assert.match(live?.summary ?? "", /memory caching/);
  });

  it("reads a search title that differs only by case", async () => {
    const notes =
      "Applications send to the storage nodes. The storage nodes replicate to the peers. The peers persist to the journal. The journal notifies the applications.";
    const brief = await researchIdea("Draw io uring", {
      network: true,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("action=opensearch")) {
          return Response.json(["Io Uring", ["Io uring"], [""], ["https://en.wikipedia.org/wiki/Io_uring"]]);
        }
        if (url.endsWith("/Io_uring")) return Response.json({ extract: notes });
        return new Response("missing", { status: 404 });
      },
    });
    assert.equal(brief?.topic, "Io Uring");
    assert.match(brief?.summary ?? "", /storage nodes/);
  });
});
