export function orderReadyEmail(order) {
  return { to: order.guestEmail, subject: 'Your order is ready', body: `Order total: ${order.totalCents / 100}` };
}
