/**
 * A small reader for FlatBuffers data without its schema (Notability's .ntb noteBundle): tables
 * by field slot, every read bounds-checked (null when outside the buffer or the field is absent).
 * Little-endian, as FlatBuffers always is.
 */
export class FlatBuffer {
  readonly dv: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private ok(at: number, n: number) {
    return Number.isInteger(at) && at >= 0 && at + n <= this.bytes.length;
  }
  u8(at: number): number | null {
    return this.ok(at, 1) ? this.bytes[at] : null;
  }
  u16(at: number): number | null {
    return this.ok(at, 2) ? this.dv.getUint16(at, true) : null;
  }
  u32(at: number): number | null {
    return this.ok(at, 4) ? this.dv.getUint32(at, true) : null;
  }
  i32(at: number): number | null {
    return this.ok(at, 4) ? this.dv.getInt32(at, true) : null;
  }
  f32(at: number): number | null {
    return this.ok(at, 4) ? this.dv.getFloat32(at, true) : null;
  }
  u64(at: number): number | null {
    return this.ok(at, 8) ? Number(this.dv.getBigUint64(at, true)) : null;
  }
  slice(at: number, n: number): Uint8Array | null {
    return this.ok(at, n) ? this.bytes.subarray(at, at + n) : null;
  }

  /** The root table's position. */
  root(): number | null {
    return this.u32(0);
  }
  /** Where field `slot` of the table at `table` is stored (null: absent). */
  field(table: number | null, slot: number): number | null {
    if (table === null) return null;
    const back = this.i32(table);
    if (back === null) return null;
    const vt = table - back;
    const len = this.u16(vt);
    if (len === null || 4 + slot * 2 + 2 > len) return null;
    const off = this.u16(vt + 4 + slot * 2);
    return off ? table + off : null;
  }
  /** The table, vector or string a field refers to. */
  ref(table: number | null, slot: number): number | null {
    const at = this.field(table, slot);
    const d = at === null ? null : this.u32(at);
    return at === null || d === null ? null : at + d;
  }
  string(table: number | null, slot: number): string | null {
    const b = this.bytesOf(table, slot);
    return b ? new TextDecoder().decode(b) : null;
  }
  /** A vector of bytes (or of anything, as its raw bytes when `size` is given per item). */
  bytesOf(table: number | null, slot: number, size = 1): Uint8Array | null {
    const v = this.ref(table, slot);
    const n = v === null ? null : this.u32(v);
    return v === null || n === null ? null : this.slice(v + 4, n * size);
  }
  /** A vector of tables. */
  tables(table: number | null, slot: number): number[] {
    const v = this.ref(table, slot);
    const n = v === null ? null : this.u32(v);
    if (v === null || n === null || !this.ok(v + 4, n * 4)) return [];
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(v + 4 + i * 4 + this.u32(v + 4 + i * 4)!);
    return out;
  }
  /** A vector of (float32, float32) structs. */
  points(table: number | null, slot: number): [number, number][] {
    const b = this.bytesOf(table, slot, 8);
    if (!b) return [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return Array.from({ length: b.length / 8 }, (_, i) => [dv.getFloat32(i * 8, true), dv.getFloat32(i * 8 + 4, true)]);
  }
  u8At(table: number | null, slot: number): number | null {
    const at = this.field(table, slot);
    return at === null ? null : this.u8(at);
  }
  u32At(table: number | null, slot: number, plus = 0): number | null {
    const at = this.field(table, slot);
    return at === null ? null : this.u32(at + plus);
  }
  f32At(table: number | null, slot: number, plus = 0): number | null {
    const at = this.field(table, slot);
    const v = at === null ? null : this.f32(at + plus);
    return v !== null && Number.isFinite(v) ? v : null;
  }
  /** A struct of two float32 stored in the table. */
  pair(table: number | null, slot: number): [number, number] | null {
    const a = this.f32At(table, slot), b = this.f32At(table, slot, 4);
    return a === null || b === null ? null : [a, b];
  }
  /** Four bytes stored in the table (a colour, RGBA). */
  rgba(table: number | null, slot: number): [number, number, number, number] | null {
    const at = this.field(table, slot);
    const b = at === null ? null : this.slice(at, 4);
    return b ? [b[0], b[1], b[2], b[3]] : null;
  }
  /** The size of each field of a table (to tell what it holds without the schema): slot -> bytes. */
  layout(table: number | null): Map<number, number> {
    const out = new Map<number, number>();
    if (table === null) return out;
    const back = this.i32(table);
    if (back === null) return out;
    const vt = table - back;
    const len = this.u16(vt), size = this.u16(vt + 2);
    if (len === null || size === null) return out;
    const offs: [number, number][] = [];
    for (let s = 0; 4 + s * 2 < len; s++) {
      const o = this.u16(vt + 4 + s * 2);
      if (o) offs.push([s, o]);
    }
    offs.sort((a, b) => a[1] - b[1]);
    offs.forEach(([s, o], i) => out.set(s, (i + 1 < offs.length ? offs[i + 1][1] : size) - o));
    return out;
  }
}

/** A half-precision float. */
export function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f, f = bits & 0x3ff;
  if (e === 0) return sign * f * 2 ** -24;
  if (e === 31) return f ? NaN : sign * Infinity;
  return sign * (1 + f / 1024) * 2 ** (e - 15);
}
