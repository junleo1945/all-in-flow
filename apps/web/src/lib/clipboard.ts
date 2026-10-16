import { tr } from "../i18n";

/**
 * 复制文本到剪贴板。HTTP 部署（非安全上下文）下 navigator.clipboard 不可用，
 * 这时退回 textarea + execCommand('copy')。
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒绝等情况，退回下面的方式
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error(tr("clip.fail"));
}
