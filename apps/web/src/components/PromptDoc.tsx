import type { ReactNode } from "react";

/**
 * 把对话提示词（固定的一小套 Markdown：标题、列表、编号步骤、加粗）排成容易阅读的文档。
 * 只用 React 元素输出，不插入 HTML；复制和下载仍然用原文。
 */

const TAG = /(〔需要用户操作〕|〔需要确认〕)/;

/** 行内：**加粗**、`代码`、步骤标记 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let key = 0;
  const plain = (s: string) => {
    for (const part of s.split(TAG)) {
      if (!part) continue;
      out.push(TAG.test(part) ? <span key={key++} className="pd-tag">{part.slice(1, -1)}</span> : part);
    }
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    plain(text.slice(last, m.index));
    out.push(m[1] ? <strong key={key++}>{m[1]}</strong> : <code key={key++}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}

type Block =
  | { kind: "h1" | "h2" | "p"; text: string }
  | { kind: "step"; num: string; depth: number; text: string }
  | { kind: "item"; depth: number; text: string };

export function parsePromptDoc(md: string): Block[] {
  const blocks: Block[] = [];
  for (const line of md.split("\n")) {
    if (!line.trim()) continue;
    let m: RegExpExecArray | null;
    if ((m = /^# (.*)$/.exec(line))) blocks.push({ kind: "h1", text: m[1]! });
    else if ((m = /^## (.*)$/.exec(line))) blocks.push({ kind: "h2", text: m[1]! });
    else if ((m = /^(\s*)(\d+(?:\.\d+)*)\. (.*)$/.exec(line))) blocks.push({ kind: "step", num: m[2]!, depth: Math.floor(m[1]!.length / 3), text: m[3]! });
    else if ((m = /^(\s*)- (.*)$/.exec(line))) blocks.push({ kind: "item", depth: Math.floor(m[1]!.length / 2), text: m[2]! });
    else blocks.push({ kind: "p", text: line.trim() });
  }
  return blocks;
}

export function PromptDoc({ text }: { text: string }) {
  return (
    <div className="pd">
      {parsePromptDoc(text).map((b, i) => {
        switch (b.kind) {
          case "h1":
            return <h3 key={i} className="pd-h1">{inline(b.text)}</h3>;
          case "h2":
            return <h4 key={i} className="pd-h2">{inline(b.text)}</h4>;
          case "step":
            return (
              <div key={i} className="pd-step" style={{ marginLeft: b.depth * 18 }}>
                <span className="pd-num">{b.num}</span>
                <div>{inline(b.text)}</div>
              </div>
            );
          case "item":
            return <div key={i} className="pd-item" style={{ marginLeft: 6 + b.depth * 18 }}>{inline(b.text)}</div>;
          default:
            return <p key={i} className="pd-p">{inline(b.text)}</p>;
        }
      })}
    </div>
  );
}
