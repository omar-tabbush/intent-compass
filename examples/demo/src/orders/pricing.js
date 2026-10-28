// Order totals. All amounts are integer cents.
export function lineTotal(unitCents, qty) {
  return unitCents * qty;
}

export function orderTotal(lines) {
  return lines.reduce((sum, l) => sum + lineTotal(l.unitCents, l.qty), 0);
}
