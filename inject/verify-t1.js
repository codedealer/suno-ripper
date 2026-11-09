(() => {
  const S = window.__srx;
  const total = S.chunks.reduce((s, c) => s + c.byteLength, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of S.chunks) { all.set(c, off); off += c.byteLength; }

  const SPLIT = 3498084;
  const t1 = all.slice(0, SPLIT);

  // 1) verify box chain ends cleanly
  const u32 = (b, o) => b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3];
  let o = 0, boxCount = 0, moovEnd = -1, lastTyp = '';
  let moovData = null;
  while (o + 8 <= t1.length) {
    const size = u32(t1, o);
    const typ = String.fromCharCode(t1[o + 4], t1[o + 5], t1[o + 6], t1[o + 7]);
    boxCount++;
    lastTyp = typ;
    if (typ === 'moov' && !moovData) moovData = { at: o, size };
    if (size < 8) break;
    o += size;
  }
  const cleanEnd = o === t1.length;

  // 2) mvhd duration from moov
  let durSec = null;
  if (moovData) {
    let p = moovData.at + 8;
    while (p + 8 <= moovData.at + moovData.size) {
      const size = u32(t1, p);
      const typ = String.fromCharCode(t1[p + 4], t1[p + 5], t1[p + 6], t1[p + 7]);
      if (typ === 'mvhd') {
        const ver = t1[p + 8];
        const base = ver === 1 ? p + 8 + 4 + 8 + 8 : p + 8 + 4 + 4 + 4;
        const ts = u32(t1, base);
        const dur = ver === 1
          ? Number(((t1[base + 4] * 16777216 + t1[base + 5] * 65536 + t1[base + 6] * 256 + t1[base + 7]) * 4294967296 + u32(t1, base + 8)))
          : u32(t1, base + 4);
        durSec = ts ? dur / ts : null;
        break;
      }
      if (size < 8) break;
      p += size;
    }
  }

  // 3) count fragments (moof/mdat pairs)
  let moofs = 0, mdats = 0;
  o = 0;
  while (o + 8 <= t1.length) {
    const size = u32(t1, o);
    const typ = String.fromCharCode(t1[o + 4], t1[o + 5], t1[o + 6], t1[o + 7]);
    if (typ === 'moof') moofs++;
    if (typ === 'mdat') mdats++;
    if (size < 8) break;
    o += size;
  }

  return JSON.stringify({
    t1Bytes: t1.length,
    cleanEnd,
    boxCount,
    lastTyp,
    moofs,
    mdats,
    durSec,
    brand: String.fromCharCode(t1[8], t1[9], t1[10], t1[11]),
  });
})()