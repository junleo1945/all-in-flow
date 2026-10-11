import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { sanitizeImage, ImageRejected, MAX_SIDE } from "../src/attachments/sanitize.js";

const MARKER = "SECRET-GPS-MARKER";

/** 生成带 EXIF（含版权字段，作为可检测的标记）的测试图片 */
async function withExifJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 80, channels: 3, background: "#ffffff" } })
    .withExif({ IFD0: { Copyright: MARKER, Artist: "tester" } })
    .jpeg()
    .toBuffer();
}

describe("图片净化：去除元数据", () => {
  it("输入带 EXIF，输出不再包含任何 EXIF", async () => {
    const input = await withExifJpeg();
    expect((await sharp(input).metadata()).exif).toBeDefined(); // 前提：原图确实带 EXIF
    const r = await sanitizeImage(input);
    expect(r.stripped.exif).toBe(true);
    expect(r.data.includes(Buffer.from(MARKER))).toBe(false);
    expect((await sharp(r.data).metadata()).exif).toBeUndefined();
  });

  it("PNG 的文本块（tEXt）也会被去除", async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#000" } })
      .png()
      .withMetadata({ comment: MARKER } as any)
      .toBuffer();
    const r = await sanitizeImage(png);
    expect(r.data.includes(Buffer.from(MARKER))).toBe(false);
  });

  it("输出保持原格式，且仍是可解码的图片", async () => {
    for (const fmt of ["png", "jpeg", "webp"] as const) {
      const src = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } })[fmt]().toBuffer();
      const r = await sanitizeImage(src);
      expect(r.mime).toBe(`image/${fmt === "jpeg" ? "jpeg" : fmt}`);
      expect((await sharp(r.data).metadata()).width).toBe(64);
    }
  });
});

describe("图片净化：校验内容", () => {
  it("文件头像图片但内容不是图片，拒绝", async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("<script>alert(1)</script>".repeat(20))]);
    await expect(sanitizeImage(fake)).rejects.toBeInstanceOf(ImageRejected);
  });

  it("文件头是 JPEG 但内容是 PNG，拒绝（格式与内容不符）", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).png().toBuffer();
    const spoof = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), png.subarray(4)]);
    await expect(sanitizeImage(spoof)).rejects.toThrow();
  });

  it("超大尺寸会等比缩小到上限内", async () => {
    const big = await sharp({ create: { width: MAX_SIDE + 904, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
    const r = await sanitizeImage(big);
    expect(r.width).toBe(MAX_SIDE);
    expect(r.height).toBeLessThan(100);
  });

  it("截断的图片拒绝", async () => {
    const ok = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    await expect(sanitizeImage(ok.subarray(0, 40))).rejects.toBeInstanceOf(ImageRejected);
  });
});
