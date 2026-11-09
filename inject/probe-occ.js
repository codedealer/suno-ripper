(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const occ = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.indexOf('Over the island') !== -1) {
      let el = n.parentElement;
      const chain = [];
      let cur = el;
      for (let i = 0; i < 10 && cur; i++) {
        chain.push(cur.tagName + (typeof cur.className === 'string' && cur.className ? '.' + cur.className.split(' ')[0] : ''));
        cur = cur.parentElement;
      }
      occ.push({ text: n.nodeValue.slice(0, 40), chain: chain.join(' > ') });
    }
  }
  const clipRows = [...document.querySelectorAll('.clip-row')];
  const rowInfo = clipRows.slice(0, 5).map((r) => ({
    cls: r.className.split(' ').slice(0, 3).join('.'),
    aria: r.getAttribute('aria-label'),
    children: r.children.length,
    html: r.innerHTML.slice(0, 200),
  }));
  return JSON.stringify({ occCount: occ.length, occ, clipRowCount: clipRows.length, rowInfo });
})()