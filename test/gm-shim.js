// Tampermonkey API shim for testing in the embedded browser
window.GM_getValue = (k, d) => {
  const v = localStorage.getItem("gm." + k);
  return v === null ? d : JSON.parse(v);
};
window.GM_setValue = (k, v) => localStorage.setItem("gm." + k, JSON.stringify(v));
window.GM_xmlhttpRequest = (opts) => {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
  fetch(opts.url, { method: opts.method || "GET", signal: ctrl.signal })
    .then(async (r) => {
      clearTimeout(to);
      if (!r.ok) { opts.onerror && opts.onerror({ status: r.status }); return; }
      if (opts.method === "HEAD") { opts.onload && opts.onload({ status: r.status }); return; }
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      opts.onload && opts.onload({ status: r.status, response: btoa(s) });
    })
    .catch(() => { clearTimeout(to); opts.onerror && opts.onerror({ status: 0 }); });
};