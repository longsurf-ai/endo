// Purpose: Prevent default icon dimensions from overriding explicit consumer sizing.
/* eslint-disable tailwindcss/no-contradicting-classname -- Regression inputs intentionally contain conflicts for cn to resolve. */
import { cn } from "@openchart/app/utils/cn";

test("later semantic or standard dimensions replace default icon sizing", () => {
  expect(cn("size-icon-md", "size-icon-lg")).toBe("size-icon-lg");
  expect(cn("size-icon-md", "size-4")).toBe("size-4");
  expect(cn("size-4", "size-icon-lg")).toBe("size-icon-lg");
  expect(cn("size-icon-md", "md:size-icon-lg")).toBe(
    "size-icon-md md:size-icon-lg",
  );
});

test("icon weight and color utilities remain independent", () => {
  expect(cn("stroke-icon-regular", "text-primary", "stroke-icon-bold")).toBe(
    "text-primary stroke-icon-bold",
  );
});
