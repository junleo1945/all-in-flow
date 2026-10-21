import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/lib/netguard.js";

describe("内网地址判断", () => {
  it("拒绝回环、内网、链路本地、保留地址", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });

  it("允许公网地址", () => {
    for (const a of ["8.8.8.8", "203.0.113.10", "172.32.0.1", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});
