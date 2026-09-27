import { SHAPE_KINDS } from "@/lib/drawio/styles";

const shapeEnum = [...SHAPE_KINDS];

const slotsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: ["string", "null"] },
    shape: { anyOf: [{ type: "string", enum: shapeEnum }, { type: "null" }] },
    fillColor: { type: ["string", "null"] },
    strokeColor: { type: ["string", "null"] },
    colorName: { type: ["string", "null"] },
    from: { type: ["string", "null"] },
    to: { type: ["string", "null"] },
    target: { type: ["string", "null"] },
    newLabel: { type: ["string", "null"] },
    edgeLabel: { type: ["string", "null"] },
    layout: { anyOf: [{ type: "string", enum: ["horizontal", "vertical"] }, { type: "null" }] },
    place: { anyOf: [{ type: "string", enum: ["before", "after"] }, { type: "null" }] },
  },
  required: [
    "label",
    "shape",
    "fillColor",
    "strokeColor",
    "colorName",
    "from",
    "to",
    "target",
    "newLabel",
    "edgeLabel",
    "layout",
    "place",
  ],
} as const;

const mutatingIntents = ["add_shape", "edit_shape", "delete_shape", "connect", "layout", "style"] as const;

export const KEV_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["add_shape", "edit_shape", "delete_shape", "connect", "layout", "style", "clarify", "noop"],
    },
    reply: { type: "string" },
    updatedXml: { type: "string" },
    slots: slotsSchema,
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          intent: { type: "string", enum: [...mutatingIntents] },
          slots: slotsSchema,
        },
        required: ["intent", "slots"],
      },
    },
  },
  required: ["intent", "reply", "updatedXml", "slots", "operations"],
} as const;
