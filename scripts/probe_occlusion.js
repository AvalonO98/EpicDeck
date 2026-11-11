(() => {
  const NAV = window.__epicdeckNavRC;
  const header = document.querySelector('[data-ed-level="header"]');
  const scroller = [...document.querySelectorAll('*')].find(
    e => e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200);
  const hb = header ? header.getBoundingClientRect().bottom : 0;
  const cb = scroller ? scroller.getBoundingClientRect().bottom : 0;
  const L = el => ((el.innerText || String(el.className) || '').trim().replace(/\s+/g, ' ').slice(0, 18));
  const out = [];
  for (let i = 0; i < 45; i += 1) { if (!NAV(9)) break; }
  out.push({ step: 'top', at: L(document.activeElement) });
  for (let i = 0; i < 28; i += 1) {
    const ok = NAV(10);
    const a = document.activeElement;
    const r = a.getBoundingClientRect();
    const hiddenTop = r.top < hb - 0.5;
    const hiddenBottom = r.bottom > cb + 0.5;
    out.push({
      i: i + 1,
      ok: ok,
      at: L(a),
      top: Math.round(r.top),
      bot: Math.round(r.bottom),
      sc: Math.round(scroller.scrollTop),
      underHeader: hiddenTop ? Math.round(hb - r.top) : 0,
      belowView: hiddenBottom ? Math.round(r.bottom - cb) : 0,
    });
    if (!ok) break;
  }
  return JSON.stringify({ headerBottom: Math.round(hb), viewBottom: Math.round(cb), steps: out });
})()
