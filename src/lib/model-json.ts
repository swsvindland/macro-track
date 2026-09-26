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

/**
 * Reads the first JSON object in a model reply, tolerating code fences and chatter. A reply
 * cut off at the token limit keeps the array items it finished.
 */
export function extractJson(text: string): unknown {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const value = readObject(text, start);
    if (value !== undefined) return value;
  }
  throw new Error("The model did not return JSON.");
}

/** Scans to the object's balanced end, skipping brackets inside strings. */
function readObject(text: string, start: number): unknown {
  const open: string[] = [];
  // Just after each complete array item, with the brackets still open there.
  const cuts: { end: number; open: string[] }[] = [];
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") open.push("}");
    else if (char === "[") open.push("]");
    else if (char === "}" || char === "]") {
      if (open.pop() !== char) break;
      if (!open.length) {
        const value = parse(text.slice(start, i + 1));
        if (value !== undefined) return value;
        break;
      }
      if (open.at(-1) === "]") cuts.push({ end: i + 1, open: [...open] });
    }
  }
  for (const cut of cuts.reverse()) {
    const value = parse(text.slice(start, cut.end) + cut.open.reverse().join(""));
    if (value !== undefined) return value;
  }
  return undefined;
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
