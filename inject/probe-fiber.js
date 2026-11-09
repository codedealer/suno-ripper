(() => {
  const rows = [...document.querySelectorAll('.clip-row')].slice(0, 6);
  const out = rows.map((r) => {
    const key = Object.keys(r).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
    let info = { key: key || null };
    if (key && key.startsWith('__reactProps$')) {
      const p = r[key];
      info.propKeys = Object.keys(p || {});
      const s = JSON.stringify(p, (k, v) => (typeof v === 'function' ? '<fn>' : v)).slice(0, 500);
      info.props = s;
    } else if (key && key.startsWith('__reactFiber$')) {
      let f = r[key];
      const chain = [];
      for (let i = 0; i < 6 && f; i++) {
        const pp = f.memoizedProps;
        if (pp) chain.push(Object.keys(pp).slice(0, 10).join(','));
        f = f.return;
      }
      info.fiberChain = chain;
      // try to find clip id anywhere in props
      const pp = r[key].memoizedProps;
      info.selfPropKeys = pp ? Object.keys(pp) : null;
      info.props = pp ? JSON.stringify(pp, (k, v) => (typeof v === 'function' ? '<fn>' : v)).slice(0, 600) : null;
    }
    return info;
  });
  return JSON.stringify(out, null, 0);
})()