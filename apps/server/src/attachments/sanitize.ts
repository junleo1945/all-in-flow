import sharp from "sharp";
import { detectImageMime, type ImageMime } from "./validate.js";

export class ImageRejected extends Error {}

/** 最长边上限：超过则等比缩小，减少存储和识别成本 */
export const MAX_SIDE = 4096;
/** 解码像素上限，防止解压炸弹 */
export const MAX_PIXELS = 40_000_000;

const FORMAT_OF: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };

export interface SanitizedImage {
  data: Buffer;
  mime: ImageMime;
  width: number;
  height: number;
  /** 去除前是否带有 EXIF / ICC 信息（用于审计，不返回给用户） */
  stripped: { exif: boolean; icc: boolean };
}

/**
 * 校验并净化图片：
 * 1. 文件头必须是 PNG / JPEG / WebP；
 * 2. 用图像库完整解析，内容必须与文件头一致；
 * 3. 拒绝动图、损坏文件、过大的图片；
 * 4. 重新编码：应用 EXIF 方向后丢弃所有元数据（EXIF、GPS、XMP、文本块），并限制尺寸。
 * 重新编码也会丢弃图片中不属于图像数据的内容，降低恶意文件的风险。
 */
export async function sanitizeImage(input: Buffer): Promise<SanitizedImage> {
  const declared = detectImageMime(input);
  if (!declared) throw new ImageRejected("只支持 PNG、JPEG、WebP 图片");

  const opts = { limitInputPixels: MAX_PIXELS, failOn: "error" as const };
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, opts).metadata();
  } catch {
    throw new ImageRejected("图片损坏或无法解析");
  }
  if (meta.format !== FORMAT_OF[declared]) throw new ImageRejected("图片内容与文件格式不符");
  if ((meta.pages ?? 1) > 1) throw new ImageRejected("不支持动图，请上传静态图片");
  if (!meta.width || !meta.height) throw new ImageRejected("无法读取图片尺寸");

  let pipeline = sharp(input, opts)
    .rotate() // 按 EXIF 方向转正，之后元数据会被丢弃
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
  switch (declared) {
    case "image/png":
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
    case "image/jpeg":
      pipeline = pipeline.jpeg({ quality: 90 });
      break;
    case "image/webp":
      pipeline = pipeline.webp({ quality: 90 });
      break;
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  // 再次解析输出，确保净化后的文件本身是有效图片
  const out = await sharp(data, opts).metadata().catch(() => {
    throw new ImageRejected("图片处理失败");
  });
  if (out.format !== FORMAT_OF[declared]) throw new ImageRejected("图片处理失败");

  return {
    data,
    mime: declared,
    width: info.width,
    height: info.height,
    stripped: { exif: !!meta.exif, icc: !!meta.icc },
  };
}
