(() => {
  const links = [...document.querySelectorAll('a[href*="/song/"]')];
  const seen = new Set();
  const rows = [];
  links.forEach((a) => {
    let cur = a;
    let rowEl = null;
    for (let i = 0; i < 14 && cur; i++) {
      if (cur.className && typeof cur.className === 'string' && cur.className.includes('h-auto')) { rowEl = cur; break; }
      cur = cur.parentElement;
    }
    if (!rowEl || seen.has(rowEl)) return;
    seen.add(rowEl);
    const idm = a.href.match(/song\/([0-9a-f-]{36})/i);
    const btns = [...rowEl.querySelectorAll('[role=button],[aria-label]')]
      .map((b) => b.getAttribute('aria-label') || b.tagName)
      .filter((x) => x && x !== 'DIV' && x !== 'BUTTON')
      .slice(0, 8);
    rows.push({ id: idm ? idm[1].slice(0, 8) : null, title: (a.textContent || '').slice(0, 30), btns });
  });
  return JSON.stringify({ count: rows.length, rows: rows.slice(0, 12) });
})()