// A function over what the world showed after each write — never the agent's claim.
// Fails the step if any request behind it came back 5xx.
export default (v) => {
  const bad = v.network.find((n) => (n.status ?? 500) >= 500);
  return bad
    ? { ok: false, message: `the POST behind this step returned ${bad.status ?? "no response"}` }
    : { ok: true };
};
