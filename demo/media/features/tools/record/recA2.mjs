import { recorder } from "./rec.mjs";
export default async ({ page, args }) => {
  const r = await recorder(page, args[0]);
  await page.getByText("Developer Tool Pricing", { exact: false }).first().click();
  await page.waitForTimeout(1500);
  await page.mouse.move(700, 600);
  await r.start();
  await page.waitForTimeout(500);
  await r.clickLocator(page.getByText("Settings", { exact: true }).first());
  r.mark("settings");
  await page.waitForTimeout(500);
  await r.clickLocator(page.getByRole("link", { name: "Models", exact: true }));
  r.mark("models");
  await page.waitForTimeout(1500);
  r.mark("quota");
  const groups = await page.locator('[aria-label="Plan usage"]').all();
  for (const [gi, g] of groups.entries()) {
    const items = await g.locator("> *").all();
    for (const it of items.slice(0, 2)) {
      const b = await it.boundingBox();
      await r.move(b.x + b.width / 2, b.y + b.height / 2, 10);
      r.mark(`hover${gi}`);
      await page.waitForTimeout(900);
    }
  }
  await r.move(900, 700);
  await page.waitForTimeout(600);
  await r.stop();
};
