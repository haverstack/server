// What any key that completes the DID handshake can leave behind on its own
// — a bearer token, a pending install request — lives at most this long
// unless it is renewed. Self-service state owes a bounded lifetime, and one
// bound for all of it keeps a stranger's footprint a single number.
export const SELF_SERVICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
