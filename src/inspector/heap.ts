/**
 * What a cached value costs on the JS heap, estimated in JS, and what it looks like, previewed for a development
 * tool. Neither needs the engine: the estimate walks the value and adds up rough per-type sizes for a 64-bit engine
 * (object and array slots, string characters, Map and Set entries), counting each object once per walk. It is a
 * ranking and an order of magnitude, not a measurement.
 */

const OBJECT_BYTES = 40;
const ARRAY_BYTES = 32;
const SLOT_BYTES = 8;
const STRING_BYTES = 16;
const MAP_BYTES = 64;
const MAP_ENTRY_BYTES = 40;
const SET_ENTRY_BYTES = 24;
const FUNCTION_BYTES = 64;
/** A walk stops after this many objects and reports its estimate as partial. */
const MAX_OBJECTS = 100_000;

/** A heap estimate. */
export interface HeapEstimate {
  /** The estimated bytes. */
  bytes: number;
  /** How many objects the walk counted. */
  objects: number;
  /** Whether the walk stopped at its limit before counting everything, so `bytes` is a floor. */
  partial: boolean;
}

const WIDE = /[^\u0000-\u00ff]/;

/**
 * Adds `value` to a running estimate, counting each object at most once across the walk that owns `seen`, and
 * stopping once the estimate has counted `maxObjects`.
 */
export function estimateInto(value: unknown, estimate: HeapEstimate, seen: Set<object>, maxObjects = MAX_OBJECTS): void {
  const stack: unknown[] = [value];
  while (stack.length) {
    const next = stack.pop();
    if (typeof next === 'string') {
      estimate.bytes += STRING_BYTES + (WIDE.test(next) ? next.length * 2 : next.length);
      continue;
    }
    if (typeof next === 'function') {
      if (seen.has(next)) continue;
      seen.add(next);
      estimate.bytes += FUNCTION_BYTES;
      continue;
    }
    if (next === null || typeof next !== 'object') continue;
    if (seen.has(next)) continue;
    if (estimate.objects >= maxObjects) {
      estimate.partial = true;
      return;
    }
    seen.add(next);
    estimate.objects += 1;
    if (Array.isArray(next)) {
      estimate.bytes += ARRAY_BYTES + next.length * SLOT_BYTES;
      for (let i = 0; i < next.length; i += 1) stack.push(next[i]);
    } else if (next instanceof Map) {
      estimate.bytes += MAP_BYTES + next.size * MAP_ENTRY_BYTES;
      for (const [key, entry] of next) stack.push(key, entry);
    } else if (next instanceof Set) {
      estimate.bytes += MAP_BYTES + next.size * SET_ENTRY_BYTES;
      for (const entry of next) stack.push(entry);
    } else if (ArrayBuffer.isView(next) || next instanceof ArrayBuffer) {
      estimate.bytes += OBJECT_BYTES + next.byteLength;
    } else {
      const keys = Object.keys(next);
      estimate.bytes += OBJECT_BYTES + keys.length * SLOT_BYTES;
      for (const key of keys) stack.push((next as Record<string, unknown>)[key]);
    }
  }
}

/** A fresh estimate of `value` on its own. */
export function estimateHeap(value: unknown): HeapEstimate {
  const estimate: HeapEstimate = { bytes: 0, objects: 0, partial: false };
  estimateInto(value, estimate, new Set());
  return estimate;
}

/**
 * A value as JSON can carry it, cut down to a preview: at most `depth` levels, `items` elements or properties per
 * container and `chars` characters per string. What JSON can't carry is marked with `$type` (a Map's entries, a Set's
 * values, a class instance's name, a function, a repeated reference), and what was cut with `$more`.
 */
export function previewValue(value: unknown, options: { depth?: number; items?: number; chars?: number } = {}): unknown {
  const depth = options.depth ?? 6;
  const items = options.items ?? 50;
  const chars = options.chars ?? 300;
  const onPath = new Set<object>();

  const walk = (next: unknown, level: number): unknown => {
    if (typeof next === 'string') return next.length > chars ? `${next.slice(0, chars)}… (${next.length} chars)` : next;
    if (typeof next === 'number') return Number.isFinite(next) ? next : String(next);
    if (typeof next === 'bigint') return `${next}n`;
    if (typeof next === 'function') return { $type: 'function', name: next.name || '(anonymous)' };
    if (typeof next === 'symbol') return String(next);
    if (next === null || typeof next !== 'object') return next ?? null;
    if (onPath.has(next)) return { $type: 'ref', note: 'a reference back to a value above' };
    if (level >= depth) return { $type: Array.isArray(next) ? 'Array' : next.constructor?.name ?? 'Object', $more: 'deeper than the preview goes' };
    onPath.add(next);
    try {
      if (Array.isArray(next)) {
        const out: unknown[] = next.slice(0, items).map((entry) => walk(entry, level + 1));
        if (next.length > items) out.push({ $more: next.length - items });
        return out;
      }
      if (next instanceof Map) {
        const entries = Array.from(next).slice(0, items).map(([key, entry]) => [walk(key, level + 1), walk(entry, level + 1)]);
        return { $type: 'Map', size: next.size, entries, ...(next.size > items ? { $more: next.size - items } : {}) };
      }
      if (next instanceof Set) {
        const values = Array.from(next).slice(0, items).map((entry) => walk(entry, level + 1));
        return { $type: 'Set', size: next.size, values, ...(next.size > items ? { $more: next.size - items } : {}) };
      }
      if (next instanceof Date) return { $type: 'Date', value: next.toISOString() };
      if (ArrayBuffer.isView(next) || next instanceof ArrayBuffer) return { $type: next.constructor.name, bytes: next.byteLength };
      const keys = Object.keys(next);
      const out: Record<string, unknown> = {};
      const name = next.constructor?.name;
      if (name && name !== 'Object') out.$type = name;
      for (const key of keys.slice(0, items)) out[key] = walk((next as Record<string, unknown>)[key], level + 1);
      if (keys.length > items) out.$more = keys.length - items;
      return out;
    } finally {
      onPath.delete(next);
    }
  };
  return walk(value, 0);
}
