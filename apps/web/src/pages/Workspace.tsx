import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate, useParams, Link } from "react-router-dom";
import type { WorkflowIR } from "@aif/workflow-ir";
import { api, ApiError } from "../lib/api";
import { sendMessage } from "../lib/sse";
import { applyEvent, applyProfilePatch, closeStreaming, historyToItems, type Item } from "../lib/timeline";
import { emptyProfile } from "../lib/profile";
import { displayTitle, tr, useI18n } from "../i18n";
import { stageLabels, stageLabel, type Profile, type PainPoint } from "../lib/types";
import { Topbar } from "../components/Topbar";
import { Chat } from "../components/Chat";
import { ProfilePanel } from "../components/ProfilePanel";
import { CanvasView, useScene } from "../components/CanvasView";
import { ExportMenu, type ExporterInfo } from "../components/ExportMenu";
import { ShareModal } from "../components/ShareModal";
import { Select } from "../components/ui/Select";
import { useFeedback } from "../components/ui/Feedback";
import { useMe, USAGE_EVENT } from "../lib/useMe";

interface Detail {
  id: string;
  title: string;
  stage: string;
  profile: Profile;
  workflows: Array<{ id: string; name: string; latestVersion: number }>;
}

interface Selected { workflowId: string; name: string; version: number; latestVersion: number }

interface ConvRow { id: string; title: string; stage: string; pinnedAt: string | null }

// 对话区宽度：可拖动调整，记住上次的宽度
const CHAT_W_KEY = "aif-chat-width";
const CHAT_W_DEFAULT = 476;
const CHAT_W_MIN = 360;
const RAIL_W = 232;

// 画布面板的图标：方框右侧一竖线，表示右侧面板
const PANEL_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M10 2.5v11" />
  </svg>
);
const RAIL_COLLAPSED_W = 44;
const RAIL_OPEN_KEY = "aif-rail-open";
const SPLITTER_W = 6;
// 画布面板的最小宽度：要放下「画布 / 工作画像」切换、版本、分享、导出这一行
const PANEL_W_MIN = 400;

// 历史访谈栏是否展开，记住上次的状态
function readRailOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function readChatWidth(): number {
  try {
    const v = Number(localStorage.getItem(CHAT_W_KEY));
    return Number.isFinite(v) && v > 0 ? v : CHAT_W_DEFAULT;
  } catch {
    return CHAT_W_DEFAULT;
  }
}

function clampChatWidth(w: number): number {
  const max = Math.max(CHAT_W_MIN, window.innerWidth - RAIL_W - SPLITTER_W - PANEL_W_MIN);
  return Math.min(max, Math.max(CHAT_W_MIN, Math.round(w)));
}

function makeHints(): Array<{ label: string; text: string; prefill?: boolean; intent?: "generate_now" }> {
  return [
    { label: tr("ws.hintGenerate"), text: tr("ws.hintGenerateText"), intent: "generate_now" },
    { label: tr("ws.hintSwitch"), text: tr("ws.hintSwitchText") },
    { label: tr("ws.hintWrong"), text: tr("ws.hintWrongText"), prefill: true },
  ];
}

/** 顶栏的访谈阶段：平时只显示当前阶段和分段进度，悬停或聚焦时展开全部阶段 */
function StageProgress({ index }: { index: number }) {
  const { t } = useI18n();
  const stages = stageLabels();
  const cur = Math.max(0, index);
  const total = stages.length;
  const state = (i: number) => (i < cur ? "done" : i === cur ? "cur" : "todo");
  return (
    <div className="stage" tabIndex={0} aria-label={t("stage.ariaLabel", { cur: cur + 1, total, name: stages[cur].label })}>
      <span className="stage-num">{cur + 1}<span>/{total}</span></span>
      <span className="stage-name">{stages[cur].label}</span>
      <span className="stage-track" aria-hidden="true">
        {stages.map((s, i) => <i key={s.key} className={state(i)} />)}
      </span>
      <ol className="stage-pop">
        {stages.map((s, i) => (
          <li key={s.key} className={state(i)}>
            <span className="n">{i < cur ? "✓" : i + 1}</span>
            {s.label}
            {i === cur && <em>{t("stage.inProgress")}</em>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function WorkspacePage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const initial = (location.state as { initial?: string } | null)?.initial;
  const { me } = useMe();
  const feedback = useFeedback();
  const { t } = useI18n();
  const hints = makeHints();

  const [loadError, setLoadError] = useState("");
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState("role");
  const [profile, setProfile] = useState<Profile>(emptyProfile());
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [workflows, setWorkflows] = useState<Detail["workflows"]>([]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [ir, setIr] = useState<WorkflowIR | null>(null);
  const [tab, setTab] = useState<"canvas" | "profile">("canvas");
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [exporters, setExporters] = useState<ExporterInfo[]>([]);
  const [convList, setConvList] = useState<ConvRow[]>([]);
  const [versions, setVersions] = useState<number[]>([]);
  const [railOpen, setRailOpen] = useState<boolean>(readRailOpen);
  // 窄屏下历史访谈以抽屉形式从顶栏打开，和桌面端的折叠状态互不影响
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const railExpanded = railOpen || mobileRailOpen;
  // 右侧画布面板：还没有工作流时隐藏，有工作流后可手动收起 / 展开
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const renameCancelled = useRef(false);

  // 切换访谈后收起窄屏抽屉
  useEffect(() => {
    setMobileRailOpen(false);
  }, [id]);

  // 点击菜单以外的地方时关闭左栏的操作菜单
  useEffect(() => {
    if (!menuId) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".conv-menu-wrap")) setMenuId(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuId]);

  const idRef = useRef(0);
  const nextId = useCallback(() => `i${++idRef.current}`, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 从首页带过来的第一条消息，在历史加载完成后发送一次（见加载 effect）
  const pendingInitial = useRef(initial);
  const abortRef = useRef<AbortController | null>(null);

  const scene = useScene(ir);

  // 初始宽度也要按当前窗口夹紧：之前存下的宽度可能是在更宽的窗口里拖出来的
  const [chatW, setChatW] = useState<number>(() => clampChatWidth(readChatWidth()));
  // 窗口变窄时，把对话区宽度重新夹紧，避免画布面板被挤出可视区域
  useEffect(() => {
    const onResize = () => setChatW((w) => clampChatWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const saveChatW = (w: number) => {
    try {
      localStorage.setItem(CHAT_W_KEY, String(w));
    } catch {
      /* 无法保存时只影响记忆功能 */
    }
  };
  const onSplitDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: chatW };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const onSplitMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setChatW(clampChatWidth(d.startW + e.clientX - d.startX));
  };
  const onSplitUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    setChatW((w) => {
      saveChatW(w);
      return w;
    });
  };
  const onSplitKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampChatWidth(chatW + (e.key === "ArrowRight" ? 16 : -16));
    setChatW(next);
    saveChatW(next);
  };
  const resetChatW = () => {
    setChatW(CHAT_W_DEFAULT);
    saveChatW(CHAT_W_DEFAULT);
  };

  // 点击导出菜单以外的地方时关闭菜单（菜单会盖住顶部的其他按钮）
  const exportWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      // 下拉选项和导出预览弹窗挂在 body 上，点击它们不应被当成点击了菜单以外的地方
      const t = e.target as Element;
      if (!exportWrapRef.current?.contains(t) && !t.closest?.(".ui-select-menu, .export-preview-back")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const loadDetail = useCallback(async () => {
    const d = await api.get<Detail>(`/conversations/${id}`);
    setTitle(d.title);
    setStage(d.stage);
    setProfile(d.profile ?? emptyProfile());
    setWorkflows(d.workflows);
    return d;
  }, [id]);

  // 首次加载：详情、历史消息、会话列表、导出插件
  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    (async () => {
      try {
        const d = await loadDetail();
        const history = await api.get<Array<{ role: "user" | "assistant"; text: string; createdAt: string }>>(`/conversations/${id}/messages`);
        if (cancelled) return;
        setItems(historyToItems(history, nextId));
        if (d.workflows.length) {
          const w = d.workflows[0]!;
          setSelected({ workflowId: w.id, name: w.name, version: w.latestVersion, latestVersion: w.latestVersion });
        }
        // 首页带过来的第一条消息：历史加载完成后再发送，避免历史结果覆盖刚加入的用户消息；只发一次
        const first = pendingInitial.current;
        if (first) {
          pendingInitial.current = undefined;
          nav(`/c/${id}`, { replace: true, state: null });
          void sendRef.current(first);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : t("ws.loadFailed"));
      }
    })();
    api.get<ExporterInfo[]>("/exporters").then(setExporters).catch(() => {});
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [id, loadDetail, nextId]);

  // 选中的工作流版本变化时加载 IR
  useEffect(() => {
    if (!selected) {
      setIr(null);
      setVersions([]);
      return;
    }
    api.get<{ versions: Array<{ version: number }> }>(`/workflows/${selected.workflowId}/versions`)
      .then((r) => setVersions(r.versions.map((v) => v.version).sort((a, b) => a - b)))
      .catch(() => {});
    api.get<{ ir: WorkflowIR }>(`/workflows/${selected.workflowId}/versions/${selected.version}`)
      .then((r) => setIr(r.ir))
      .catch(() => {});
  }, [selected?.workflowId, selected?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadConvs = useCallback(() => {
    api.get<ConvRow[]>("/conversations").then(setConvList).catch(() => {});
  }, []);

  // 切换会话或发送完一轮后刷新左侧列表（标题、置顶顺序都可能变化）
  useEffect(() => {
    loadConvs();
  }, [id, loadConvs]);

  const refreshWorkflows = useCallback(() => {
    void loadDetail().catch(() => {});
    loadConvs();
  }, [loadDetail, loadConvs]);

  const toggleRail = () => {
    const next = !railOpen;
    setRailOpen(next);
    try {
      localStorage.setItem(RAIL_OPEN_KEY, next ? "1" : "0");
    } catch {
      /* 无法保存时只影响记忆功能 */
    }
  };

  const togglePin = async (c: ConvRow) => {
    try {
      await api.patch(`/conversations/${c.id}`, { pinned: !c.pinnedAt });
    } catch {
      /* 失败时列表会按服务端状态重新加载 */
    }
    loadConvs();
  };

  const startRename = (c: ConvRow) => {
    setMenuId(null);
    renameCancelled.current = false;
    setEditing({ id: c.id, title: c.title });
  };

  // 失去焦点或按回车时保存；按 Esc 取消。标题没变或为空时不请求服务端
  const commitRename = async () => {
    const cur = editing;
    setEditing(null);
    if (!cur) return;
    if (renameCancelled.current) {
      renameCancelled.current = false;
      return;
    }
    const c = convList.find((x) => x.id === cur.id);
    const title = cur.title.trim();
    if (!c || !title || title === c.title) return;
    try {
      await api.patch(`/conversations/${c.id}`, { title });
    } catch {
      feedback.toast(t("ws.renameFailed"), "err");
    }
    loadConvs();
  };

  const removeConv = async (c: ConvRow) => {
    const ok = await feedback.confirm({
      title: t("ws.deleteTitle"),
      message: t("ws.deleteConfirm", { title: displayTitle(c.title) }),
      confirmText: t("ws.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/conversations/${c.id}`);
    } catch {
      feedback.toast(t("ws.deleteFailed"), "err");
      return;
    }
    if (c.id === id) nav("/");
    else loadConvs();
  };

  const send = useCallback(
    async (text: string, attachmentIds: string[] = [], intent?: "generate_now") => {
      if (!text.trim() || busy) return;
      setBusy(true);
      setItems((prev) => [...closeStreaming(prev), { kind: "msg", id: nextId(), role: "user", text, time: new Date().toISOString(), ...(attachmentIds.length ? { attachments: attachmentIds } : {}) }]);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await sendMessage(
          id,
          text,
          (e) => {
            if (e.event === "state_patch") setProfile((p) => applyProfilePatch(p, data));
            const data = e.data as any;
            if (e.event === "usage") window.dispatchEvent(new CustomEvent(USAGE_EVENT, { detail: data }));
            if (e.event === "stage") setStage(data.stage);
            if (e.event === "workflow") {
              const d = data;
              setSelected({ workflowId: d.workflowId, name: d.ir?.name ?? tr("timeline.workflowDefault"), version: d.version, latestVersion: d.version });
              setIr(d.ir);
            }
            setItems((prev) => applyEvent(prev, e, nextId));
          },
          controller.signal,
          attachmentIds,
          intent,
        );
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setItems((prev) => [...closeStreaming(prev), { kind: "error", id: nextId(), text: e instanceof ApiError ? e.message : tr("ws.sendFailed") }]);
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setItems((prev) => closeStreaming(prev));
        refreshWorkflows();
      }
    },
    [busy, id, nextId, refreshWorkflows],
  );

  // 发送函数的最新引用：加载流程要发送首条消息，但不能依赖 send（它会随 busy 变化，变化时加载 effect 会重跑并中止请求）
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const answerChoice = (itemId: string, answer: string) => {
    setItems((prev) => prev.map((it) => (it.id === itemId && it.kind === "choices" ? { ...it, answered: answer } : it)));
    void send(answer);
  };

  const patchPain = async (pid: string, patch: Partial<Pick<PainPoint, "severity" | "automatable">>) => {
    try {
      const updated = await api.patch<Profile>(`/conversations/${id}/profile`, { painPoints: [{ id: pid, ...patch }] });
      setProfile(updated);
    } catch {
      /* 失败时保持原值 */
    }
  };

  const newConversation = async () => {
    const c = await api.post<{ id: string }>("/conversations");
    nav(`/c/${c.id}`);
  };

  // 左栏的一条历史访谈：点击打开；悬停时右侧出现「⋮」，点击展开操作菜单
  const renderConvItem = (c: ConvRow) => {
    if (editing?.id === c.id) {
      return (
        <div key={c.id} className="item-row on">
          <input
            className="item-edit"
            aria-label={t("ws.convTitleAria")}
            autoFocus
            maxLength={100}
            value={editing.title}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                renameCancelled.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={() => void commitRename()}
          />
        </div>
      );
    }
    const open = menuId === c.id;
    return (
      <div key={c.id} className={`item-row ${c.id === id ? "on" : ""} ${open ? "menu-open" : ""}`}>
        <button className={`item ${c.id === id ? "on" : ""}`} onClick={() => nav(`/c/${c.id}`)}>
          <b>{displayTitle(c.title)}</b>
          <span>{stageLabel(c.stage) ?? t("stage.notStarted")}</span>
        </button>
        <div className="conv-menu-wrap">
          <button
            className="item-more"
            aria-label={t("ws.moreActions")}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setMenuId(open ? null : c.id)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="8" cy="3.5" r="1.4" />
              <circle cx="8" cy="8" r="1.4" />
              <circle cx="8" cy="12.5" r="1.4" />
            </svg>
          </button>
          {open && (
            <div className="conv-menu" role="menu">
              <button role="menuitem" onClick={() => { setMenuId(null); void togglePin(c); }}>
                {c.pinnedAt ? t("ws.unpin") : t("ws.pin")}
              </button>
              <button role="menuitem" onClick={() => startRename(c)}>{t("ws.rename")}</button>
              <button role="menuitem" className="danger" onClick={() => { setMenuId(null); void removeConv(c); }}>{t("ws.delete")}</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const stepIndex = stageLabels().findIndex((s) => s.key === stage);
  const hasWorkflow = !!selected;
  const showPanel = hasWorkflow && !panelCollapsed;

  if (loadError) {
    return (
      <div className="page">
        <Topbar />
        <div style={{ padding: 40 }}>
          <div className="notice-error">{loadError}</div>
          <p style={{ marginTop: 16 }}><Link to="/">{t("ws.backHome")}</Link></p>
        </div>
      </div>
    );
  }

  return (
    <div className="page ws-page">
      <Topbar>
        <button type="button" className="rail-mobile-btn" onClick={() => setMobileRailOpen(true)} aria-label={t("ws.openRail")}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 5h12M3 9h12M3 13h12" />
          </svg>
        </button>
        <div className="ws-context">
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-title" title={displayTitle(title)}>{displayTitle(title) || t("ws.untitled")}</span>
          <StageProgress index={stepIndex} />
        </div>
      </Topbar>

      <div
        className={`ws ${resizing ? "resizing" : ""} ${showPanel ? "" : "no-panel"}`}
        style={{ "--chat-w": `${chatW}px`, "--rail-w": `${railOpen ? RAIL_W : RAIL_COLLAPSED_W}px` } as CSSProperties}
      >
        {mobileRailOpen && <div className="rail-backdrop" onClick={() => setMobileRailOpen(false)} aria-hidden="true" />}
        <aside className={`rail ${railExpanded ? "" : "collapsed"} ${mobileRailOpen ? "mobile-open" : ""}`}>
          <div className="rail-head">
            <button className="rail-toggle rail-collapse" onClick={toggleRail} aria-label={railOpen ? t("ws.collapseRail") : t("ws.expandRail")}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="2" y="2.5" width="12" height="11" rx="2" />
                <path d="M6 2.5v11" />
              </svg>
            </button>
            {railExpanded ? (
              <button className="btn btn-ink new" onClick={newConversation}>{t("ws.newConv")}</button>
            ) : (
              <button className="rail-toggle" onClick={newConversation} aria-label={t("ws.newConvAria")}>＋</button>
            )}
          </div>
          {railExpanded && (
            <>
              {convList.some((c) => c.pinnedAt) && <div className="group">{t("ws.pinned")}</div>}
              {convList.filter((c) => c.pinnedAt).map((c) => renderConvItem(c))}
              {convList.some((c) => c.pinnedAt) && convList.some((c) => !c.pinnedAt) && <div className="group">{t("ws.recent")}</div>}
              {convList.filter((c) => !c.pinnedAt).map((c) => renderConvItem(c))}
            </>
          )}
        </aside>

        <Chat
          items={items}
          busy={busy}
          inputRef={inputRef}
          conversationId={id}
          attachmentsEnabled={!!me?.features.visionEnabled}
          onSend={(text, ids) => void send(text, ids)}
          onChoice={answerChoice}
          onStop={() => { abortRef.current?.abort(); void api.post(`/conversations/${id}/abort`).catch(() => {}); }}
          hints={hints}
          onHint={(h) => void send(h.text, [], h.intent)}
        />

        {showPanel && (
        <>
        <div
          className={`splitter ${resizing ? "active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("ws.splitterAria")}
          aria-valuenow={chatW}
          tabIndex={0}
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onPointerCancel={onSplitUp}
          onDoubleClick={resetChatW}
          onKeyDown={onSplitKey}
        />

        <section className="panel">
          <div className="panel-head">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "canvas"} className={tab === "canvas" ? "on" : ""} onClick={() => setTab("canvas")}>{t("ws.tabCanvas")}</button>
              <button role="tab" aria-selected={tab === "profile"} className={tab === "profile" ? "on" : ""} onClick={() => setTab("profile")}>
                {t("ws.tabProfile")}<span className="mono muted" style={{ marginLeft: 4 }}>{profile.painPoints.length}</span>
              </button>
            </div>
            <div className="right">
              {selected && versions.length > 0 && (
                <Select
                  ariaLabel={t("ws.versionAria")}
                  value={selected.version}
                  options={versions.map((v) => ({ value: v, label: t("ws.version", { v }) }))}
                  onChange={(v) => setSelected({ ...selected, version: v })}
                />
              )}
              {workflows.length > 1 && selected && (
                <Select
                  ariaLabel={t("ws.workflowAria")}
                  value={selected.workflowId}
                  options={workflows.map((w) => ({ value: w.id, label: w.name }))}
                  onChange={(id) => {
                    const w = workflows.find((x) => x.id === id)!;
                    setSelected({ workflowId: w.id, name: w.name, version: w.latestVersion, latestVersion: w.latestVersion });
                  }}
                />
              )}
              <button className="btn btn-line" disabled={!selected} onClick={() => setShareOpen(true)}>{t("ws.share")}</button>
              <div style={{ position: "relative" }} ref={exportWrapRef}>
                <button className="btn btn-ink" disabled={!ir} onClick={() => setMenuOpen((v) => !v)}>{t("ws.export")}</button>
                {menuOpen && ir && (
                  <ExportMenu
                    ir={ir}
                    scene={scene.scene}
                    exporters={exporters}
                    workflowId={selected?.workflowId}
                    onSaved={(version) => {
                      // 切到新版本：版本下拉里也要有它
                      setVersions((vs) => (vs.includes(version) ? vs : [...vs, version].sort((x, y) => x - y)));
                      setSelected((cur) => (cur ? { ...cur, version, latestVersion: version } : cur));
                    }}
                    onClose={() => setMenuOpen(false)}
                  />
                )}
              </div>
              <button className="panel-icon-btn" onClick={() => setPanelCollapsed(true)} aria-label={t("ws.collapseCanvas")}>{PANEL_ICON}</button>
            </div>
          </div>
          <div className="panel-body">
            {tab === "canvas" ? (
              <CanvasView scene={scene.scene} loading={scene.loading} error={scene.error} readOnly />
            ) : (
              <ProfilePanel profile={profile} onPatchPain={patchPain} />
            )}
          </div>
        </section>
        </>
        )}
        {hasWorkflow && !showPanel && (
          <button className="panel-edge" onClick={() => setPanelCollapsed(false)} aria-label={t("ws.expandCanvas")}>{PANEL_ICON}</button>
        )}
      </div>

      {shareOpen && selected && (
        <ShareModal
          workflowId={selected.workflowId}
          workflowName={selected.name}
          selectedVersion={selected.version}
          latestVersion={selected.latestVersion}
          allowPublic={!!me?.features.sharePublicEnabled}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
