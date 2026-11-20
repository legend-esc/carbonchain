import { createHash } from 'crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function varintEncode(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return out;
}

function pbLengthDelimited(field: number, data: number[] | Buffer): number[] {
  const bytes = data instanceof Buffer ? Array.from(data) : data;
  return [
    ...varintEncode(BigInt((field << 3) | 2)),
    ...varintEncode(BigInt(bytes.length)),
    ...bytes,
  ];
}

function pbVarint(field: number, value: bigint): number[] {
  return [...varintEncode(BigInt((field << 3) | 0)), ...varintEncode(value)];
}

/**
 * Computes the canonical IPFS CIDv0 of a single-file payload using the
 * dag-pb (unixfs File + raw leaf) layout that IPFS implementations such as
 * Pinata produce for `pinFileToIPFS`. Returns the base58-encoded multihash.
 */
export function computeFileCid(content: Buffer): string {
  const leafHash = createHash('sha256').update(content).digest();
  const leafCid = [0x01, 0x55, 0x12, 0x20, ...leafHash];

  const size = BigInt(content.length);
  const unixfs = [...pbVarint(1, 2n), ...pbVarint(3, size)];
  const link = [...pbLengthDelimited(1, leafCid), ...pbVarint(2, size)];
  const links = pbLengthDelimited(2, link);
  const rootPb = [...pbLengthDelimited(1, unixfs), ...links];

  const rootHash = createHash('sha256').update(Buffer.from(rootPb)).digest();
  const multihash = Buffer.from([0x12, 0x20, ...rootHash]);
  return base58Encode(multihash);
}

/** Decodes any supported IPFS CID (v0 base58 / v1 base32) to its raw multihash. */
export function cidToMultihash(cid: string): Buffer | null {
  try {
    if (cid.startsWith('Qm')) {
      return Buffer.from(base58Decode(cid));
    }
    if (cid.startsWith('b')) {
      const bytes = base32Decode(cid);
      return Buffer.from(bytes.slice(2));
    }
    return null;
  } catch {
    return null;
  }
}

/** Validates that a string is a well-formed IPFS CID backed by SHA-256. */
export function isValidIpfsCid(cid: string): boolean {
  if (typeof cid !== 'string' || cid.length === 0) return false;
  const mh = cidToMultihash(cid);
  if (!mh) return false;
  return mh.length === 34 && mh[0] === 0x12 && mh[1] === 0x20;
}

/** Returns true when two CIDs address the exact same content (multihash equal). */
export function cidsMatch(a: string, b: string): boolean {
  const ma = cidToMultihash(a);
  const mb = cidToMultihash(b);
  if (!ma || !mb) return false;
  return ma.equals(mb);
}

function base58Encode(buf: Buffer): string {
  let zeros = 0;
  for (const b of buf) {
    if (b === 0) zeros++;
    else break;
  }
  const digits: number[] = [];
  for (const b of buf) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = BASE58[0].repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58[digits[i]];
  return result;
}

function base58Decode(str: string): number[] {
  let zeros = 0;
  for (const c of str) {
    if (c === '1') zeros++;
    else break;
  }
  const bytes: number[] = [];
  for (const c of str) {
    const val = BASE58.indexOf(c);
    if (val < 0) throw new Error('invalid base58');
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  bytes.reverse();
  return [...Array(zeros).fill(0), ...bytes];
}

function base32Decode(str: string): number[] {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of str) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out;
}
