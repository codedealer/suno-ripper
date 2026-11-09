(() => {
  const rows = [...document.querySelectorAll('.clip-row')];
  const labels = rows.map((r) => r.getAttribute('aria-label'));
  const uniq = [...new Set(labels)];
  const r0 = rows[0];
  const cs = getComputedStyle(r0);
  const bg = cs.backgroundImage.slice(0, 160);
  // any data attributes?
  const attrs = {};
  for (const a of r0.attributes) attrs[a.name] = a.value.slice(0, 80);
  // check the playbar song link
  const pb = document.querySelector('a[href*="/song/"]');
  return JSON.stringify({
    count: rows.length,
    uniqLabels: uniq,
    row0Attrs: attrs,
    row0Bg: bg,
    playbarSong: pb ? pb.href : null,
  });
})()