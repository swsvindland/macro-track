/** The subset of JSON Schema the on-device models are given. */
export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  "x-order"?: string[];
};

/**
 * Apple's model decodes against the schema itself. Gemini Nano does not, so the shape is
 * spelled out as a compact example it can copy, with field hints kept next to each key.
 */
export function describeJson(schema: JsonSchema): string {
  const hints: string[] = [];
  function sketch(node: JsonSchema, path: string): unknown {
    if (node.description && path) hints.push(`${path}: ${node.description}`);
    if (node.enum) return node.enum[0];
    switch (node.type) {
      case "object": {
        const keys = node["x-order"] ?? Object.keys(node.properties ?? {});
        return Object.fromEntries(
          keys.map((key) => [key, sketch(node.properties![key], path ? `${path}.${key}` : key)])
        );
      }
      case "array":
        return node.items ? [sketch(node.items, `${path}[]`)] : [];
      case "number":
      case "integer":
        return node.minimum ?? 0;
      case "boolean":
        return false;
      default:
        return "";
    }
  }
  const example = JSON.stringify(sketch(schema, ""));
  return [
    `Reply with only one JSON object shaped like ${example} and nothing else.`,
    ...(hints.length ? ["Fields:", ...hints.map((hint) => `- ${hint}`)] : []),
  ].join("\n");
}

/** Reads the first JSON object in a model reply, tolerating code fences and chatter. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}
