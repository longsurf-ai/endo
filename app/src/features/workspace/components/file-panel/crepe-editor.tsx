// Purpose: Adapt Crepe's document lifecycle to synchronous file drafts without rewriting files on open.
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Crepe } from "@milkdown/crepe";
import {
  editorViewCtx,
  editorViewOptionsCtx,
  remarkCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";
import { $prose, replaceAll } from "@milkdown/kit/utils";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./markdown-editor.css";

// Embedded uploads remain usable after saving and reopening the Markdown file.
const uploadImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => {
      toast.error("Couldn’t insert image", {
        description: reader.error?.message,
      });
      reject(reader.error);
    };
    reader.readAsDataURL(file);
  });

type Props = {
  value: string;
  onChange: (value: string) => void;
  onUnavailable: (reason: string | Error) => void;
};

/** Mount the official editor UI while keeping the file panel authoritative over text. */
export default function CrepeEditor(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const sync = useRef<(value: string) => void>();

  useEffect(() => {
    const host = document.createElement("div");
    root.current!.append(host);
    let active = true;
    let updating = true;
    let lastValue = latest.current.value;
    let originalText = lastValue;
    const crepe = new Crepe({
      root: host,
      defaultValue: lastValue,
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: { onUpload: uploadImage },
      },
    });
    crepe.setReadonly(true);
    crepe.editor.config((ctx) => {
      ctx.update(editorViewOptionsCtx, (options) => ({
        ...options,
        attributes: {
          role: "textbox",
          "aria-label": "Markdown editor",
          "aria-multiline": "true",
        },
      }));
    });
    let originalDoc: Node;
    crepe.editor.use(
      $prose(
        (ctx) =>
          new Plugin({
            view: () => ({
              update(view, previous) {
                if (!active || updating || view.state.doc.eq(previous.doc))
                  return;
                // Undoing every edit restores the original bytes, including whitespace.
                lastValue = view.state.doc.eq(originalDoc)
                  ? originalText
                  : ctx.get(serializerCtx)(view.state.doc);
                latest.current.onChange(lastValue);
              },
            }),
          }),
      ),
    );
    const ready = crepe
      .create()
      .then(() => {
        if (!active) return;
        const accept = (text: string) =>
          crepe.editor.action((ctx) => {
            const remark = ctx.get(remarkCtx);
            const canonical = (value: string) =>
              remark.stringify(remark.parse(value));
            if (
              /^(?:\uFEFF)?(?:---|\+\+\+)\r?\n/.test(text) ||
              canonical(text) !== canonical(crepe.getMarkdown())
            ) {
              crepe.setReadonly(true);
              latest.current.onUnavailable(
                "This document contains formatting that needs source editing.",
              );
              return;
            }
            originalText = text;
            originalDoc = ctx.get(editorViewCtx).state.doc;
            crepe.setReadonly(false);
          });
        sync.current = (text) => {
          if (text === lastValue) return;
          updating = true;
          lastValue = text;
          crepe.editor.action(replaceAll(text, true));
          accept(text);
          updating = false;
        };
        accept(lastValue);
        updating = false;
        sync.current(latest.current.value);
      })
      .catch((error: unknown) => {
        if (active)
          latest.current.onUnavailable(
            error instanceof Error ? error : new Error(String(error)),
          );
      });
    return () => {
      active = false;
      sync.current = undefined;
      host.remove();
      void ready
        .then(() => crepe.destroy())
        .catch((error: unknown) => {
          toast.error("Couldn’t close Markdown editor", {
            description: error instanceof Error ? error.message : String(error),
          });
        });
    };
  }, []);

  useEffect(() => sync.current?.(props.value), [props.value]);
  return (
    <div ref={root} className="workspace-markdown size-full overflow-auto" />
  );
}
