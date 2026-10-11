import { Hono } from "hono";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import { AttachmentError, type AttachmentService } from "../attachments/service.js";

export function attachmentRoutes(deps: { attachments?: AttachmentService }) {
  const r = new Hono<{ Variables: AppVariables }>();
  const svc = (): AttachmentService => {
    if (!deps.attachments) throw new AppError(503, "图片识别未开启");
    return deps.attachments;
  };

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AttachmentError) throw new AppError(e.status, e.message);
      throw e;
    }
  };

  // 上传（multipart，字段名 file）；识别在后台进行，立即返回
  r.post("/conversations/:id/attachments", async (c) => {
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File)) throw new AppError(400, "请选择图片文件");
    const data = Buffer.from(await file.arrayBuffer());
    const row = await wrap(() => svc().upload(c.get("user").id, c.req.param("id"), { data, declaredMime: file.type }));
    return ok(c, { id: row.id, status: row.status, mime: row.mime, bytes: row.bytes }, 201);
  });

  r.get("/attachments/:id", async (c) => {
    const row = await wrap(() => svc().get(c.get("user").id, c.req.param("id")));
    return ok(c, {
      id: row.id,
      status: row.status,
      mime: row.mime,
      error: row.error,
      vision: row.status === "ready" ? row.vision : null,
      sent: !!row.sentAt,
    });
  });

  r.get("/attachments/:id/file", async (c) => {
    const f = await wrap(() => svc().readFile(c.get("user").id, c.req.param("id")));
    return new Response(new Uint8Array(f.data), {
      headers: {
        "Content-Type": f.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  r.delete("/attachments/:id", async (c) => {
    await wrap(() => svc().remove(c.get("user").id, c.req.param("id")));
    return ok(c, null);
  });

  return r;
}
