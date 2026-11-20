/** Natural pixel size of a PNG / JPEG / WebP from its header. Undefined when unknown. Browser-safe (no Buffer). */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  const b = bytes;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const latin = (a: number, z: number) => String.fromCharCode(...b.subarray(a, z));
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (b.length >= 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = v.getUint16(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) };
      }
      i += 2 + len;
    }
    return undefined;
  }
  if (b.length >= 30 && latin(0, 4) === "RIFF" && latin(8, 12) === "WEBP") {
    const kind = latin(12, 16);
    if (kind === "VP8X") return { w: 1 + u24le(24), h: 1 + u24le(27) };
    if (kind === "VP8 ") return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") {
      const x = v.getUint32(21, true);
      return { w: 1 + (x & 0x3fff), h: 1 + ((x >> 14) & 0x3fff) };
    }
  }
  return undefined;
}
