import { useEffect } from "react";
import { useI18n } from "../i18n";

/** 点击缩略图后的大图预览：点击遮罩或按 Esc 关闭 */
export function ImageLightbox({ src, caption, onClose }: { src: string; caption?: string; onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={t("common.imagePreview")} onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <img src={src} alt="" />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      <button className="lightbox-close" onClick={onClose} aria-label={t("common.close")}>✕</button>
    </div>
  );
}
