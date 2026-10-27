// ID allocation. Numbers are allocated here, never chosen by a model, so two
// agents in one checkout cannot pick the same one.

export function slugify(title) {
  const s = String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s.slice(0, 60).replace(/-+$/, '') || 'decision');
}

export function nextNumber(index, ns) {
  let max = 0;
  for (const r of index.records) {
    if (r.ns !== ns) continue;
    const n = parseInt(r.num ?? r.id.split('/').at(-1), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(4, '0');
}

export function recordRelPath(ns, num, slug) {
  const file = `${num}-${slug}.md`;
  return ns === 'root' ? `decisions/${file}` : `modules/${ns}/decisions/${file}`;
}

export function moduleRelPath(name) {
  return `modules/${name}/${name}.md`;
}

export function validModuleName(name) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) && name !== 'root' && !name.includes('..');
}
