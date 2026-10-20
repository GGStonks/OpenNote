/**
 * Apple property lists (binary "bplist00" and XML) and NSKeyedArchiver object graphs, as written by
 * iOS apps (Notability's Session.plist). Values: number, boolean, string, Uint8Array (data),
 * PlistDate, PlistUid, arrays and plain objects (dictionaries).
 */

export class PlistUid {
  constructor(public readonly uid: number) {}
}

export class PlistDate {
  /** Seconds since 2001-01-01 (Apple's reference date). */
  constructor(public readonly seconds: number) {}
  get ms(): number {
    return (this.seconds + 978307200) * 1000;
  }
}

export type PlistValue = number | boolean | string | Uint8Array | PlistDate | PlistUid | null | PlistValue[] | { [k: string]: PlistValue };

export function parsePlist(bytes: Uint8Array): PlistValue {
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  if (head === 'bplist00') return parseBinary(bytes);
  return parseXml(new TextDecoder().decode(bytes));
}

function parseBinary(bytes: Uint8Array): PlistValue {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = bytes.length - 32;
  const offSize = bytes[t + 6], refSize = bytes[t + 7];
  const numObjects = Number(dv.getBigUint64(t + 8));
  const top = Number(dv.getBigUint64(t + 16));
  const tableAt = Number(dv.getBigUint64(t + 24));
  const uint = (at: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[at + i];
    return v;
  };
  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) offsets.push(uint(tableAt + i * offSize, offSize));
  const cache = new Map<number, PlistValue>();
  const utf16 = new TextDecoder('utf-16be');
  const ascii = new TextDecoder('latin1');

  const read = (ref: number, depth: number): PlistValue => {
    if (depth > 512) throw new Error('Property list nested too deeply.');
    const hit = cache.get(ref);
    if (hit !== undefined) return hit;
    let at = offsets[ref];
    const marker = bytes[at];
    const kind = marker >> 4;
    let info = marker & 0xf;
    at++;
    const length = (): number => {
      if (info !== 0xf) return info;
      const m = bytes[at];
      const size = 1 << (m & 0xf);
      const n = uint(at + 1, size);
      at += 1 + size;
      return n;
    };
    let v: PlistValue;
    switch (kind) {
      case 0x0:
        v = info === 0x8 ? false : info === 0x9 ? true : null;
        break;
      case 0x1: {
        const size = 1 << info;
        if (size === 8) v = Number(dv.getBigInt64(at));
        else if (size === 16) v = Number(dv.getBigInt64(at + 8));
        else v = uint(at, size);
        break;
      }
      case 0x2:
        v = info === 2 ? dv.getFloat32(at) : dv.getFloat64(at);
        break;
      case 0x3:
        v = new PlistDate(dv.getFloat64(at));
        break;
      case 0x4: {
        const n = length();
        v = bytes.slice(at, at + n);
        break;
      }
      case 0x5: {
        const n = length();
        v = ascii.decode(bytes.subarray(at, at + n));
        break;
      }
      case 0x6: {
        const n = length();
        v = utf16.decode(bytes.subarray(at, at + n * 2));
        break;
      }
      case 0x8:
        v = new PlistUid(uint(at, info + 1));
        break;
      case 0xa:
      case 0xc: {
        const n = length();
        const arr: PlistValue[] = [];
        cache.set(ref, arr);
        for (let i = 0; i < n; i++) arr.push(read(uint(at + i * refSize, refSize), depth + 1));
        return arr;
      }
      case 0xd: {
        const n = length();
        const obj: { [k: string]: PlistValue } = {};
        cache.set(ref, obj);
        for (let i = 0; i < n; i++) {
          const k = read(uint(at + i * refSize, refSize), depth + 1);
          obj[String(k)] = read(uint(at + (n + i) * refSize, refSize), depth + 1);
        }
        return obj;
      }
      default:
        throw new Error(`Unknown property list object type 0x${marker.toString(16)}.`);
    }
    cache.set(ref, v);
    return v;
  };
  return read(top, 0);
}

function parseXml(text: string): PlistValue {
  if (typeof DOMParser === 'undefined') throw new Error('XML property lists are not supported here.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.querySelector('plist > *');
  if (!root) throw new Error('Not a property list.');
  const conv = (el: Element): PlistValue => {
    const kids = () => Array.from(el.children);
    switch (el.tagName) {
      case 'dict': {
        const o: { [k: string]: PlistValue } = {};
        const c = kids();
        for (let i = 0; i + 1 < c.length; i += 2) o[c[i].textContent ?? ''] = conv(c[i + 1]);
        // A keyed archive's UID in XML form.
        const keys = Object.keys(o);
        if (keys.length === 1 && keys[0] === 'CF$UID' && typeof o['CF$UID'] === 'number') return new PlistUid(o['CF$UID']);
        return o;
      }
      case 'array':
        return kids().map(conv);
      case 'string':
        return el.textContent ?? '';
      case 'integer':
      case 'real':
        return Number(el.textContent);
      case 'true':
        return true;
      case 'false':
        return false;
      case 'date':
        return new PlistDate(Date.parse(el.textContent ?? '') / 1000 - 978307200);
      case 'data': {
        const bin = atob((el.textContent ?? '').replace(/\s+/g, ''));
        const b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        return b;
      }
      default:
        return null;
    }
  };
  return conv(root);
}

/** An NSKeyedArchiver graph: objects are looked up through UIDs, cycles are not followed twice. */
export class KeyedArchive {
  readonly objects: PlistValue[];
  readonly top: { [k: string]: PlistValue };

  constructor(plist: PlistValue) {
    const p = plist as { [k: string]: PlistValue };
    if (!p || typeof p !== 'object' || !Array.isArray(p.$objects)) throw new Error('Not a keyed archive.');
    this.objects = p.$objects;
    this.top = (p.$top as { [k: string]: PlistValue }) ?? {};
  }

  /** The archive's root object (under "$top": "root", or "$0" in Notability notes). */
  root(): PlistValue {
    const t = this.top.root ?? this.top.$0 ?? Object.values(this.top)[0];
    return this.get(t);
  }

  /** Follows a UID (other values are returned as they are). */
  get(v: PlistValue | undefined): PlistValue {
    if (v instanceof PlistUid) return this.objects[v.uid] ?? null;
    return v ?? null;
  }

  className(v: PlistValue): string | null {
    const o = this.get(v);
    if (!o || typeof o !== 'object' || o instanceof Uint8Array || Array.isArray(o) || o instanceof PlistDate || o instanceof PlistUid) return null;
    const c = this.get(o.$class);
    return c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Uint8Array) ? (((c as { [k: string]: PlistValue }).$classname as string) ?? null) : null;
  }

  /** A field of an archived object, followed through its UID. */
  field(obj: PlistValue, key: string): PlistValue {
    const o = this.get(obj);
    if (!o || typeof o !== 'object' || Array.isArray(o) || o instanceof Uint8Array) return null;
    return this.get((o as { [k: string]: PlistValue })[key]);
  }

  /** NSString / NSMutableString (or a plain string). */
  string(v: PlistValue): string | null {
    const o = this.get(v);
    if (typeof o === 'string') return o;
    if (o && typeof o === 'object' && !Array.isArray(o) && !(o instanceof Uint8Array)) {
      const r = o as { [k: string]: PlistValue };
      if (typeof r['NS.string'] === 'string') return r['NS.string'];
      if (r['NS.bytes'] instanceof Uint8Array) return new TextDecoder().decode(r['NS.bytes']);
    }
    return null;
  }

  number(v: PlistValue): number | null {
    const o = this.get(v);
    return typeof o === 'number' ? o : null;
  }

  /** NSArray / NSSet (NS.objects, or NS.object.N in Notability notes), resolved. */
  array(v: PlistValue): PlistValue[] {
    const o = this.get(v);
    if (Array.isArray(o)) return o.map((x) => this.get(x));
    if (!o || typeof o !== 'object' || o instanceof Uint8Array) return [];
    const r = o as { [k: string]: PlistValue };
    if (Array.isArray(r['NS.objects'])) return r['NS.objects'].map((x) => this.get(x));
    const out: PlistValue[] = [];
    for (let i = 0; `NS.object.${i}` in r; i++) out.push(this.get(r[`NS.object.${i}`]));
    return out;
  }

  /** NSDictionary (NS.keys / NS.objects or NS.key.N / NS.object.N), resolved. */
  dict(v: PlistValue): Map<string, PlistValue> {
    const o = this.get(v);
    const out = new Map<string, PlistValue>();
    if (!o || typeof o !== 'object' || Array.isArray(o) || o instanceof Uint8Array) return out;
    const r = o as { [k: string]: PlistValue };
    if (Array.isArray(r['NS.keys']) && Array.isArray(r['NS.objects'])) {
      r['NS.keys'].forEach((k, i) => out.set(String(this.string(k) ?? this.get(k)), this.get((r['NS.objects'] as PlistValue[])[i])));
    } else {
      for (let i = 0; `NS.key.${i}` in r; i++) out.set(String(this.string(r[`NS.key.${i}`]) ?? ''), this.get(r[`NS.object.${i}`]));
    }
    return out;
  }

  /** Every archived object (dictionary) reachable from `from`, each once. */
  *walk(from: PlistValue): Generator<{ [k: string]: PlistValue }> {
    const seen = new Set<unknown>();
    const stack: PlistValue[] = [from];
    while (stack.length) {
      const o = this.get(stack.pop());
      if (!o || typeof o !== 'object' || o instanceof Uint8Array || o instanceof PlistDate || seen.has(o)) continue;
      seen.add(o);
      if (Array.isArray(o)) {
        stack.push(...o);
        continue;
      }
      const r = o as { [k: string]: PlistValue };
      yield r;
      for (const [k, x] of Object.entries(r)) if (k !== '$class') stack.push(x);
    }
  }
}
