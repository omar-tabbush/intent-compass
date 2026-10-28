// Refunds go back to the card that paid.
export function refund(payment, amountCents) {
  return { to: payment.method, amountCents };
}
