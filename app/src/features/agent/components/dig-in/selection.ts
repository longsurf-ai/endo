// Purpose: Capture a rendered prose range without searching Markdown source by text.
import type { DigInInput } from "@openchart/app/lib/agent/client";

/** Resolve a single Part's rendered range inside the active view. @example const selected = readDigInSelection(thread); */
export function readDigInSelection(thread: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (
    !thread.contains(range.startContainer) ||
    !thread.contains(range.endContainer) ||
    thread.closest("[inert], [hidden]")
  )
    return;
  const element =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const part = element?.closest<HTMLElement>("[data-dig-in-part]");
  if (
    !part ||
    !part.contains(range.endContainer) ||
    part.dataset.digInEligible !== "true"
  )
    return;
  if (
    [
      ...part.querySelectorAll(
        "pre, code, math, svg, .katex, [data-dig-in-excluded]",
      ),
    ].some((node) => range.intersectsNode(node))
  )
    return;
  const partId = part.dataset.digInPart;
  const messageID = part.dataset.digInMessage;
  if (!partId || !messageID) return;
  const leaves = [
    ...part.querySelectorAll<HTMLElement>("[data-dig-in-start]"),
  ].filter((leaf) => range.intersectsNode(leaf));
  const first = leaves[0];
  const last = leaves.at(-1);
  if (!first || !last) return;
  const offset = (
    leaf: HTMLElement,
    node: Node,
    at: number,
    fallback: number,
  ) => {
    if (!leaf.contains(node)) return fallback;
    const prefix = document.createRange();
    prefix.selectNodeContents(leaf);
    prefix.setEnd(node, at);
    return prefix.toString().length;
  };
  const startOffset =
    Number(first.dataset.digInStart) +
    offset(first, range.startContainer, range.startOffset, 0);
  const endOffset =
    Number(last.dataset.digInStart) +
    offset(
      last,
      range.endContainer,
      range.endOffset,
      last.textContent?.length ?? 0,
    );
  const text = selection.toString();
  if (!text.trim() || endOffset <= startOffset) return;
  return {
    messageID,
    selection: {
      partId,
      text,
      startOffset,
      endOffset,
    } satisfies DigInInput["selection"],
  };
}
