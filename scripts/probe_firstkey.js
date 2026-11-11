(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const NAV = window.__epicdeckNavRC;
  const L = el => ((el.innerText || String(el.className) || '').trim().replace(/\s+/g, ' ').slice(0, 16)) || ('<' + el.tagName + '>');
  const out = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const toSet = document.querySelector('[data-ed-tab="settings"]');
    if (toSet) toSet.click();
    await wait(450);
    const before = L(document.activeElement);
    const ok = NAV(10);
    out.push({ cycle: cycle + 1, before: before, firstDownOk: ok, after: L(document.activeElement) });
    const goOut = document.querySelector('[data-ed-tab="library"]');
    if (goOut) goOut.click();
    await wait(450);
  }
  return JSON.stringify(out);
})()
