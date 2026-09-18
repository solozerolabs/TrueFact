// A function over what the world showed after each write — never the agent's claim.
// Fails the step if any request behind it came back 5xx.
export default (v) =>
  v.network.some((n) => (n.status ?? 500) >= 500)
    ? { ok: false, message: "a request failed behind this step" }
    : { ok: true };
