import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEEDED_XML, STARTER_XML } from "../src/lib/drawio/starter";
import {
  SESSION_STORAGE_KEY,
  browserLocalStorage,
  clearStoredSession,
  readStoredSession,
  sessionForLoad,
  sessionWorthKeeping,
  writeStoredSession,
  type KeyValueStorage,
  type PersistedChatMessage,
} from "../src/lib/session-store";

function memoryStorage(initial?: Record<string, string>): KeyValueStorage & { snapshot(): Record<string, string> } {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

const before = "<mxfile>before</mxfile>";
const drawn = SEEDED_XML;

const transcript: PersistedChatMessage[] = [
  { id: "u1", role: "user", content: "Draw a login sequence", beforeXml: before, historyIndex: 0 },
  {
    id: "a1",
    role: "assistant",
    content: "Drew a login sequence.",
    intent: "add_shape",
    slots: { label: "Login", shape: "rectangle" },
    repaired: false,
  },
];

describe("session storage", () => {
  it("does not read browser storage while rendering on the server", () => {
    assert.equal(typeof window, "undefined");
    assert.equal(browserLocalStorage(), null);
    assert.deepEqual(sessionForLoad(null), { messages: [], xml: STARTER_XML });
  });

  it("saves and restores the transcript and the diagram", () => {
    const storage = memoryStorage();
    writeStoredSession(storage, { messages: transcript, xml: drawn });
    const saved = readStoredSession(storage);
    assert.equal(saved?.version, 1);
    assert.equal(saved?.xml, drawn);
    assert.deepEqual(saved?.messages, transcript);
    assert.deepEqual(sessionForLoad(storage), { messages: transcript, xml: drawn });
    assert.equal(Object.keys(storage.snapshot()).join(), SESSION_STORAGE_KEY);
  });

  it("keeps a hand-edited canvas when the chat is still empty", () => {
    const storage = memoryStorage();
    writeStoredSession(storage, { messages: [], xml: drawn });
    assert.equal(readStoredSession(storage)?.xml, drawn);
    assert.deepEqual(readStoredSession(storage)?.messages, []);
  });

  it("keeps a compressed diagram that does not expose cell markup", () => {
    const storage = memoryStorage();
    const compressed = `<mxfile host="embed.diagrams.net"><diagram id="d" name="Diagram">7Vhbc</diagram></mxfile>`;
    writeStoredSession(storage, { messages: [], xml: compressed });
    assert.equal(readStoredSession(storage)?.xml, compressed);
    assert.equal(sessionWorthKeeping(0, compressed), true);
  });

  it("drops a blank page instead of restoring an empty default", () => {
    const storage = memoryStorage();
    writeStoredSession(storage, { messages: transcript, xml: drawn });
    writeStoredSession(storage, { messages: [], xml: STARTER_XML });
    assert.equal(readStoredSession(storage), null);
    assert.deepEqual(sessionForLoad(storage), { messages: [], xml: STARTER_XML });
    assert.deepEqual(storage.snapshot(), {});
  });

  it("drops a rewritten blank page that still has no shapes", () => {
    const storage = memoryStorage();
    const echoed = STARTER_XML.replace('agent="draw.ai"', 'agent="draw.ai" etag="1"');
    writeStoredSession(storage, { messages: [], xml: echoed });
    assert.equal(readStoredSession(storage), null);
  });

  it("clears a saved session", () => {
    const storage = memoryStorage();
    writeStoredSession(storage, { messages: transcript, xml: drawn });
    clearStoredSession(storage);
    assert.equal(readStoredSession(storage), null);
    assert.deepEqual(sessionForLoad(storage), { messages: [], xml: STARTER_XML });
  });

  it("ignores corrupt, foreign, and partial records", () => {
    assert.equal(readStoredSession(memoryStorage({ [SESSION_STORAGE_KEY]: "{" })), null);
    assert.equal(readStoredSession(memoryStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ version: 2, messages: [], xml: drawn }) })), null);
    assert.equal(readStoredSession(memoryStorage({ [SESSION_STORAGE_KEY]: JSON.stringify([]) })), null);

    const mixed = memoryStorage({
      [SESSION_STORAGE_KEY]: JSON.stringify({
        version: 1,
        xml: drawn,
        messages: [
          { id: "u1", role: "user", content: "Keep me", beforeXml: "nope", historyIndex: -1 },
          { id: "", role: "user", content: "drop" },
          { role: "assistant", content: "drop" },
          { id: "bad", role: "system", content: "drop" },
          "drop",
        ],
      }),
    });
    const saved = readStoredSession(mixed);
    assert.equal(saved?.xml, drawn);
    assert.deepEqual(saved?.messages, [{ id: "u1", role: "user", content: "Keep me" }]);
  });

  it("keeps the chat when the saved diagram is not mxfile XML", () => {
    const storage = memoryStorage({
      [SESSION_STORAGE_KEY]: JSON.stringify({
        version: 1,
        xml: "not a diagram",
        messages: [{ id: "u1", role: "user", content: "Still here" }],
      }),
    });
    assert.deepEqual(sessionForLoad(storage), {
      messages: [{ id: "u1", role: "user", content: "Still here" }],
      xml: STARTER_XML,
    });
  });

  it("swallows storage failures", () => {
    const denyRead: KeyValueStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {},
      removeItem() {},
    };
    assert.equal(readStoredSession(denyRead), null);

    const full: KeyValueStorage = {
      getItem: () => null,
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    assert.doesNotThrow(() => writeStoredSession(full, { messages: transcript, xml: drawn }));
    assert.doesNotThrow(() => writeStoredSession(full, { messages: [], xml: STARTER_XML }));
    assert.doesNotThrow(() => clearStoredSession(full));
  });
});
