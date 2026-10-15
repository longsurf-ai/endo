import { recorder } from "./rec.mjs";
import { idle, sz } from "./lib.mjs";
const phraseRect = (page, phrase) => page.evaluate((phrase) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const i = n.textContent.indexOf(phrase);
    if (i >= 0 && n.parentElement.offsetParent) {
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + phrase.length);
      return [...r.getClientRects()].map((q) => ({ x: q.x, y: q.y, w: q.width, h: q.height }));
    }
  }
  return null;
}, phrase);
export default async ({ page, args }) => {
  await sz(page);
  // Close any Dig In draft left from probing.
  const close = page.getByRole("button", { name: /close/i }).filter({ visible: true });
  if (await close.count()) await close.first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.getByText("Developer Tool Pricing", { exact: false }).first().click();
  await page.waitForTimeout(1500);
  await page.mouse.move(1000, 760);
  const r = await recorder(page, args[0]);
  await r.start();
  await page.waitForTimeout(500);
  const rect = await phraseRect(page, "A free tier brings in users");
  const a = rect[0], b = rect.at(-1);
  await r.move(a.x + 1, a.y + a.h / 2, 14);
  await page.waitForTimeout(150);
  r.mark("select-start", { x: a.x + 1, y: a.y + a.h / 2 });
  await page.mouse.down();
  await r.move(b.x + b.w - 1, b.y + b.h / 2, 16);
  await page.mouse.up();
  r.mark("selected");
  await page.waitForTimeout(700);
  await r.clickLocator(page.getByRole("button", { name: /Dig in/i }).first());
  r.mark("digin");
  await page.waitForTimeout(1200);
  const box = page.locator("[aria-label=Message]:visible").last();
  await r.clickLocator(box, 0.3, 0.5);
  await page.keyboard.type("What should the free tier include? Two short bullets.", { delay: 18 });
  await page.waitForTimeout(200);
  await r.clickLocator(page.locator('[aria-label="Send message"]:visible').last());
  r.mark("send");
  await idle(page);
  r.mark("done");
  await page.waitForTimeout(1200);
  await r.stop();
};
