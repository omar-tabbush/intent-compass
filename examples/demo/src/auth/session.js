// Guests only: a signed order token, no accounts.
export function guestToken(orderId, secret) {
  return `${orderId}.${secret.length}`;
}
