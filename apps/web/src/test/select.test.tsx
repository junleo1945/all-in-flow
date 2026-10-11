import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Select } from "../components/ui/Select";

// @ts-expect-error 测试环境使用 React 的 act 标记
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三", disabled: true },
  { value: 4, label: "四" },
];

describe("Select 下拉组件", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  const render = (value: number, onChange: (v: number) => void) =>
    act(() => {
      root.render(<Select ariaLabel="测试" value={value} options={OPTIONS} onChange={onChange} />);
    });

  const trigger = () => host.querySelector("button") as HTMLButtonElement;
  const menu = () => document.querySelector<HTMLUListElement>(".ui-select-menu");
  const key = (el: Element, k: string) =>
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });

  it("显示当前选中项的文字，点击后弹出选项列表", () => {
    render(2, () => {});
    expect(trigger().textContent).toContain("二");
    expect(menu()).toBeNull();
    act(() => trigger().click());
    expect(menu()).not.toBeNull();
    expect(menu()!.querySelectorAll("[role=option]")).toHaveLength(4);
  });

  it("点击选项会触发 onChange 并关闭列表", () => {
    const onChange = vi.fn();
    render(1, onChange);
    act(() => trigger().click());
    const opt = document.querySelectorAll<HTMLLIElement>(".ui-select-opt")[3]!;
    act(() => opt.click());
    expect(onChange).toHaveBeenCalledWith(4);
    expect(menu()).toBeNull();
  });

  it("键盘：↓ 移动并跳过禁用项，Enter 选中", () => {
    const onChange = vi.fn();
    render(1, onChange);
    act(() => trigger().click());
    key(menu()!, "ArrowDown"); // 一 -> 二
    key(menu()!, "ArrowDown"); // 二 -> 跳过“三”(禁用) -> 四
    key(menu()!, "Enter");
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("Esc 关闭列表且不触发 onChange", () => {
    const onChange = vi.fn();
    render(1, onChange);
    act(() => trigger().click());
    key(menu()!, "Escape");
    expect(menu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("禁用时点击不弹出", () => {
    act(() => {
      root.render(<Select ariaLabel="测试" value={1} options={OPTIONS} disabled onChange={() => {}} />);
    });
    act(() => trigger().click());
    expect(menu()).toBeNull();
  });
});
