# 独立 Prompt 调试工具

## 当前状态

已实现、验证并上线：独立工作台、Provider/凭据管理、Case 库、共享集合、运行选择、语言路由、JSON/JSONL 导入导出，以及代码/模型评估指标、批次指标选择、生成/评估生命周期、汇总与单条评估详情。用户于 2026-10-21 在页面稿融合审阅后授权实现；前端已用隔离服务与本地 fixture 完成真实浏览器验收，未使用真实 JEV 凭据，也未对历史批次补评。
正式入口为 `http://127.0.0.1:8787`；已完成用户数据安全迁移和最终只读浏览器验收，无必需待办。
本记录只保留当前范围与行为；构建、迁移、备份、进程和截图细节见末尾证据链接。

## 目标与范围

- 将 LLM 纠错/翻译环节从 Eve 全链路中隔离，复现坏例、迭代 prompt 并检查回归；输入不限于 ASR。
- 独立本机 Web 工具，不依赖 Agent Evals 账号、平台数据库、队列或模型目录。
- Go 服务与本地 SQLite 持久化，浏览器资产嵌入可执行文件。
- 原样使用 Go `text/template`：保留 if、range、空白裁剪及标准 map 遍历语义。
- 模板保存有序角色/消息；预览与执行共用真实渲染器，不以手工拼接 prompt 替代。
- 多组对照配置由用户显式添加，不自动生成模型、模板与参数的笛卡尔积。

## Provider、凭据与安全

- Provider 的品牌/模型与协议分离；目录只列真实实现的协议，目前为 OpenAI Chat Completions。
- 协议适配器负责 endpoint、method、非秘密 headers、请求编码、运行时认证与响应解析。
- 手动密钥优先于配置的环境变量；未修改密码保留原值，明确 Clear 后才回退 env。
- 手动密钥按不可复用的凭据引用独立加密；数据库与私有 keyfile 必须配对备份，缺失/错误时安全失败。
- 删除 Provider 默认保留历史凭据引用；撤销需 Clear，可与删除原子提交；同 ID 重建不得继承旧引用。
- 密钥不进入可读 state、快照、请求日志或导出；上游回显已知密钥须脱敏。该保护不抵御能读取 DB 和 keyfile 的同一 OS 用户。
- 仅监听 loopback，校验 Host/Origin；模板不暴露文件、进程或网络执行函数。

## Case 与共享集合

- 当前 Case 只有系统生成的随机 ID 和输入 variables，无 name/description 或替代名称。
- 页面使用短 ID 与 CurrentText 摘录辨认，可复制完整 ID；允许手工创建同内容的独立副本。
- CurrentText、PriorText、SourceLanguage、ReplacementMap 及自定义变量属于输入；TargetLanguageNameMap 不属于 Case，表单和高级 JSON 均禁止覆盖。
- 表单与高级编辑操作同一变量对象；派生 variables_json、字段 patch 和纯投影接口保留未知数值字面量、类型、CRLF 与数组顺序。
- 集合是人工维护的多对多共享引用；支持搜索、分页、全部筛选结果选择和批量成员增删。
- 编辑共享 Case 影响未来使用，不改冻结历史；删除集合不删 Case，删除 Case 清理当前集合/草稿引用。
- 通用 state 保存不拥有 Case/集合输入，避免无关设置或模板保存改写数据；过期保存/预览/导入返回409。

## 运行选择与语言路由

- 显式 Case IDs 与集合成员按 ID 求并集，再减本次临时排除；应用选择不启动调用、不改集合。
- 后端权威解析选择与请求数；预览/开始均检查 state_version，开始时冻结最终 Case 与选择来源。
- 集合名称、原始成员及选择 IDs 一并冻结，历史展示不读取当前集合补写来源。
- 每组独立维护精确原始 SourceLanguage→目标列表；不修剪或将 zh-CN 归一化为 zh。
- 同组源规则唯一、目标非空且键唯一；支持自定义目标键/名称，保留 jp，不隐式改为 ja。
- 未匹配源语言固定使用 en/English；缺少 en 规则时仍执行 en→en，不跳过输入。
- 渲染在输入副本上注入有效 TargetLanguageNameMap；冻结规则、原始源、有效目标和默认标记。
- 多目标同次请求生成，不乘调用数；27 Case×20次×2组为1080次请求。

## 执行与不可变历史

- 新设置默认每 Case/组20次，允许覆盖；升级保留用户现有设置，不重置为默认值。
- 一个活动批次，全局最多20个在途调用；按轮次/Case/组交错派发，无自动重试、参数删改或模型回退。
- 区分未发送参数与显式 null、none、数值；失败保留原始 HTTP/解码错误。
- 刷新页面不停止批次；停止仅取消未派发工作，在途请求收尾并持久化。
- 历史冻结输入、角色消息、配置、endpoint、实际请求字节/哈希，保存原始响应及请求/返回模型身份。
- 复跑从冻结快照创建新批次，仅重新解析原凭据引用的当前可用密钥；原需认证的请求不得匿名降级。
- 重启将未完成工作标为中断/结果未知，不自动重发；数据目录独占锁防止多进程改写。
- 旧历史保留当时的名称、ID、请求体及哈希，不为匹配当前 Case schema 重写。

## 导入导出与迁移边界

- 仅支持标准 CASE/COLLECTION JSON、JSONL 包；导出不含 Provider、凭据、路由或运行记录。
- 指纹覆盖完整输入，仅规范对象键序；不规范文本、标点、数组顺序、数值字面量或类型，null 与 [] 不等价。
- 导入只新增/复用，不按文件 ID 更新现有 Case；相同输入复用，不同输入生成随机本地 ID。
- 文件 Case ID→本地 ID 映射恢复成员；批内与重复导入幂等。同一文件 ID 指向不同输入或悬空引用整包拒绝，不部分写入。
- 集合按文件集合 ID 复用，保留已有本地名称，仅补成员；不按名称合并不同集合。
- 可选导出成员关系按已导出 Case 裁剪，另保留显式空集合；不因共享集合拉入未选 Case。
- 旧包名称/描述/Case 目标映射及整份 state/run 日志显式报错，不作静默转换。
- 已有数据库升级先私有归档/配对备份，再随机化当前 ID/引用并将可表示目标映射提升为各组路由；冲突预检时保持旧服务在线。
- 已完成迁移保留实际用户输入、设置、模板角色/消息、Provider/凭据及历史；生产数据未插入设计示例或测试批次。

## 明确排除与验证边界

- 不做 CSV/Excel、任意 Eve 日志解析、从结果自动收集 Case、完整音频/TTS 链路或自动质量评分。
- 不将运行记录当作平台 RESULT，也不强制采用平台模型目录；不把语言混杂检测扩展成质量评价平台。
- 上述自动评分排除项由 2026-10-21 用户提出的[评估扩展](#评估扩展设计澄清中)取代；其余排除项不变。下文既有验收仅覆盖原功能，不是评估功能的验证证据。
- 后端 race/真实 HTTP、迁移前后请求字节、隔离交互及最终只读浏览器验收已通过。
- 验证只用本地 fixture/无调用预览；未验证或宣称真实模型权限、输出质量，未发起付费模型调用。

## 领域与证据

- [领域术语](../../GLOSSARY.md)、[安装与使用](../../README.md)。
- [通用 API 与安全契约](../api.md)、[Case/集合/路由/包契约](../case-api.md)。
- [后端与最终迁移/上线证据](../case-backend-check.md)、[Case 交互与最终用户截图](../case-ui-check.md)。
- [既有协议/凭据后端证据](../backend-check.md)、[既有工作台/凭据 UI 证据](../ui-check.md)。
- [确认的 Case 工作流设计图](../ui/case-workflow/)；图中数量是示例，不是生产种子。

## 评估扩展（已实现）

### 已确认范围与来源

来源：2026-10-21 用户发起 grill-design，并回答两轮设计问题；本轮完成产品边界澄清，尚未授权实现。

- 保持本机工具轻量，增加 Metric 配置；指标属于执行配置，每次执行是单次“原子评估”。不设计独立历史补评或历史回填。
- 用户选择“保留输出与各指标结果”：一次执行包含生成及全部评估，全部步骤收尾后结束；单个指标执行错误不丢弃已成功部分，不因此停止其他指标或整个批次，不自动重试外部调用。外部请求和费用无法回滚。
- 代码指标采用受限 JavaScript。提供固定输入/输出契约及可复制给用户外部 AI 的脚本生成 prompt；具体运行时及资源限制尚未选择。
- 模型指标暂只接入 SystemOne JEV，通过自然语言配置判断逻辑。用户声明 `.env` 已配置 `TYPESAFE_API_KEY`；未读取或验证密钥。
- 实现阶段再查阅 [Typesafe 官方文档](https://docs.typesafe.ai/introduction/quickstart)，优先使用 typesafe SDK；SDK 语言、JEV 可用结果类型与实际接口均未核实，不预设供应商支持任意返回结构。
- 指标返回支持布尔、数值和分类标签。
- 评估对象由用户显式选择整段输出或 JSON 字段，平台统一取值；不依赖模型猜测目标字段。
- 用户选择“整个批次统一选择”：所有对照组使用相同指标和字段配置，不支持各组独立勾选。领域术语见 [Metric](../../GLOSSARY.md#metric评估指标)。

### 已观察事实

- `internal/workbench/model.go:93–168` 保存冻结 Case、请求、语言解析结果及每次生成输出；`engine.go:337–350` 的 completed 仅代表生成请求及协议解析成功。
- 用户示例 `/Users/tmk/orca/workspaces/agent-evals/drum/scripts/evaluation/tmp_run_luna_prompt_base.py:302–322` 解析 JSON 并检查指定翻译字段中的汉字字符，跳过 jp，不检查 corrected_text；这是字符检测，不是中文语言识别。本轮仅阅读，未运行其付费模型调用。
- 原架构指导描述的根目录 Go 文件和前端全局脚本已过时；当前结构以代码及 `architecture-refactor.md` 为准。

### 建议契约与职责（设计推导，非额外用户确认）

- Metric 配置负责名称、执行种类、返回类型、代码或自然语言规则；批次配置负责指标选择及目标字段。开始时冻结完整规则和目标选择，不从后续编辑读取评估依据。
- 评估输入来自本次冻结 Case/语言上下文及生成输出；后端统一提取整段输出或 JSON Pointer 指定字段。代码与 JEV 消费同一目标，不接触凭据。
- 代码函数建议 `evaluate(input) → { value, reason? }`，value 类型必须对应布尔、有限数值或分类标签；分类建议配置固定标签集。JavaScript 不暴露文件、网络、进程或环境接口，执行资源必须受限；具体引擎及隔离有效性需实现阶段验证。
- 可复制的外部 AI prompt 包含用户规则、函数契约、运行限制、返回值要求及合成示例；不默认复制真实 Case 数据或凭据。
- 指标值与执行状态分离；布尔不默认把 true 解释为通过。数值不擅自归一化或生成通过阈值，分类按声明标签汇总。
- JSON 解析失败、字段缺失、脚本异常、非法返回值、JEV 请求失败分别保留错误；不猜字段、剥离 Markdown 或自动转字符串。不阻止其他独立指标执行。
- 按指标分别统计有效判断数；布尔 true/false 分布、数值均值与范围、分类标签分布。错误/取消/跳过/中断单列，不混入有效分母；不因一项失败丢弃同条输出上其他有效判断。
- 生成失败时不调用内容指标；停止后不再启动新生成或指标工作，已发出调用收尾，其余步骤标取消；重启未完成步骤标中断，不自动重发。生成与评估状态、进度需分别可见，不能只增加指标配置而不提供结果和汇总。
- 实际执行以服务端为所有者，浏览器关闭不终止；不另建独立补评调度入口。已存在的生成结果/历史内容不得破坏，“不考虑历史包袱”不等于授权删除真实数据。

### 场景推演与后续验收（未执行）

- 对 `{"corrected_text":"中文原文","en":"Hello"}` 选择 /en，代码汉字检测返回 false，不受 corrected_text 干扰；/en 含汉字则返回 true。JEV 的语义判断需独立实测，不能以代码规则替代真实模型证据。
- 同一输出上的代码指标完成、JEV 超时：保留输出、代码判断及 JEV 错误，继续其他工作；JEV 失败不计入其有效判断分母。
- 不同对照组使用同一字段配置；某组缺少 /en 时明确报取值错误，不偷偷改查其他字段。多个重复生成分别关联自己的指标结果。
- 指标运行中修改规则，不改变本批次快照；停止/刷新/重启不造成隐式重新调用。数值 NaN/Infinity、越界分类返回不能混入有效汇总。
- 单批多指标的模型调用数必须在启动前可见；按成功生成数和所选模型指标数说明调用上限，实际 SDK 请求计费单位需供应商文档确认。

### 交接与限制

- 2026-10-21 用户继续授权核对 SDK/JEV 契约及 JavaScript 运行边界，再判断是否调整方案；没有授权产品实现。
- 已完成官方文档研究与仓库外隔离 smoke。未读取 `.env`、未验证凭据、未请求真实 JEV；供应商可用性和判断质量仍未验证。

### 集成可行性核对（2026-10-21）

#### Typesafe / JEV：已观察证据

- [官方 SDK 目录](https://docs.typesafe.ai/sdk.md)仅列 Python 与 JavaScript/TypeScript，其他语言可直接使用 HTTP API；没有列出官方 Go SDK。[Quickstart](https://docs.typesafe.ai/introduction/quickstart.md)要求 Python 3.10+ 或 Node.js 20+。
- [System One API](https://docs.typesafe.ai/api/system-one.md)：`POST https://api.typesafe.ai/v1/systemone`，Bearer 认证，输入 `model,state,questions`；返回 `model,answers,usage`。可在一个请求包含多个问题，但每个问题没有独立的 state。
- [Noul](https://docs.typesafe.ai/primitives/noul.md)返回 yes 概率 `noul∈[0,1]`，不是 boolean，也没有独立 confidence。布尔需要平台根据冻结阈值转换，并保留原始概率。
- [Score](https://docs.typesafe.ai/primitives/score.md)需要有序描述等级；文档建议至少两级，最多十级。原生 score 为等级位置的概率加权均值，范围为 `0..等级数−1`，允许小数；不是任意量纲的精确测量或自由 0–100 分。
- [Choice](https://docs.typesafe.ai/primitives/choice.md)从配置的有限选项中选分类，返回 choice、probabilities、confidence；Score 也返回分布和 confidence。三者均不提供自由生成的 reason/explanation，不能伪造模型评语。
- [官方已知限制](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)明确 1.13 不适合精确计数/算术，不能将评分插值当作精确测量；对抗性输出可能影响判断。确定字符存在性优先代码，语义判断才使用 JEV；上述限制有版本范围，不能直接推断其他版本完全相同。
- 官方 SDK 有默认自动重试；[JS RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md)与 [Python retries](https://docs.typesafe.ai/sdk/python/api/retries.md)均默认追加两次。接入必须明确关闭重试，不能违反已有执行契约。
- [模型文档](https://docs.typesafe.ai/models.md)区分版本和可变 alias。建议冻结版本并记录实际 response.model；当前文档的 alias 表与版本发布列表不完全同步，不在未调用 API 时断言账户可用版本。

#### JavaScript：隔离 smoke 结果

在仓库外 `/tmp/promptbench-eval-feasibility-OpIWy5` 创建独立 Go module；仓库 go.mod/go.sum、真实数据和服务均未修改。使用本机 Go 1.27.1/darwin-arm64；未验证 Go 1.25 最低版本及其他平台。

- `modernc.org/quickjs v0.24.2`：纯 Go 的 QuickJS 转译实现。设置 `SetMemoryLimit(16<<20)` 与 `SetEvalTimeout(200*time.Millisecond)`，不启用模块加载器或 host 函数。
- 正常指标返回 `{"value":true,"n":42,"label":"mixed"}`，约 1ms。
- 无限循环约 200ms 返回 `InternalError: interrupted`；高回溯正则约 201ms 同样中断。
- 连续数组分配约 70ms 返回 `InternalError: out of memory`；上述错误后 `Close()` 均返回 nil。
- `std,os,require,process,loadFile,fetch,console` 均为 undefined；导入 `qjs:std` 返回不能加载模块。探针未穷举引擎漏洞，不宣称完整安全认证。
- `CGO_ENABLED=0 go run sqlite_probe.go` 成功同时使用现有版本 `modernc.org/sqlite v1.39.1` 和 QuickJS，并在 VM 关闭后读回 SQLite 写入值 `preserved`。不是仓库完整回归测试。
- QuickJS 会升级共享依赖（libc 1.66.10→1.75.4、memory 1.11.0→1.12.1 等）；实现阶段必须跑仓库回归，不能以共存 smoke 替代。引擎内存额度限制 QuickJS allocator，不是整个进程 RSS；仍需输入/输出尺寸和并发限额。
- 不采用 Goja latest 作为进程内沙箱：实际死循环可 100ms Interrupt，但没有独立 JS heap 硬额度；当前 latest 还要求 Go 1.26，高于项目最低版本。
- 不采用 `fastschema/qjs v0.0.6` 原样接入：实际默认 std/os 可见且读取到临时目录中的合成 sentinel；源码默认将 CWD 挂载到 WASI，超时后的清理路径实际 panic。直接自管 wazero、禁用目录挂载和设置线性内存上限可阻断该读取，但增加 ABI/构建维护，没必要优先于已通过基本 smoke 的 modernc QuickJS。

#### 已确认调整与实现建议

- 用户于本轮可行性问答选择“Go 直连 REST”：采用 Go 标准库调用官方 API，不增加 Python/Node SDK 服务进程。该决定取代原先“优先 SDK”的偏好，JEV 提供者不变。
- 用户选择“采用原生语义”：模型布尔使用 Noul＋可见、可配且冻结的阈值，初始 `p>0.5`，保留概率；模型数值使用描述等级及原生量程，不换算百分制；精确测量使用代码指标，分类配置标签描述。
- 共同结果保留 value；reason 只作为代码指标的可选字段。JEV 记录其原始概率/分布/等级及模型版本，不生成假 reason 或把 confidence 当作正确率。
- 模型指标先按独立指标请求，以自然满足显式字段、部分失败保留和单项错误隔离；同 state 多问题合并是可选优化，不把它当作正确性前提。
- JavaScript 推荐 `modernc.org/quickjs v0.24.2`，每次独立 VM，禁止 host 桥与模块加载；时间、内存、输入输出和并发额度由服务端统一限制。具体额度待实际输入规模确定，不设为用户任意放大的沙箱逃生选项。
- 产品边界与上述接入调整已确认，无需继续就 SDK 或评分量程提问。下一步可由用户选择进入有界实现；当前授权仍为设计和可行性核对。真实 JEV 端到端与完整安全/迁移/浏览器验收尚未完成。

#### Provider 归属（用户于 2026-10-21 补充确认）

- Typesafe 应作为 Provider，与现有 Luna、4o 连接在同一管理入口配置；JEV 是 decision model，仅用于模型指标，不参与纠错/翻译生成。该决定取代将 JEV 视为评估模块内独立特殊连接的隐含方案，不改变 Go REST 接入决定。
- 复用现有 Provider 的地址、api_key_env、credential_ref、手动密钥覆盖及脱敏机制，不把 TYPESAFE_API_KEY 或 endpoint 硬编码进指标。模型指标引用 Provider 并配置 JEV 模型版本；代码指标无需 Provider。
- 建议由已实现的协议能力决定用途，界面区分生成/决策；不让用户任意勾选不受支持的能力。Group 下拉只列生成能力 Provider，模型指标下拉只列决策能力 Provider，后端同样校验，不能只靠前端过滤。
- 当前 `Protocol.Prepare` 接收 messages、`Decode` 返回文本，见 `internal/workbench/protocol.go:40–46`；这是生成契约，不能强行将 JEV 的 state/questions/typed answers 编造成聊天消息和文本输出。共享 Provider 配置和认证，不要求共享生成/决策请求接口。具体接口拆分属于实现阶段，不做无关协议框架重构。
- 批次冻结指标所用 Provider 的非秘密配置、凭据引用和 JEV 模型配置；运行时解析凭据，沿用现有不将密钥写入快照的原则。
- 候选验收（未执行）：Typesafe Provider 只在模型指标选择器可见，不在生成组中可选；手工向生成 API 提交该 Provider 也被拒绝；JEV 凭据缺失时开始前明确报错，不在已发出生成后才发现本地配置错误。Luna/4o 生成行为不变，代码指标不要求 JEV 凭据。
- 本轮仅核对当前类型与协议接口、更新领域和任务记录，未修改产品代码或执行功能验证。

### 评估页面稿（2026-10-21）

用户授权先做 Pencil 页面设计，尚未授权产品实现。沿用当前 Pencil 中“Promptbench · 当前实现参考”的浅色、蓝色操作和侧边栏风格；保留原参考 frame `iYftN`，新增可编辑桌面稿，按三列四行排列在参考稿右侧。

- Pencil 文档：`/Users/tmk/.pencil/documents/1714fda5-1247-4b0e-920e-49193c6ccc7c/untitled.pen`。
- PNG 导出目录：[docs/ui/evaluation](../ui/evaluation/)。配置管理页为 1536×1050；完整工作台状态页为 1536×1860，凭据缺失状态为 1536×1940。设计中的输出、数量、凭据可用状态、概率及模型版本均为示例，不是生产数据或真实 JEV 检查结果。

| 页面 | Pencil frame / PNG | 覆盖内容 |
|---|---|---|
| 01 代码指标 | [LwK8b](../ui/evaluation/LwK8b.png) | 指标列表、名称/类型、规则、JavaScript、复制 AI 提示词、本地试算 |
| 02 模型布尔 | [cE4zJ](../ui/evaluation/cE4zJ.png) | 决策 Provider、模型版本、自然语言规则、Noul 概率阈值 |
| 03 模型数值 | [w4x4mI](../ui/evaluation/w4x4mI.png) | 有序描述等级、增删等级、原生量程 |
| 04 模型分类 | [Gi9bp](../ui/evaluation/Gi9bp.png) | 固定标签及描述、增删类别 |
| 05 Provider | [J2uvps](../ui/evaluation/J2uvps.png) | 统一连接列表、生成/决策标记、Typesafe 协议、地址及凭据 |
| 06 批次配置 | [wnBzY](../ui/evaluation/wnBzY.png) | 原模板编辑、Case 预览、对照组、请求预览和执行入口；执行前嵌入批次指标及字段选择 |
| 07 评估汇总 | [ph5kr](../ui/evaluation/ph5kr.png) | 保留完整工作台，仅切换下方原输出区域的“评估汇总”标签；有效分母及组间比较 |
| 08 单条详情 | [ycphq](../ui/evaluation/ycphq.png) | 原输出列表增加评估摘要；原右侧详情新增“评估”标签，保留输出/请求/响应/详情 |
| 09 AI 提示词 | [sHwam](../ui/evaluation/sHwam.png) | 可复制规则/函数契约/限制、不包含真实 Case 或密钥 |
| 10 执行中 | [Z6IIaB](../ui/evaluation/Z6IIaB.png) | 原运行按钮切换停止、原输出区域展示生成/评估进度及停止确认 |
| 11 首次使用 | [tr68F](../ui/evaluation/tr68F.png) | 指标空状态与代码/模型创建入口 |
| 12 启动受阻 | [EbqXd](../ui/evaluation/EbqXd.png) | 原工作台指标区域就地显示决策凭据缺失，原运行按钮禁用并提供修复操作 |

用户于后续审阅指出页面稿脱离现有工作台逻辑。先前将工作台简化成独立概览/执行页面的布局方案已被取代；当前 06/07/08/10/12 直接以原参考稿主体为底，保留模板编辑、Case 预览、对照组、右侧请求预览、原运行设置与按钮、下方输出分栏。指标在运行按钮之前配置，汇总与单条判断分别进入原输出标签与原详情标签，不创建第二套执行入口。独立指标管理与 Provider 页面不受此次调整影响。

检查清单：已逐页截图检查版面；新增指标区、输出汇总标签、单条评估正文、停止确认、凭据错误区域的最终边界检查未报告裁切，已修复新增标签的 fit/fill 循环宽度。原参考稿已有的 JSON 横向视口/固定文本裁切保留，不将其计作本次修复或声称全页零裁切。已重新导出五张工作台状态页，并查看完整尺寸的 06 导出，确认原工作台内容与新增评估区域共存。

边界：静态、可编辑的 Pencil 页面稿，不是可点击应用或已通过浏览器验收的实现；尚未获用户逐页确认。未绘制移动端、所有下拉展开或加载/断连等既有通用状态的独立稿。当前工作台用两项指标演示批次选择；数值与分类的编辑契约保留在 03/04，具体选中项应驱动汇总与详情显示。下一步为审阅融合后的工作台稿，再进入实现；未修改产品代码。

### 实现与验证（2026-10-21，取代上述“仅设计/未授权实现”状态）

- 用户随后明确授权实现当前 SPEC/UI，并要求保留原工作台结构；本记录上方“尚未授权实现”“当前授权仍为设计”“未修改产品代码”等句子只描述当轮历史状态，不再是当前状态。
- 前端实现：指标导航页与可复用 CRUD（代码/模型，布尔/数值/分类）、代码试算、可复制的 AI 提示词、Provider 能力标签与生成/决策过滤、批次公共指标选择与整段输出/JSON Pointer、模型调用上限与预检错误、原运行按钮、独立生成/评估进度与停止确认、评估汇总标签、结果行评估徽标及原详情面板的评估标签。未另建执行页面。
- 后端由独立工作流实现并通过其全套测试与独立 smoke；接口以 [API 评估指标契约](../api.md#evaluation-metrics)为准。已有历史记录不补评，停止/重启语义与执行原子边界见该契约。
- 前端真实浏览器验收：隔离应用 + 本地 OpenAI/JEV 形状 fixture，完成 Provider/指标 CRUD、代码布尔 true/false/数值/分类试算、AI 提示词、8 次生成/32 次评估（24 完成、8 个故意 Pointer 错误）、汇总与 Case 筛选、单条评估详情、停止确认、离线保存失败重试、外部版本冲突后重载重置、选中指标删除与草稿引用清理。追加两对照组批次（12 生成/48 评估）：组筛选分别得到 8/12 与 4/12 条，汇总有效分母随组变化；延迟 fixture 下确认停止后批次为 stopped（24 完成、24 取消，无 pending/running），12 条生成输出与已完成指标结果保留。 已完成/已停止详情重新载入后运行按钮恢复可用且不显示伪活动提示；真正有其他批次运行时仍禁用为“批次运行中”。未验证真实 Typesafe/JEV 凭据、可用版本或判断质量；未产生付费调用。
- 证据：[前端浏览器验收与截图](../evaluation-ui-check.md)、[后端实现证据](../evaluation-backend-check.md)、[实现截图目录](../ui/evaluation-implementation/)。
