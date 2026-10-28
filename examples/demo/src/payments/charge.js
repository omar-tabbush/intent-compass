export function charge(order, card) {
  return { orderId: order.id, amountCents: order.totalCents, method: card.id };
}
