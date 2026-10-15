import { recorder } from "./rec.mjs";
import { idle } from "./lib.mjs";
const T = [
  ["GPT-6-Astra", "Give me three ways to price a developer tool. One short line each, no intro."],
  ["Opus 5.5", "Which one fits a solo maintainer best? Answer in two short sentences."],
  ["Gemini 3.8 Flash", "Write a one-line pricing page headline for that option."],
];
export default async ({ page, args }) => {
  const r = await recorder(page, args[0]);
  await page.getByText("New Chat", { exact: true }).first().click();
  await page.mouse.move(900, 300);
  await page.waitForTimeout(1200);
  await r.start();
  await page.waitForTimeout(600);
  for (const [i, [model, text]] of T.entries()) {
    if (i > 0) {
      await r.clickLocator(page.locator('[data-slot="model-selector-trigger"]:visible').last());
      r.mark(`picker${i}`);
      await page.waitForTimeout(700);
      const opt = page.getByRole("option", { name: new RegExp("^" + model) }).first();
      await opt.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await r.clickLocator(opt, 0.3, 0.5);
      r.mark(`picked${i}`);
      await page.waitForTimeout(400);
    }
    await r.clickLocator(page.locator("[aria-label=Message]:visible").last(), 0.3, 0.5);
    r.mark(`type${i}`);
    await page.keyboard.type(text, { delay: 18 });
    await page.waitForTimeout(250);
    await r.clickLocator(page.locator('[aria-label="Send message"]:visible').last());
    r.mark(`send${i}`);
    await idle(page);
    r.mark(`done${i}`);
    await page.waitForTimeout(600);
  }
  await r.clickLocator(page.getByText("Settings", { exact: true }).first());
  r.mark("settings");
  await page.waitForTimeout(600);
  await r.clickLocator(page.getByRole("link", { name: "Models", exact: true }));
  r.mark("models");
  await page.waitForTimeout(6000);
  const rings = await page.locator('[aria-label="Plan usage"]').all();
  r.mark("quota");
  for (const g of rings) {
    const first = g.locator("> *").first();
    await r.clickLocator(first).catch(() => {});
    await page.waitForTimeout(1300);
    r.mark("hover");
  }
  await page.waitForTimeout(800);
  await r.stop();
};
