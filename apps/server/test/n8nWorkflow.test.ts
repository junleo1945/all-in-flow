import { describe, expect, it } from "vitest";
import { credentialNamesOf, parseCredentials, parseSearchResults, forbiddenNode } from "../src/n8n/toolbox.js";
import { assembleWorkflow, checkDraft, isTrigger, layout, parseDraft, resolveCredentials, secretPath, type DraftWorkflow } from "../src/n8n/workflow.js";

const SEARCH_TEXT = `## "slack"
Found 5 nodes:

- n8n-nodes-base.slack
  Display Name: Slack
  Version: 2.7
  Description: Consume Slack API
  Discriminators:
    resource:
      - message:
          operations:
            - post

  Use get_node_types with discriminators:
    get_node_types({ nodeIds: [] })

- n8n-nodes-base.slackTool
  Display Name: Slack Tool
  Version: 2.7
  Description: Consume Slack API
  Discriminators: none (use node directly without resource/operation/mode)

- n8n-nodes-base.slackTrigger [TRIGGER]
  Display Name: Slack Trigger
  Version: 1
  Description: Handle Slack events via webhooks
  Discriminators: none (use node directly without resource/operation/mode)

- n8n-nodes-base.executeCommand
  Display Name: Execute Command
  Version: 1
  Description: Executes a command on the host
  Discriminators: none (use node directly without resource/operation/mode)`;

describe("search_nodes 结果解析", () => {
  it("保留普通节点和触发器；去掉工具节点和能执行命令的节点", () => {
    const list = parseSearchResults(SEARCH_TEXT);
    expect(list.map((c) => c.nodeType)).toEqual(["n8n-nodes-base.slack", "n8n-nodes-base.slackTrigger"]);
    expect(list[1]!.trigger).toBe(true);
    expect(list[0]).toMatchObject({ name: "Slack", version: 2.7 });
    expect(list[0]!.discriminators).toContain("message");
    expect(list[1]!.discriminators).toBeUndefined();
  });

  it("没有结果时为空", () => {
    expect(parseSearchResults('## "x"\nNo nodes found. Try a different search term.')).toEqual([]);
  });

  it("不允许的节点", () => {
    for (const t of ["executeCommand", "readWriteFile", "ssh", "n8n", "executeWorkflow"]) expect(forbiddenNode(`n8n-nodes-base.${t}`), t).toBe(true);
    expect(forbiddenNode("n8n-nodes-base.slack")).toBe(false);
  });
});

describe("凭证与定义解析", () => {
  it("从节点定义里取出可用的凭证类型", () => {
    const defs = "export interface SlackV27Credentials {\n  slackApi?: CredentialReference;\n  slackOAuth2Api?: CredentialReference;\n}\n";
    expect(credentialNamesOf(defs)).toEqual(["slackApi", "slackOAuth2Api"]);
  });

  it("list_credentials 的几种返回形态都认，只取 id、名称、类型", () => {
    const row = { id: 7, name: "钉钉", type: "httpQueryAuth", data: { secret: "x" } };
    for (const raw of [[row], { data: [row] }, { credentials: [row] }, { items: [row] }]) {
      expect(parseCredentials(raw)).toEqual([{ id: "7", name: "钉钉", type: "httpQueryAuth" }]);
    }
    expect(parseCredentials("nothing")).toEqual([]);
    expect(parseCredentials([{ id: 1 }])).toEqual([]);
  });
});

const node = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, typeVersion: 1, parameters: {}, ...extra });
const link = (to: string, type = "main", index = 0) => ({ node: to, type, index });

/** 邮件触发 → 判断 → 钉钉 */
const good = (): DraftWorkflow => ({
  nodes: [
    node("收到邮件", "n8n-nodes-base.emailReadImap"),
    node("分析邮件", "n8n-nodes-base.code", { parameters: { jsCode: "return $input.all();" } }),
    node("发钉钉", "n8n-nodes-base.httpRequest", { credentials: { httpQueryAuth: { id: "c1" } } }),
  ],
  connections: { 收到邮件: { main: [[link("分析邮件")]] }, 分析邮件: { main: [[link("发钉钉")]] } },
});

describe("工作流草稿检查", () => {
  it("正常的草稿没有问题", () => {
    expect(checkDraft(good())).toEqual([]);
  });

  it("没有触发器、多个触发器、重复名称、孤立节点都会报出来", () => {
    const none = good();
    none.nodes.shift();
    expect(checkDraft(none).join()).toContain("需要一个触发器");
    const two = good();
    two.nodes.push(node("定时", "n8n-nodes-base.scheduleTrigger"));
    expect(checkDraft(two).join()).toContain("只能有一个触发器");
    const dup = good();
    dup.nodes.push(node("发钉钉", "n8n-nodes-base.set"));
    expect(checkDraft(dup).join()).toContain("名称重复");
    const orphan = good();
    orphan.nodes.push(node("孤立", "n8n-nodes-base.set"));
    expect(checkDraft(orphan).join()).toContain("没有连到工作流里");
  });

  it("连线指向不存在的节点、格式不是二维数组都会报出来", () => {
    const bad = good();
    bad.connections["发钉钉"] = { main: [[link("不存在")]] };
    expect(checkDraft(bad).join()).toContain("不存在的节点");
    const flat = good();
    flat.connections["分析邮件"] = { main: [link("发钉钉")] } as never;
    expect(checkDraft(flat).join()).toContain("二维数组");
  });

  it("AI 子节点通过 ai_ 连线接入，不算孤立", () => {
    const d = good();
    d.nodes.push(node("模型", "@n8n/n8n-nodes-langchain.lmChatOpenAi"));
    d.connections["模型"] = { ai_languageModel: [[link("分析邮件", "ai_languageModel")]] };
    expect(checkDraft(d)).toEqual([]);
  });

  it("参数里的密钥、不安全的代码、不允许的节点被拒绝；表达式和空值不算密钥", () => {
    expect(secretPath({ options: { apiKey: "sk-1" } })).toBe("options.apiKey");
    const expression = "={{ $json.value }}";
    expect(secretPath({ token: expression })).toBeUndefined();
    expect(secretPath({ token: "" })).toBeUndefined();
    const d = good();
    d.nodes[2]!.parameters = { headerParameters: { parameters: [{ name: "x", value: "y" }] }, password: "123" };
    d.nodes[1]!.parameters = { jsCode: "require('fs')" };
    d.nodes.push(node("命令", "n8n-nodes-base.executeCommand"));
    d.connections["发钉钉"] = { main: [[link("命令")]] };
    const problems = checkDraft(d).join("\n");
    expect(problems).toContain("像是密钥");
    expect(problems).toContain("代码不安全");
    expect(problems).toContain("不允许的节点");
  });

  it("parseDraft：格式不对时给出问题", () => {
    expect(parseDraft({}).problems[0]).toContain("非空数组");
    expect(parseDraft({ nodes: [{ name: "a", type: "bad type", typeVersion: 1 }] }).problems[0]).toContain("type");
    expect(parseDraft({ nodes: [{ name: "a", type: "n8n-nodes-base.set", typeVersion: 0 }] }).problems[0]).toContain("typeVersion");
    expect(parseDraft({ nodes: Array.from({ length: 41 }, (_, i) => node(`n${i}`, "n8n-nodes-base.set")) }).problems[0]).toContain("最多");
    expect(parseDraft(good()).draft?.nodes).toHaveLength(3);
  });

  it("isTrigger", () => {
    for (const t of ["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.emailReadImapTrigger", "n8n-nodes-base.formTrigger", "n8n-nodes-base.webhook", "n8n-nodes-base.emailReadImap"]) expect(isTrigger(t), t).toBe(true);
    expect(isTrigger("n8n-nodes-base.set")).toBe(false);
    // 搜索时 n8n 标出的触发器也算
    expect(isTrigger("n8n-nodes-base.someNew", new Set(["n8n-nodes-base.someNew"]))).toBe(true);
  });
});

describe("凭证与组装", () => {
  const available = [{ id: "c1", name: "钉钉机器人", type: "httpQueryAuth" }];

  it("凭证只能引用 n8n 里真实存在、类型一致的；其余去掉并记入待办", () => {
    const d = good();
    d.nodes[1]!.credentials = { slackApi: { id: "c1" } }; // 类型不一致
    d.nodes.push(node("编造", "n8n-nodes-base.slack", { credentials: { slackApi: { id: "999" } } }));
    const { nodes, todo } = resolveCredentials(d, available);
    expect((nodes[2] as any).resolved).toEqual({ httpQueryAuth: { id: "c1", name: "钉钉机器人" } });
    expect((nodes[1] as any).resolved).toBeUndefined();
    expect((nodes[3] as any).resolved).toBeUndefined();
    expect(todo).toHaveLength(2);
    expect(todo[0]).toContain("需要 slackApi 类型的凭证");
  });

  it("组装：补节点 id 和位置，凭证带上名称，设置 executionOrder；相同输入得到相同输出", () => {
    const a = assembleWorkflow("周报", "weekly", good(), available);
    const b = assembleWorkflow("周报", "weekly", good(), available);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.workflow.settings).toEqual({ executionOrder: "v1" });
    const [first, second, third] = a.workflow.nodes;
    expect(first!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(a.workflow.nodes.map((n) => n.id)).size).toBe(3);
    expect(first!.position[0]).toBeLessThan(second!.position[0]);
    expect(second!.position[0]).toBeLessThan(third!.position[0]);
    expect(third!.credentials).toEqual({ httpQueryAuth: { id: "c1", name: "钉钉机器人" } });
  });

  it("排版：AI 子节点放在所连节点的下方", () => {
    const d = good();
    d.nodes.push(node("模型", "@n8n/n8n-nodes-langchain.lmChatOpenAi"));
    d.connections["模型"] = { ai_languageModel: [[link("分析邮件", "ai_languageModel")]] };
    const pos = layout(d);
    expect(pos.get("模型")![1]).toBeGreaterThan(pos.get("分析邮件")![1]);
  });
});
