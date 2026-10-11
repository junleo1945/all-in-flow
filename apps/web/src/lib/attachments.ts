import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, redirectToLogin, AUTH_EXPIRED_CODE } from "./api";

export const MAX_ATTACHMENTS = 4;
export const ACCEPT_IMAGE = "image/png,image/jpeg,image/webp";

export type AttachmentStatus = "uploading" | "processing" | "ready" | "failed";

export interface PendingAttachment {
  localId: string;
  file: File;
  /** 本地预览地址（ObjectURL），上传完成后仍用于输入框缩略图 */
  previewUrl: string;
  /** 服务端附件 id；上传成功后才有 */
  id?: string;
  status: AttachmentStatus;
  error?: string;
  summary?: string;
}

interface UploadResult {
  id: string;
  status: string;
}

interface AttachmentDetail {
  id: string;
  status: "processing" | "ready" | "failed";
  error?: string | null;
  vision?: { summary?: string } | null;
}

const isImage = (f: File) => ACCEPT_IMAGE.split(",").includes(f.type);

async function uploadFile(conversationId: string, file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/conversations/${conversationId}/attachments`, { method: "POST", credentials: "include", body: form });
  const body = await res.json().catch(() => null);
  if (res.status === 401 || body?.code === AUTH_EXPIRED_CODE) {
    redirectToLogin();
    throw new ApiError(AUTH_EXPIRED_CODE, "请重新登录", res.status);
  }
  if (!res.ok || body?.code !== 0) throw new ApiError(body?.code ?? res.status, body?.message || "上传失败", res.status);
  return body.data as UploadResult;
}

/**
 * 输入框里的待发送图片：粘贴 / 拖拽 / 选择文件后立即上传，并轮询识别状态。
 */
export function usePendingAttachments(conversationId: string, enabled: boolean) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pollers = useRef(new Map<string, number>());

  const update = useCallback((localId: string, patch: Partial<PendingAttachment>) => {
    setItems((prev) => prev.map((x) => (x.localId === localId ? { ...x, ...patch } : x)));
  }, []);

  const poll = useCallback(
    (localId: string, id: string) => {
      let tries = 0;
      const tick = async () => {
        tries += 1;
        try {
          const d = await api.get<AttachmentDetail>(`/attachments/${id}`);
          if (d.status === "processing" && tries < 60) {
            pollers.current.set(localId, window.setTimeout(tick, 1500));
            return;
          }
          pollers.current.delete(localId);
          update(localId, d.status === "ready" ? { status: "ready", summary: d.vision?.summary } : { status: "failed", error: d.error ?? "识别超时，请删除后重试" });
        } catch {
          pollers.current.delete(localId);
          update(localId, { status: "failed", error: "识别状态获取失败" });
        }
      };
      void tick();
    },
    [update],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!enabled) return;
      const room = MAX_ATTACHMENTS - itemsRef.current.length;
      const valid = files.filter(isImage).slice(0, Math.max(0, room));
      for (const file of valid) {
        const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const previewUrl = URL.createObjectURL(file);
        setItems((prev) => [...prev, { localId, file, previewUrl, status: "uploading" }]);
        try {
          const r = await uploadFile(conversationId, file);
          update(localId, { id: r.id, status: "processing" });
          poll(localId, r.id);
        } catch (e) {
          update(localId, { status: "failed", error: e instanceof ApiError ? e.message : "上传失败" });
        }
      }
    },
    [conversationId, enabled, poll, update],
  );

  const remove = useCallback(
    async (localId: string) => {
      const item = itemsRef.current.find((x) => x.localId === localId);
      if (!item) return;
      window.clearTimeout(pollers.current.get(localId));
      pollers.current.delete(localId);
      URL.revokeObjectURL(item.previewUrl);
      setItems((prev) => prev.filter((x) => x.localId !== localId));
      if (item.id) await api.delete(`/attachments/${item.id}`).catch(() => {});
    },
    [],
  );

  /** 发送后清空输入框的图片（已上传的图片由服务端保留，历史中用 id 显示） */
  const clear = useCallback(() => {
    for (const x of itemsRef.current) {
      window.clearTimeout(pollers.current.get(x.localId));
      URL.revokeObjectURL(x.previewUrl);
    }
    pollers.current.clear();
    setItems([]);
  }, []);

  useEffect(
    () => () => {
      for (const x of itemsRef.current) URL.revokeObjectURL(x.previewUrl);
      for (const t of pollers.current.values()) window.clearTimeout(t);
    },
    [],
  );

  const busy = items.some((x) => x.status === "uploading");
  const failed = items.some((x) => x.status === "failed");
  const readyIds = items.filter((x) => x.id && (x.status === "ready" || x.status === "processing")).map((x) => x.id!);

  return { items, addFiles, remove, clear, busy, failed, readyIds };
}
