import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewindToUserMessage, type UndoableMessage } from "../src/lib/session";

describe("message undo", () => {
  const before = "<mxfile>before</mxfile>";
  const after = "<mxfile>after</mxfile>";
  const messages: UndoableMessage[] = [
    { id: "u1", role: "user", beforeXml: before },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user", beforeXml: after },
    { id: "a2", role: "assistant" },
  ];

  it("rewinds a user message and everything after it", () => {
    const rewound = rewindToUserMessage(messages, "u2");
    assert.deepEqual(
      rewound?.messages.map((message) => message.id),
      ["u1", "a1"],
    );
    assert.equal(rewound?.xml, after);
  });

  it("rewinds the first user message to an empty transcript", () => {
    const rewound = rewindToUserMessage(messages, "u1");
    assert.deepEqual(rewound?.messages, []);
    assert.equal(rewound?.xml, before);
  });

  it("does not undo an assistant message", () => {
    assert.equal(rewindToUserMessage(messages, "a1"), null);
    assert.equal(rewindToUserMessage(messages, "missing"), null);
  });
});
