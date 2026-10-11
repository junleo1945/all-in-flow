import { useEffect } from "react";

/** 点击缩略图后的大图预览：点击遮罩或按 Esc 关闭 */
export function ImageLightbox({ src, caption, onClose }: { src: string; caption?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label="图片预览" onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <img src={src} alt="" />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      <button className="lightbox-close" onClick={onClose} aria-label="关闭">✕</button>
    </div>
  );
}
