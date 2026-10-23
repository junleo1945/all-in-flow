/**
 * 模拟用户的人设（design.md 12）。
 * hiddenPainPoints 是人设里真实存在的痛点：模拟用户只有在被追问到具体实例时才会透露它们。
 * 一次访谈只聚焦其中一个，keywords 用于判断最终聚焦的痛点是不是其中之一（关键词命中，确定性、可复现）。
 */
export interface HiddenPainPoint {
  id: string;
  /** 人设里的痛点描述（评分时用于人工核对） */
  description: string;
  /** 命中判定：痛点标题或详情中出现任一关键词即视为挖出 */
  keywords: string[];
  /** 这个痛点的真实频率与耗时，用于检查"量化完整度" */
  frequency: "daily" | "weekly" | "monthly" | "ad_hoc";
  minutesPerRun: number;
}

export interface Persona {
  id: string;
  role: string;
  background: string;
  /** 模拟用户的说话风格，例如"口语、简短、经常说'还行'" */
  style: string;
  hiddenPainPoints: HiddenPainPoint[];
  /** 为 true 时，模拟用户对每件事要花多久没有概念：被要求报分钟数就说"不好说"，被追问会不耐烦 */
  cannotEstimate?: boolean;
}

const BASE_PERSONAS: Persona[] = [
  {
    id: "sales-ops",
    role: "销售运营",
    background: "负责华南区销售数据报表，每周要从 ERP 导出订单，在 Excel 里做透视，再挨个问销售异常订单。",
    style: "口语、简短，问到细节才会展开",
    hiddenPainPoints: [
      { id: "sa1", description: "每周手工导出并透视订单数据，透视表字段经常变", keywords: ["透视", "导出", "手工"], frequency: "weekly", minutesPerRun: 210 },
      { id: "sa2", description: "挨个私聊销售核对异常订单，回复慢要催很多次", keywords: ["核对", "异常", "私聊", "催"], frequency: "daily", minutesPerRun: 60 },
      { id: "sa3", description: "催单消息分散在多个群里，经常漏看", keywords: ["群", "漏", "催单"], frequency: "daily", minutesPerRun: 30 },
    ],
  },
  {
    id: "finance-accountant",
    role: "财务会计",
    background: "负责月度报销单据审核，要逐张核对票据、金额和审批人，还要和银行流水对账。",
    style: "严谨，回答有条理，但不主动说痛点",
    hiddenPainPoints: [
      { id: "fa1", description: "报销单据人工逐张核对票据和金额，耗时很长", keywords: ["报销", "核对", "票据"], frequency: "daily", minutesPerRun: 90 },
      { id: "fa2", description: "月底银行流水和账面对账，每次都要手工匹配", keywords: ["对账", "流水", "匹配"], frequency: "monthly", minutesPerRun: 240 },
      { id: "fa3", description: "财务口径变化后整张报表要重做", keywords: ["口径", "重做", "报表"], frequency: "monthly", minutesPerRun: 120 },
    ],
  },
  {
    id: "operations",
    role: "运营专员",
    background: "负责公众号和社群运营，每天要从多个后台抓取阅读、转化数据，整理成日报发给老板。",
    style: "热情、爱举例，但容易跑题",
    hiddenPainPoints: [
      { id: "op1", description: "每天从多个后台手工抓取数据整理日报", keywords: ["日报", "抓取", "后台", "数据"], frequency: "daily", minutesPerRun: 45 },
      { id: "op2", description: "社群消息需要人工筛选出有效咨询再分派", keywords: ["社群", "筛选", "分派", "咨询"], frequency: "daily", minutesPerRun: 40 },
      { id: "op3", description: "活动海报和文案要反复改版，审批来回很久", keywords: ["海报", "改版", "审批", "文案"], frequency: "weekly", minutesPerRun: 60 },
    ],
  },
  {
    id: "cs-supervisor",
    role: "客服主管",
    background: "管理十几名客服，每天要统计工单数量和超时情况，并把典型问题汇总给产品团队。",
    style: "直接、务实，习惯用数字说话",
    hiddenPainPoints: [
      { id: "cs1", description: "工单超时情况每天手工统计", keywords: ["超时", "统计", "工单"], frequency: "daily", minutesPerRun: 30 },
      { id: "cs2", description: "典型问题要从工单里人工摘录，再整理给产品", keywords: ["摘录", "典型", "产品", "汇总"], frequency: "weekly", minutesPerRun: 120 },
      { id: "cs3", description: "新人培训资料散落各处，要重复答疑", keywords: ["培训", "答疑", "资料"], frequency: "weekly", minutesPerRun: 90 },
    ],
  },
  {
    id: "hr-recruiter",
    role: "HR 招聘专员",
    background: "每个岗位要筛选几十份简历，按要求逐一打分，再给通过的候选人发面试邀请。",
    style: "客气，但会抱怨工作量大",
    hiddenPainPoints: [
      { id: "hr1", description: "简历按岗位要求人工逐份筛选", keywords: ["简历", "筛选", "打分"], frequency: "weekly", minutesPerRun: 180 },
      { id: "hr2", description: "面试邀请要一个个发邮件", keywords: ["邀请", "邮件", "面试"], frequency: "weekly", minutesPerRun: 40 },
      { id: "hr3", description: "考勤异常要在多个系统间核对", keywords: ["考勤", "核对", "系统"], frequency: "monthly", minutesPerRun: 120 },
    ],
  },
  {
    id: "product-manager",
    role: "产品经理",
    background: "需求来自销售、客服和老板，每周要把需求整理成文档并同步给研发排期。",
    style: "思路清晰，喜欢用框架描述",
    hiddenPainPoints: [
      { id: "pm1", description: "各渠道需求要人工汇总去重", keywords: ["需求", "汇总", "去重", "渠道"], frequency: "weekly", minutesPerRun: 150 },
      { id: "pm2", description: "需求状态变化要手动同步到多个群和表格", keywords: ["同步", "状态", "表格"], frequency: "daily", minutesPerRun: 30 },
      { id: "pm3", description: "周会纪要要从录音里整理", keywords: ["纪要", "周会", "整理"], frequency: "weekly", minutesPerRun: 60 },
    ],
  },
  {
    id: "developer",
    role: "后端开发工程师",
    background: "经常要排查线上接口报错，要从日志平台和监控平台之间来回对照，再写复盘。",
    style: "简洁，技术词多，不爱说废话",
    hiddenPainPoints: [
      { id: "dev1", description: "线上报错要在日志和监控之间手工对照定位", keywords: ["日志", "监控", "定位", "报错"], frequency: "daily", minutesPerRun: 40 },
      { id: "dev2", description: "每次上线后要手工核对发布清单", keywords: ["发布", "清单", "核对", "上线"], frequency: "weekly", minutesPerRun: 30 },
      { id: "dev3", description: "故障复盘文档要从聊天记录里整理", keywords: ["复盘", "聊天", "整理"], frequency: "ad_hoc", minutesPerRun: 120 },
    ],
  },
  {
    id: "purchasing",
    role: "采购专员",
    background: "每天要核对供应商报价和库存，缺货时要挨个给供应商打电话催货。",
    style: "干脆，遇到不懂的会直接问",
    hiddenPainPoints: [
      { id: "pu1", description: "供应商报价要和历史价格逐条比对", keywords: ["报价", "比对", "历史价格"], frequency: "daily", minutesPerRun: 50 },
      { id: "pu2", description: "缺货提醒靠人工查库存，再逐个电话催货", keywords: ["库存", "缺货", "催货", "电话"], frequency: "daily", minutesPerRun: 60 },
      { id: "pu3", description: "采购订单在 ERP 和 Excel 之间重复录入", keywords: ["录入", "重复", "订单"], frequency: "weekly", minutesPerRun: 90 },
    ],
  },
  {
    id: "warehouse",
    role: "仓储物流主管",
    background: "负责发货安排，每天要核对出库单和物流单号，异常包裹要一个个跟进。",
    style: "忙，回答简短，经常打断",
    hiddenPainPoints: [
      { id: "wh1", description: "出库单和物流单号要人工逐条核对", keywords: ["出库", "物流单号", "核对"], frequency: "daily", minutesPerRun: 60 },
      { id: "wh2", description: "异常包裹要挨个在物流系统里查询跟进", keywords: ["异常包裹", "物流系统", "跟进", "查询"], frequency: "daily", minutesPerRun: 45 },
      { id: "wh3", description: "盘点差异要手工整理成表", keywords: ["盘点", "差异", "整理"], frequency: "monthly", minutesPerRun: 180 },
    ],
  },
  {
    id: "marketing",
    role: "市场推广专员",
    background: "负责投放数据的日常汇总，要从几个广告平台导出数据、计算转化成本，再给老板发日报。",
    style: "数据敏感，会主动给数字",
    hiddenPainPoints: [
      { id: "mk1", description: "多个广告平台数据要手工导出再合并", keywords: ["广告", "导出", "合并"], frequency: "daily", minutesPerRun: 60 },
      { id: "mk2", description: "转化成本每天手工计算", keywords: ["转化成本", "计算", "手工"], frequency: "daily", minutesPerRun: 30 },
      { id: "mk3", description: "投放素材的效果对比要做成 PPT", keywords: ["素材", "PPT", "对比"], frequency: "weekly", minutesPerRun: 120 },
    ],
  },
];

/**
 * 变体：同一个人设，但说不清每件事要花多久。现实中很常见，用来检查访谈会不会为了耗时反复追问。
 * 评测"量化完整度""耗时是否已知"时，这几个人设的耗时已知比例本来就该低，不要拿它和其他人设放在一起比。
 */
const vague = (id: string): Persona => {
  const base = BASE_PERSONAS.find((p) => p.id === id)!;
  return { ...base, id: `${base.id}-vague`, style: `${base.style}；对每件事花多久没什么概念`, cannotEstimate: true };
};

export const PERSONAS: Persona[] = [...BASE_PERSONAS, vague("sales-ops"), vague("finance-accountant"), vague("hr-recruiter")];
