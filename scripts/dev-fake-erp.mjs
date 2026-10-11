// 仅用于本地开发：模拟 ERP 的登录和订单接口，方便在没有内网 ERP 的情况下体验界面和导出的 Skill 脚本。
// 账号：zhangsan（管理员）、lisi（普通用户），密码都是 secret。
// 生产环境不要使用，服务端的 ERP_BASE_URL 指向真实 ERP 即可。
import { createServer } from "node:http";

const USERS = {
  zhangsan: { UserId: 990001, FullName: "张三" },
  lisi: { UserId: 990002, FullName: "李四" },
};

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/api/login" && req.method === "POST") {
      const { UserName, Password } = JSON.parse(body || "{}");
      if (!USERS[UserName] || Password !== "secret") return json(401, { Success: false, UserMsg: "账号或密码错误" });
      return json(200, { Success: true }, { "Set-Cookie": `tm_sso_sid=erp-${UserName}; Path=/; HttpOnly` });
    }
    if (req.url === "/user/api/get") {
      const cookie = req.headers.cookie ?? "";
      const name = Object.keys(USERS).find((n) => cookie.includes(`erp-${n}`));
      if (!name) return json(401, {});
      return json(200, { Success: true, Data: { ...USERS[name], UserName: name, ExpireDuration: 3600 } });
    }
    // 订单接口（开发用）：需要 Bearer 令牌 dev-token，返回固定的几条订单
    if (req.url?.startsWith("/api/orders") && req.method === "GET") {
      if (req.headers.authorization !== "Bearer dev-token") return json(401, { Success: false, UserMsg: "令牌无效" });
      const url = new URL(req.url, "http://127.0.0.1:4100");
      return json(200, {
        Success: true,
        Data: {
          start: url.searchParams.get("start"),
          end: url.searchParams.get("end"),
          orders: [
            { id: "SO-001", amount: 1200, status: "normal" },
            { id: "SO-002", amount: 560, status: "abnormal" },
          ],
        },
      });
    }
    json(404, {});
  });
}).listen(4100, "127.0.0.1", () => console.log("fake ERP on http://127.0.0.1:4100"));
