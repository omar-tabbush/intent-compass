import { orderTotal } from './pricing.js';

export function createOrder(guestEmail, lines) {
  return { guestEmail, lines, totalCents: orderTotal(lines), status: 'placed' };
}
