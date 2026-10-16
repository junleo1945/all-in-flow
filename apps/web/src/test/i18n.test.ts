import { describe, expect, it } from "vitest";
import { EN_MESSAGES, ZH_MESSAGES, localeFromLanguages, tr } from "../i18n";

// 英文词条必须和中文一一对应，占位符也要一致，避免漏翻或参数对不上
describe("i18n messages", () => {
  it("every zh key has an en translation and vice versa", () => {
    expect(Object.keys(EN_MESSAGES).sort()).toEqual(Object.keys(ZH_MESSAGES).sort());
  });

  it("placeholders match between zh and en", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const k of Object.keys(ZH_MESSAGES)) {
      expect(ph(EN_MESSAGES[k] ?? ""), k).toBe(ph(ZH_MESSAGES[k]));
    }
  });

  it("falls back to the key when missing", () => {
    expect(tr("nope.missing")).toBe("nope.missing");
  });

  it("picks the locale from the browser languages", () => {
    expect(localeFromLanguages(["zh-CN", "en"])).toBe("zh");
    expect(localeFromLanguages(["zh-TW"])).toBe("zh");
    expect(localeFromLanguages(["en-US", "zh-CN"])).toBe("en");
    expect(localeFromLanguages(["ja-JP"])).toBe("en");
    expect(localeFromLanguages([])).toBe("en");
  });
});
