import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { formatMsgTime, type Item } from "../lib/timeline";
import { ACCEPT_IMAGE, MAX_ATTACHMENTS, usePendingAttachments } from "../lib/attachments";
import { ImageLightbox } from "./ImageLightbox";

export function Chat({
  conversationId,
  items,
  busy,
  inputRef,
  onSend,
  onChoice,
  onStop,
  hints,
  onHint,
  attachmentsEnabled,
}: {
  conversationId: string;
  items: Item[];
  busy: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string, attachmentIds: string[]) => void;
  onChoice: (itemId: string, answer: string) => void;
  onStop: () => void;
  hints: Array<{ label: string; text: string; prefill?: boolean; intent?: "generate_now" }>;
  onHint: (h: { label: string; text: string; prefill?: boolean; intent?: "generate_now" }) => void;
  attachmentsEnabled: boolean;
}) {
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<{ src: string; caption?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const att = usePendingAttachments(conversationId, attachmentsEnabled);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items, busy]);

  // 输入框随内容增高（CSS 中限制了最大高度，超出后滚动）
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [input, inputRef]);

  const canSend = !busy && !att.busy && !att.failed && (input.trim().length > 0 || att.readyIds.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(input.trim() || "请看这张图片", att.readyIds);
    setInput("");
    att.clear();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  // 粘贴截图：剪贴板里的图片直接加入待发送列表
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled) return;
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      void att.addFiles(files);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (attachmentsEnabled) void att.addFiles(Array.from(e.dataTransfer.files));
  };

  const full = att.items.length >= MAX_ATTACHMENTS;

  return (
    <section className="chat" aria-label="对话">
      <div className="msgs">
        {items.length === 0 && !busy && <div className="empty">描述一件你日常要做的工作，AI 顾问会一步步追问。</div>}
        {items.map((it) => (
          <ItemView key={it.id} item={it} onChoice={onChoice} busy={busy} onPreview={setPreview} />
        ))}
        {busy && items[items.length - 1]?.kind !== "msg" && (
          <div className="typing"><i /><i /><i />&nbsp;AI 顾问正在思考</div>
        )}
        <div ref={endRef} />
      </div>
      <div
        className={`composer ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          if (!attachmentsEnabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="hints">
          {hints.map((h) => (
            <button key={h.label} disabled={busy} onClick={() => (h.prefill ? setInput(h.text) : onHint(h))}>{h.label}</button>
          ))}
        </div>
        {att.items.length > 0 && (
          <div className="att-strip" aria-label="待发送的图片">
            {att.items.map((x) => (
              <div key={x.localId} className={`att att-${x.status}`}>
                <button className="att-img" onClick={() => setPreview({ src: x.previewUrl, caption: x.summary })} aria-label="放大预览">
                  <img src={x.previewUrl} alt="" />
                </button>
                <span className="att-status">
                  {x.status === "uploading" && "上传中"}
                  {x.status === "processing" && "识别中"}
                  {x.status === "ready" && "已识别"}
                  {x.status === "failed" && (x.error ?? "失败")}
                </span>
                <button className="att-remove" onClick={() => void att.remove(x.localId)} aria-label="移除图片">✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="input-card">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            placeholder={attachmentsEnabled ? "回答问题，粘贴截图，或告诉 AI 要怎么修改工作流…" : "回答问题，或告诉 AI 要怎么修改工作流…"}
            aria-label="输入消息"
            disabled={busy}
          />
          <div className="input-foot">
            {busy ? (
              <button className="send" onClick={onStop} aria-label="停止">■</button>
            ) : (
              <button className="send" onClick={submit} aria-label="发送" disabled={!canSend}>↑</button>
            )}
          </div>
        </div>
        {(attachmentsEnabled || att.busy || att.failed) && (
          <div className="composer-tools">
            {attachmentsEnabled && (
              <>
                <button className="attach-btn" disabled={busy || full} onClick={() => fileRef.current?.click()} aria-label="添加图片">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                    <path d="M9 3v12M3 9h12" />
                  </svg>
                </button>
                <input ref={fileRef} type="file" accept={ACCEPT_IMAGE} multiple hidden onChange={(e) => {
                  void att.addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }} />
              </>
            )}
            {att.busy && <span className="composer-note">图片上传中</span>}
            {att.failed && <span className="composer-note composer-note-error">有图片失败，请移除后再发送</span>}
          </div>
        )}
      </div>
      {preview && <ImageLightbox src={preview.src} caption={preview.caption} onClose={() => setPreview(null)} />}
    </section>
  );
}

function ItemView({ item, onChoice, busy, onPreview }: { item: Item; onChoice: (id: string, a: string) => void; busy: boolean; onPreview: (p: { src: string }) => void }) {
  switch (item.kind) {
    case "msg": {
      const time = item.time ? <div className={`msg-time ${item.role === "user" ? "me" : "ai"}`}>{formatMsgTime(item.time)}</div> : null;
      return item.role === "user" ? (
        <>
          <div className="msg me">
            {item.attachments?.length ? (
              <div className="msg-thumbs">
                {item.attachments.map((id) => (
                  <button key={id} className="att-img" onClick={() => onPreview({ src: `/api/attachments/${id}/file` })} aria-label="放大图片">
                    <img src={`/api/attachments/${id}/file`} alt="" />
                  </button>
                ))}
              </div>
            ) : null}
            {item.text}
          </div>
          {time}
        </>
      ) : (
        <>
          <div className="msg ai">
            <div className="who">AI 顾问</div>
            {item.text}
            {item.streaming && <span className="typing" style={{ display: "inline-flex", marginLeft: 4 }}><i /></span>}
          </div>
          {time}
        </>
      );
    }
    case "tools":
      return (
        <div className="toolrow">
          {item.tools.map((t) => (
            <span key={t.id} className={`tool ${t.status === "start" ? "run" : ""}`}>
              {t.status === "end" && !t.error && <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2}><path d="M2 6.5l2.5 2.5L10 3.5" /></svg>}
              {t.error ? "出错：" : t.status === "start" ? "处理中：" : ""}{TOOL_LABEL[t.name] ?? t.name}
            </span>
          ))}
        </div>
      );
    case "choices":
      return (
        <div className="choices">
          <div className="q">{item.question}</div>
          <div className="opts">
            {item.options.map((o) => (
              <button key={o} className="opt" disabled={!!item.answered || busy} onClick={() => onChoice(item.id, o)}
                style={item.answered === o ? { borderColor: "var(--ink)", boxShadow: "0 0 0 1px var(--ink)" } : undefined}>
                {o}
              </button>
            ))}
          </div>
          {item.allowOther && !item.answered && <div className="other">也可以直接输入其他回答</div>}
          {item.answered && <div className="other">已回答：{item.answered}</div>}
        </div>
      );
    case "proposals":
      return (
        <div className="proposals">
          {item.candidates.map((c) => (
            <div className="prop" key={c.id}>
              <h5>{c.title}</h5>
              <div className="save">{c.savedMinutesPerWeek !== undefined ? `≈ ${Math.round(c.savedMinutesPerWeek)} 分钟` : "—"}<small style={{ display: "block", fontFamily: "var(--sans)", fontWeight: 400, color: "var(--ink-3)" }}>每周节省</small></div>
              <p>{c.summary}</p>
            </div>
          ))}
        </div>
      );
    case "workflow":
      return (
        <div className="wf-card">
          <div className="ic"><svg width="18" height="18" viewBox="0 0 26 26" fill="none" stroke="#1C1B18" strokeWidth={2.4}><rect x="2" y="3" width="9" height="7" rx="2" /><rect x="15" y="16" width="9" height="7" rx="2" /><path d="M6.5 10v5.5a3 3 0 0 0 3 3H15" /></svg></div>
          <div><b>已更新工作流 · v{item.version}</b><span>{item.name}，画布已刷新</span></div>
        </div>
      );
    case "error":
      return <div className="msg err">{item.text}</div>;
  }
}

export const TOOL_LABEL: Record<string, string> = {
  set_stage: "切换阶段",
  update_profile: "记录角色",
  record_task: "记录工作",
  record_pain_point: "记录痛点",
  ask_choices: "给出选项",
  propose_workflows: "提出方案",
  emit_workflow: "生成工作流",
  ask_image: "追问图片",
};
