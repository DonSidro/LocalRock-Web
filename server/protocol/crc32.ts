/** IEEE 802.3 / zlib CRC32, the checksum Roborock frames and cfgwifi packets carry. */

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** Unsigned CRC32 of data[offset, offset + length). */
export function crc32(data: Uint8Array, offset = 0, length = data.length - offset): number {
  let c = 0xffffffff;
  for (let i = offset; i < offset + length; i++) {
    c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
