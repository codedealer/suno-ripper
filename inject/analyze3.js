(() => {
  const S = window.__srx;
  const total = S.chunks.reduce((s, c) => s + c.byteLength, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of S.chunks) { all.set(c, off); off += c.byteLength; }

  const FTYP = [102, 116, 121, 112]; // 'ftyp'
  const hits = [];
  for (let i = 0; i + 4 <= all.length; i++) {
    if (all[i] === 102 && all[i + 1] === 116 && all[i + 2] === 121 && all[i + 3] === 112) {
      // size prefix (4 bytes before)
      let size = -1;
      if (i >= 4) size = (all[i - 4] << 24) >>> 0 >> 8 * 0; // placeholder
      if (i >= 4) size = (all[i - 4] * 16777216) + (all[i - 3] * 65536) + (all[i - 2] * 256) + all[i - 1];
      hits.push({ at: i, sizePrefix: i >= 4 ? size : null });
    }
  }
  const split = hits.length > 1 ? hits[1].at - 4 : null; // start of second ftyp box
  return JSON.stringify({ total, hits: hits.slice(0, 12), split, t1Bytes: split === null ? null : split });
})()