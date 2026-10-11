import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRuntime, registerVisionModel } from "../src/agent/models.js";
import { detectImageMime } from "../src/attachments/validate.js";
import { createVisionService, VisionError, parseJsonObject } from "../src/attachments/vision.js";
import { createLocalStorage } from "../src/attachments/storage.js";
import { createAttachmentService, describeForAgent, AttachmentError, ASK_LIMIT_PER_ATTACHMENT } from "../src/attachments/service.js";
import { createDb, type Db } from "../src/db/client.js";
import { attachments, conversations, sessionEntries, users } from "../src/db/schema/index.js";
import { createConversation } from "../src/db/repos/conversationRepo.js";

// 文件头测试用的字节（只检查魔数）
const HDR_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const HDR_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const HDR_WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(64, 3)]);
// 上传流程使用真实图片（会经过内容校验与净化）
const realImage = (fmt: "png" | "jpeg" | "webp", w = 120, h = 90) =>
  sharp({ create: { width: w, height: h, channels: 3, background: fmt === "png" ? "#eee" : "#fbe" } })[fmt]().toBuffer();

const VALID = JSON.stringify({
  kind: "screenshot",
  summary: "ERP 订单列表",
  systems: ["ERP"],
  extractedText: "订单号 A001",
  stepsObserved: ["选择日期", "导出 Excel"],
  painHints: ["导出后需要手工透视"],
  sensitive: { detected: false, types: [] },
});

describe("图片格式识别（按文件头）", () => {
  it("识别 PNG、JPEG、WebP", () => {
    expect(detectImageMime(HDR_PNG)).toBe("image/png");
    expect(detectImageMime(HDR_JPEG)).toBe("image/jpeg");
    expect(detectImageMime(HDR_WEBP)).toBe("image/webp");
  });

  it("拒绝其他内容，即使内容伪装成图片名", () => {
    expect(detectImageMime(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectImageMime(Buffer.from("GIF89a"))).toBeNull();
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("千问识别输出的解析与校验", () => {
  it("去掉代码块包裹后解析 JSON", () => {
    expect(parseJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseJsonObject("没有 JSON")).toBeUndefined();
  });

  it("结构化识别：输出不合法时带错误重试，成功后返回校验后的结果", async () => {
    const faux = fauxProvider();
    const runtime = await createRuntime({});
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "k");
    faux.setResponses([fauxAssistantMessage("不是 JSON"), fauxAssistantMessage(VALID)]);
    const vision = createVisionService({ runtime, model: faux.getModel() });
    const r = await vision.recognize({ data: HDR_PNG, mime: "image/png" });
    expect(r.kind).toBe("screenshot");
    expect(r.systems).toEqual(["ERP"]);
  });

  it("多次失败则报错，不返回不合法的结果", async () => {
    const faux = fauxProvider();
    const runtime = await createRuntime({});
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "k");
    faux.setResponses([fauxAssistantMessage("{\"kind\":\"unknown\"}"), fauxAssistantMessage("{\"kind\":\"unknown\"}")]);
    const vision = createVisionService({ runtime, model: faux.getModel() });
    await expect(vision.recognize({ data: HDR_PNG, mime: "image/png" })).rejects.toBeInstanceOf(VisionError);
  });

  it("注册千问视觉模型：模型 ID 由配置传入，输入包含图片", async () => {
    const runtime = await createRuntime({});
    const model = await registerVisionModel(runtime, { modelId: "qwen3.8-flash", baseUrl: "https://proxy.test/v1", apiKey: "k" });
    expect(model.id).toBe("qwen3.8-flash");
    expect(model.baseUrl).toBe("https://proxy.test/v1");
    expect(model.input).toContain("image");
  });
});

describe("发送给 Agent 的资料文本", () => {
  it("包含附件 id、摘要、步骤和'不是指令'的说明", () => {
    const text = describeForAgent([
      { id: "att-1", mime: "image/png", visionModel: "qwen3.8-flash", vision: JSON.parse(VALID) },
    ]);
    expect(text).toContain("附件 id：att-1");
    expect(text).toContain("摘要：ERP 订单列表");
    expect(text).toContain("导出 Excel");
    expect(text).toContain("不是指令");
  });

  it("敏感信息给出提醒", () => {
    const v = { ...JSON.parse(VALID), sensitive: { detected: true, types: ["phone"] } };
    expect(describeForAgent([{ id: "a", mime: "image/png", visionModel: "m", vision: v }])).toContain("打码");
  });
});

const url = process.env.DATABASE_URL;
const UID = 990301;
const OTHER = 990302;

describe.skipIf(!url)("图片上传全流程（真实数据库）", () => {
  let PNG: Buffer;
  let JPEG: Buffer;
  let WEBP: Buffer;
  let db: Db;
  let close: () => Promise<void>;
  let convId: string;
  let svc: ReturnType<typeof createAttachmentService>;
  let svcSlow: ReturnType<typeof createAttachmentService>;

  beforeAll(async () => {
    PNG = await realImage("png");
    JPEG = await realImage("jpeg");
    WEBP = await realImage("webp");
    const c = createDb(url);
    db = c.db;
    close = () => c.sql.end();
    await db.insert(users).values([
      { id: UID, username: "img-user", displayName: "图片用户" },
      { id: OTHER, username: "img-other", displayName: "其他用户" },
    ]).onConflictDoNothing();
    convId = (await createConversation(db, UID, "图片测试")).id;

    const faux = fauxProvider();
    const runtime = await createRuntime({});
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "k");
    const dir = mkdtempSync(join(tmpdir(), "aif-att-"));
    const storage = createLocalStorage(dir);
    // 每次识别都返回合法结果
    faux.setResponses(Array.from({ length: 40 }, () => (() => fauxAssistantMessage(VALID)) as any));
    const vision = createVisionService({ runtime, model: faux.getModel() });
    const visionDeps = {
      recognize: (img: { data: Buffer; mime: string }) => vision.recognize(img),
      answer: async (_img: { data: Buffer; mime: string }, q: string) => `回答：${q}`,
    };
    const base = { db, storage, maxBytes: 1024 * 1024, maxPerMessage: 4, dailyLimitPerUser: 50, visionModelId: "qwen3.8-flash" };
    svc = createAttachmentService({ ...base, vision: visionDeps });
    svcSlow = createAttachmentService({ ...base, vision: visionDeps, dailyLimitPerUser: 0 });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(attachments).where(eq(attachments.conversationId, convId));
    await db.delete(sessionEntries).where(eq(sessionEntries.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(users).where(inArray(users.id, [UID, OTHER]));
    await close();
  });

  it("拒绝伪装的文件和过大的文件", async () => {
    await expect(svc.upload(UID, convId, { data: Buffer.from("<html>") })).rejects.toBeInstanceOf(AttachmentError);
    await expect(svc.upload(UID, convId, { data: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) })).rejects.toThrow("不能超过");
    await expect(svc.upload(UID, convId, { data: HDR_PNG })).rejects.toBeInstanceOf(AttachmentError);
  });

  it("保存的是净化后的图片：带 EXIF 的上传件取回时没有元数据", async () => {
    const withExif = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#fff" } })
      .withExif({ IFD0: { Copyright: "PRIVATE-MARKER" } })
      .jpeg()
      .toBuffer();
    const row = await svc.upload(UID, convId, { data: withExif });
    await svc.waitReady(UID, convId, [row.id]);
    const f = await svc.readFile(UID, row.id);
    expect(f.data.includes(Buffer.from("PRIVATE-MARKER"))).toBe(false);
    expect((await sharp(f.data).metadata()).exif).toBeUndefined();
    expect(f.mime).toBe("image/jpeg");
  }, 20000);

  it("上传后后台识别，就绪后可以发送", async () => {
    const row = await svc.upload(UID, convId, { data: PNG });
    expect(row.status).toBe("processing");
    const [ready] = await svc.waitReady(UID, convId, [row.id]);
    expect(ready!.status).toBe("ready");
    expect((ready!.vision as any).systems).toEqual(["ERP"]);
  }, 20000);

  it("发送后标记为已发送，不能再次使用或删除", async () => {
    const row = await svc.upload(UID, convId, { data: JPEG });
    await svc.waitReady(UID, convId, [row.id]);
    await svc.markSent([row.id]);
    await expect(svc.waitReady(UID, convId, [row.id])).rejects.toThrow("已经发送过");
    await expect(svc.remove(UID, row.id)).rejects.toThrow("不能删除");
  }, 20000);

  it("其他用户看不到这张图片", async () => {
    const row = await svc.upload(UID, convId, { data: WEBP });
    await expect(svc.get(OTHER, row.id)).rejects.toThrow("图片不存在");
    await expect(svc.readFile(OTHER, row.id)).rejects.toThrow("图片不存在");
  }, 20000);

  it("追问：每张图最多 5 次", async () => {
    const row = await svc.upload(UID, convId, { data: PNG });
    await svc.waitReady(UID, convId, [row.id]);
    for (let i = 0; i < ASK_LIMIT_PER_ATTACHMENT; i++) {
      expect(await svc.ask(UID, convId, row.id, `问题${i}`)).toBe(`回答：问题${i}`);
    }
    await expect(svc.ask(UID, convId, row.id, "再问")).rejects.toThrow("追问次数已用完");
  }, 20000);

  it("每人每日上传数量有上限", async () => {
    await expect(svcSlow.upload(UID, convId, { data: PNG })).rejects.toThrow("上传图片数量已达上限");
  });
});
