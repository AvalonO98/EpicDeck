(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const scroller = () => [...document.querySelectorAll('*')].find(
    e => e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 200);
  const snap = (tag) => {
    const s = scroller();
    return {
      tag: tag,
      surfaces: document.querySelectorAll('.ed-surface').length,
      tabs: document.querySelectorAll('[data-ed-tab]').length,
      activeTab: ((document.querySelector('[data-ed-tab][data-active="true"]') || {}).innerText || '').trim(),
      nodes: document.querySelectorAll('*').length,
      scrollH: s ? s.scrollHeight : -1,
      scrollTop: s ? Math.round(s.scrollTop) : -1,
      focus: ((document.activeElement && (document.activeElement.innerText || '')) || '').trim().slice(0, 10),
    };
  };
  const click = (id) => { const el = document.querySelector('[data-ed-tab="' + id + '"]'); if (el) el.click(); return !!el; };
  const out = [snap('start')];
  for (let i = 0; i < 3; i += 1) {
    click('library');
    await wait(350);
    out.push(snap('lib' + (i + 1)));
    click('settings');
    await wait(350);
    out.push(snap('set' + (i + 1)));
  }
  return JSON.stringify(out);
})()
