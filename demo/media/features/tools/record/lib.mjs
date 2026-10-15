export const sz = async (page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 840, deviceScaleFactor: 2, mobile: false });
};
export const pickModel = async (page, name) => {
  await page.locator('[data-slot="model-selector-trigger"]:visible').last().click();
  await page.waitForTimeout(400);
  await page.getByRole("option", { name: new RegExp(name) }).first().click();
  await page.waitForTimeout(300);
};
export const send = async (page, text) => {
  const box = page.locator("[aria-label=Message]:visible").last();
  await box.click();
  await box.fill(text);
  await page.locator("[aria-label=\"Send message\"]:visible").last().click();
};
export const idle = async (page, timeout = 240000) => {
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "detached", timeout });
  await page.waitForTimeout(800);
};
