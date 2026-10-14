// Purpose: Verify browser tests preserve native Fetch cancellation across the jsdom boundary.
test("Request accepts the browser controller and observes cancellation", () => {
  const controller = new window.AbortController();
  const request = new Request("http://localhost:3000", {
    signal: controller.signal,
  });

  expect(request.signal.aborted).toBe(false);
  controller.abort();
  expect(request.signal.aborted).toBe(true);
});
