(() => {
  const S = window.__srx;
  const total = S.chunks.reduce((s, c) => s + c.byteLength, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of S.chunks) { all.set(c, off); off += c.byteLength; }

  const hex = (u, n, m) => {
    let s = '';
    for (let i = n; i < Math.min(n + m, u.length); i++) s += u[i].toString(16).padStart(2, '0') + ' ';
    return s;
  };

  // find all 'ftyp' ascii occurrences
  const ft = [102, 116, 99, 112];
  const hits = [];
  for (let i = 0; i + 4 <= all.length; i++) {
    if (all[i] === 102 && all[i + 1] === 116 && all[i + 2] === 99 && all[i + 3] === 112) hits.push(i);
  }
  // with 4-byte size prefix
  const sized = hits.filter((h) => h >= 4 && all[h - 4] === 0 && all[h - 3] === 0 && all[h - 2] === 0);

  return JSON.stringify({
    total,
    first32: hex(all, 0, 32),
    ftypAsciiHits: hits.slice(0, 20),
    sizedHits: sized.slice(0, 20),
    chunkLens: S.chunks.map((c) => c.byteLength).slice(0, 10),
  });
})()