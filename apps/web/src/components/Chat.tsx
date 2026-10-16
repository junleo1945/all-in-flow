import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { tr, useI18n } from "../i18n";
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
  const { t } = useI18n();
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
    onSend(input.trim() || t("chat.defaultImageMsg"), att.readyIds);
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
    <section className="chat" aria-label={t("chat.ariaLabel")}>
      <div className="msgs">
        {items.length === 0 && !busy && <div className="empty">{t("chat.empty")}</div>}
        {items.map((it) => (
          <ItemView key={it.id} item={it} onChoice={onChoice} busy={busy} onPreview={setPreview} />
        ))}
        {busy && items[items.length - 1]?.kind !== "msg" && (
          <div className="typing"><i /><i /><i />&nbsp;{t("chat.thinking")}</div>
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
          <div className="att-strip" aria-label={t("chat.pendingImages")}>
            {att.items.map((x) => (
              <div key={x.localId} className={`att att-${x.status}`}>
                <button className="att-img" onClick={() => setPreview({ src: x.previewUrl, caption: x.summary })} aria-label={t("chat.enlargePreview")}>
                  <img src={x.previewUrl} alt="" />
                </button>
                <span className="att-status">
                  {x.status === "uploading" && t("chat.uploading")}
                  {x.status === "processing" && t("chat.processing")}
                  {x.status === "ready" && t("chat.ready")}
                  {x.status === "failed" && (x.error ?? t("chat.failedShort"))}
                </span>
                <button className="att-remove" onClick={() => void att.remove(x.localId)} aria-label={t("chat.removeImage")}>✕</button>
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
            placeholder={attachmentsEnabled ? t("chat.placeholderImg") : t("chat.placeholder")}
            aria-label={t("chat.inputAria")}
            disabled={busy}
          />
          <div className="input-foot">
            {attachmentsEnabled && (
              <>
                <button className="attach-btn" disabled={busy || full} onClick={() => fileRef.current?.click()} aria-label={t("chat.addImage")}>
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
            {att.busy && <span className="composer-note">{t("chat.imagesUploading")}</span>}
            {att.failed && <span className="composer-note composer-note-error">{t("chat.imagesFailed")}</span>}
            {busy ? (
              <button className="send" onClick={onStop} aria-label={t("chat.stop")}>■</button>
            ) : (
              <button className="send" onClick={submit} aria-label={t("chat.send")} disabled={!canSend}>↑</button>
            )}
          </div>
        </div>
      </div>
      {preview && <ImageLightbox src={preview.src} caption={preview.caption} onClose={() => setPreview(null)} />}
    </section>
  );
}

function ItemView({ item, onChoice, busy, onPreview }: { item: Item; onChoice: (id: string, a: string) => void; busy: boolean; onPreview: (p: { src: string }) => void }) {
  const { t } = useI18n();
  switch (item.kind) {
    case "msg": {
      const time = item.time ? <div className={`msg-time ${item.role === "user" ? "me" : "ai"}`}>{formatMsgTime(item.time)}</div> : null;
      return item.role === "user" ? (
        <>
          <div className="msg me">
            {item.attachments?.length ? (
              <div className="msg-thumbs">
                {item.attachments.map((id) => (
                  <button key={id} className="att-img" onClick={() => onPreview({ src: `/api/attachments/${id}/file` })} aria-label={t("chat.enlargeImage")}>
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
            <div className="who">{t("chat.advisor")}</div>
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
          {item.tools.map((tl) => (
            <span key={tl.id} className={`tool ${tl.status === "start" ? "run" : ""}`}>
              {tl.status === "end" && !tl.error && <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2}><path d="M2 6.5l2.5 2.5L10 3.5" /></svg>}
              {tl.error ? t("tool.error") : tl.status === "start" ? t("tool.running") : ""}{toolLabel(tl.name)}
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
          {item.allowOther && !item.answered && <div className="other">{t("chat.otherAnswer")}</div>}
          {item.answered && <div className="other">{t("chat.answered", { answer: item.answered })}</div>}
        </div>
      );
    case "proposals":
      return (
        <div className="proposals">
          {item.candidates.map((c) => (
            <div className="prop" key={c.id}>
              <h5>{c.title}</h5>
              <div className="save">{c.savedMinutesPerWeek !== undefined ? t("chat.minutes", { n: Math.round(c.savedMinutesPerWeek) }) : "—"}<small style={{ display: "block", fontFamily: "var(--sans)", fontWeight: 400, color: "var(--ink-3)" }}>{t("chat.perWeekSaved")}</small></div>
              <p>{c.summary}</p>
            </div>
          ))}
        </div>
      );
    case "workflow":
      return (
        <div className="wf-card">
          <div className="ic"><svg width="18" height="18" viewBox="0 0 26 26" fill="none" stroke="#1C1B18" strokeWidth={2.4}><rect x="2" y="3" width="9" height="7" rx="2" /><rect x="15" y="16" width="9" height="7" rx="2" /><path d="M6.5 10v5.5a3 3 0 0 0 3 3H15" /></svg></div>
          <div><b>{t("chat.wfUpdated", { version: item.version })}</b><span>{t("chat.canvasRefreshed", { name: item.name })}</span></div>
        </div>
      );
    case "error":
      return <div className="msg err">{item.text}</div>;
  }
}

const TOOL_NAMES = ["set_stage", "update_profile", "record_task", "record_pain_point", "ask_choices", "propose_workflows", "emit_workflow", "ask_image"];

export function toolLabel(name: string): string {
  return TOOL_NAMES.includes(name) ? tr(`tool.${name}`) : name;
}
