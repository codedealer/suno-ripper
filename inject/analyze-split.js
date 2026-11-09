(() => {
  const S = window.__srx;
  // concatenate
  const total = S.chunks.reduce((s, c) => s + c.byteLength, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of S.chunks) { all.set(c, off); off += c.byteLength; }

  // find ftyp pattern: 00 00 00 1C 'f' 't' 'y' 'p'
  const pat = [0, 0, 0, 28, 102, 116, 99, 112];
  const hits = [];
  for (let i = 0; i + 8 <= all.length; i++) {
    let ok = true;
    for (let j = 0; j < 8; j++) if (all[i + j] !== pat[j]) { ok = false; break; }
    if (ok) hits.push(i);
  }

  const split = hits.length > 1 ? hits[1] : null;
  const t1 = split ? all.slice(0, split) : all;

  // parse top-level boxes of track 1
  const boxes = [];
  let o = 0;
  while (o + 8 <= t1.length) {
    const size = (t1[o] << 24) | (t1[o + 1] << 16) | (t1[o + 2] << 8) | t1[o + 3];
    const typ = String.fromCharCode(t1[o + 4], t1[o + 5], t1[o + 6], t1[o + 7]);
    boxes.push({ typ, size, at: o });
    if (size < 8) break;
    o += size;
    if (o >= t1.length) break;
    if (boxes.length > 60) { boxes.push({typ: '...TRUNC', size: 0, at: o}); break; }
  }

  // ftyp major brand
  const brand = String.fromCharCode(t1[8], t1[9], t1[10], t1[11]);
  const minor = String.fromCharCode(t1[12], t1[13], t1[14], t1[15]);

  return JSON.stringify({
    totalBytes: total,
    ftypHits: hits.slice(0, 10),
    split,
    t1Bytes: t1.length,
    ftypBrand: brand,
    ftypMinor: minor,
    boxCount: boxes.length,
    firstBoxes: boxes.slice(0, 8),
    lastBoxes: boxes.slice(-4),
    endsCleanly: o === t1.length,
  });
})()