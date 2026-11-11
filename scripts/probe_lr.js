(() => {
  const NAV = window.__epicdeckNavRC;
  const LEFT = 11, RIGHT = 12, UP = 9, DOWN = 10;
  const L = el => ((el.innerText || String(el.className) || '').trim().replace(/\s+/g, ' ').slice(0, 16)) || ('<' + el.tagName + '>');
  for (let i = 0; i < 45; i += 1) { if (!NAV(UP)) break; }
  const out = [];
  for (let i = 0; i < 26; i += 1) {
    if (!NAV(DOWN)) break;
    const mid = document.activeElement;
    const rowName = L(mid);
    const rOk = NAV(RIGHT);
    const atRight = document.activeElement;
    const lOk = NAV(LEFT);
    const back = document.activeElement === mid;
    out.push({
      row: rowName,
      rightMoved: rOk,
      rightTo: rOk ? L(atRight) : null,
      leftMoved: lOk,
      cameBack: back,
      leftTo: back ? null : L(document.activeElement),
    });
  }
  return JSON.stringify(out);
})()
