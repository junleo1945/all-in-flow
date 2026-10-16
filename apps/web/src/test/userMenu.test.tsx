import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { UserMenu } from "../components/Topbar";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("头像菜单", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<UserMenu name="张三" />} />
            <Route path="/mermaid" element={<div id="mermaid-page" />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const trigger = () => host.querySelector<HTMLButtonElement>(".user-trigger")!;
  const menu = () => host.querySelector('[role="menu"]');

  it("右键头像弹出菜单，并阻止浏览器默认菜单", () => {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void trigger().dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
  });

  it("点击头像切换菜单；点击菜单外或按 Esc 关闭", () => {
    act(() => trigger().click());
    expect(menu()).not.toBeNull();
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull();

    act(() => trigger().click());
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(menu()).toBeNull();
  });

  it("点击「Mermaid 预览」跳转到 /mermaid", () => {
    act(() => trigger().click());
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Mermaid 预览")!;
    act(() => item.click());
    expect(host.querySelector("#mermaid-page")).not.toBeNull();
  });
});
