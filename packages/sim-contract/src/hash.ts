/**
 * Canonical serialization and state hashing.
 *
 * A save's `current_state_hash` is the hash of the canonical JSON of the
 * engine state: object keys sorted, no whitespace, arrays in order. Two
 * states hash equal iff their canonical JSON is byte-identical, so the
 * determinism tests ("save → reload → same hash") are meaningful.
 *
 * NaN/Infinity are hard errors: they indicate a simulation bug and must
 * never be silently laundered into a save.
 */

export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  writeCanonical(value, parts, "$");
  return parts.join("");
}

function writeCanonical(value: unknown, out: string[], path: string): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: non-finite number at ${path}`);
      }
      out.push(JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          writeCanonical(value[i], out, `${path}[${i}]`);
        }
        out.push("]");
        return;
      }
      const keys = Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort();
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (i > 0) out.push(",");
        out.push(JSON.stringify(k), ":");
        writeCanonical((value as Record<string, unknown>)[k], out, `${path}.${k}`);
      }
      out.push("}");
      return;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/**
 * cyrb53 — fast 53-bit string hash (public-domain construction), pure 32-bit
 * ops so it stays quick on multi-megabyte inputs where BigInt FNV would crawl.
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 106-bit hex digest from two independently seeded cyrb53 passes. */
export function hashString(str: string): string {
  const a = cyrb53(str, 0x9e3779b9);
  const b = cyrb53(str, 0x85ebca6b);
  return a.toString(16).padStart(14, "0") + b.toString(16).padStart(14, "0");
}

/** Hash any JSON-serializable value via its canonical form. */
export function hashValue(value: unknown): string {
  return hashString(canonicalJson(value));
}
