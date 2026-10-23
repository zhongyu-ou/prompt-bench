# 验证与研究证据

本文保留特定历史版本中不可由当前契约替代的检查、测量、研究来源和资产出处，不是当前通过报告或执行日志。当前行为见 [API](../api.md)、[Case API](../case-api.md) 与[架构](../architecture.md)；下一次怎么验证见[验证指南](../verification.md)；用户迁移、原始归档和字节比较见[迁移证据](migrations.md)。

来源为原 `docs/backend-check.md`、`case-backend-check.md`、`evaluation-backend-check.md`、`ui-check.md`、`case-ui-check.md`、`evaluation-ui-check.md`，另保留已完成 `docs/tasks/architecture-refactor.md` 的非重复证据。旧文件名与临时路径是血缘，不是当前操作入口。

## Evidence boundaries

- 所有执行/浏览器验收使用合成本地上游；真实用户服务只读检查不调用 Provider。没有真实 Typesafe/JEV 可用性、账户模型访问、认证、语义质量、账单或 alias 长期稳定性证据。
- 传输/类型/生命周期 fixture 通过不证明模型遵循指令。字符检测不是语言识别，不能用代码结果替代真实模型质量评估。
- API 自动化、实际 CLI、浏览器、静态 Pencil 各自只证明其观察层。原记录未绑定不可变 commit；以下日期和阶段用于限定来源，不能将历史通过延伸到当前 checkout。过期文件名/SQLite 启动命令不是当前流程。
- 浏览器工具未提供可信 OS 下载管理器/落盘文件事件：确认过 HTTP export、attachment/Blob 文件名/类型/字节及 round trip，不声称文件进入用户 Downloads。
- 受控延迟/拦截、合成 409/503 是处理路径证据，不是自然供应商事故。明确区分应用异常、Chrome 扩展/relay 信息和自动化等待器错误。

## Core execution, credentials and Case acceptance

原记录包含旧 SQLite 阶段的 Go/race、嵌入构建、真实 CLI 和 Chromium 验收，以及 2026-10-22 的 PostgreSQL 原始变量导入检查。可重复检查已归入[验证指南](../verification.md)。

| 范围 | 历史观察 | 证据限制 |
| --- | --- | --- |
| 请求与历史 | preview/sent/persisted bytes/hash 相等；编辑或删除当前配置后冻结重放不变；omitted/null/0/字符串及大整数不混淆；HTTP422、decode failure、非 UTF-8 响应保留 | 只覆盖本地 fixture，不证明真实 Provider 或模型能力 |
| 调度 | 全局20上限、单执行409、Stop保留已发出并取消未发出；CLI混合8请求得到4成功/4 HTTP422，replay保持相同冻结请求 | 已发出请求仍可能计费；本地试验不建立真实供应商账单语义 |
| 凭据与安全 | synthetic env→manual→clear、错误覆盖不降级、历史ref不复活、在途key冻结；GET/export/SQLite无合成明文；密码重开为空，失败/409保留待提交值；HTML注入保持文本 | 原真实用户库没有加密手动凭据行，非空保密/迁移结论来自合成测试 |
| Case、范围与路由 | 隔离150Cases、集合合并去重/排除与精确/default路由；Case/collection/import写入保留并发dirty编辑；变更Case/路由后冻结请求不变 | 合成库存不是用户库存；选择和预览不创建运行 |
| 数字与导入导出 | `1.50`、`9007199254740993`、大整数、CRLF、null/[]及字符串类型保留；membership-only save不改变量字节；JSON/JSONL重导入复用，空集合保留、成员范围不扩大；非法混合批次原子拒绝 | 验证到HTTP/Blob与round trip，没有可信OS下载落盘事件 |
| 原始变量导入 | 2026-10-22在隔离PostgreSQL实际操作raw object/array/JSONL与文件上传、标准包reuse；后续required修订拒绝缺SourceLanguage/空白CurrentText，合法输入补空PriorText/ReplacementMap | 早期单字段输入案例不能证明后来的required规则；后续列布局检查只是render-only，未再次导入 |
| 浏览器异步与布局 | 真实桌面/390px导航、对话框、保存/预览/Stop/历史/比较；延迟save/preview不覆盖新编辑，轮询保持选择/焦点/滚动；JSON大数/escape和原文复制实际检查 | 静态稿比较不是pixel/font自动diff；clipboard-denial未测；两次Chrome扩展/relay连接信息无应用栈，不能概括为所有session零错误 |

迁移时点的4条真实输入/零历史，与后续PostgreSQL导入14批次不是同一库存；备份、字节比较及只读用户验收保存在[迁移证据](migrations.md)。历史截图出处见[资产来源](#historical-asset-provenance)。

## Architecture refactor evidence

来源：已完成 `docs/tasks/architecture-refactor.md:29–59`，记录模块拆分时的检查，不能作为今天资产数量/样式的断言。

- 集成所有者记录 `go test -race ./...` 通过（3.137s）、Go vet exit0、gofmt 无输出，临时构建与 `--help` 成功。
- 实际服务所有 29 JavaScript/21 CSS 资产均 HTTP200/MIME 正确；29 JS 语法检查通过。仓库外临时 Acorn/scope 分析得到29个无环模块、无 unresolved application identifiers；没有把分析依赖加入项目。页面 global `App`/`apiRaw` 均 undefined，无 import/init/missing-asset/app unhandled error。
- 新 `/tmp/promptbench-frontend-gTgpmm` 数据目录，app8789、fixture9798/600ms，只启用本地组。Provider/group/zh-CN→jp/settings/draft/preview、Case/collection CRUD、lossless projection、JSONL reuse、409 recovery、在途 save/preview dirty guards 均经过浏览器。
- 实际8/8 fixture run，preview/frozen/persisted raw bytes 相等；冻结 replay→Stop 留1已发出完成、7未发出取消。历史/比较/输出和 snapshot tab 可用。
- JSON/JSONL 实际 UI-created Blob 保留 `9007199254740995`、`0.0001000`，JSON 重预览两条均 existing；没有 OS 落盘证据。
- 1440×1100 和390×844，对1797个 DOM elements 的 computed styles 与原 stylesheet 比较零差异（排除 transient toasts），无 document 横向溢出。一个自动化 isolated-world 测试属性探针自身出错后移除，最终 rebuilt-page diagnostics 无错误。

| 原始本地证据 | 2026-10-23 既有 metadata-only stat |
| --- | --- |
| `/tmp/promptbench-frontend-gTgpmm/frontend-evidence.json` | regular file，9974 bytes；原记录称含 import graph、run IDs、精确 Blob、diagnostics 与截图位置 |
| `/var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/omp-sshots-15aeb022cbc1da13.webp` | desktop regular file，43156 bytes |
| `/var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/omp-sshots-15aeb0226d01da12.webp` | mobile regular file，13830 bytes |

这些尺寸/存在性来自原 task 的明确观察，本次没有重新 stat 或打开内容；不等于 durable backup、内容复验或现在仍可恢复。临时目录生命周期是保留风险。原集成所有者当时独立查看过结构证据与截图。

## Inline evaluation acceptance, 2026-10-21

这是 **被独立评估取代的生成时内联模型**，不应把当时“缺决策凭据阻止生成”“replay 同时评估”移作当前只生成行为。Go1.27.1/darwin-arm64；loopback fixtures、合成 `fixture-only-secret`、临时 HOME/data，无真实 env/key/paid call。

| 验证层 | 历史观察与限制 |
| --- | --- |
| 代码指标 | Go/race与无CGO构建通过；覆盖严格返回类型、无host/import、200ms中断、16MiB OOM后新VM可用、UTF-8边界与intrinsic tampering。一次race暴露ASCII输出计数开销，修复后边界回归通过，没有放宽限额。后续极值均值修订只有focused race证据，不冒充再次全套 |
| JEV传输 | 本地POST/auth/native typed data、严格 `0.5 > 0.5 == false`、超时/oversize/redirect/脱敏；只发送所选target，不泄漏其他字段。混合生成/决策上游峰值观察在1以上且不超过20 |
| 实际CLI | 一次内联生成得到4个completed指标与1个NaN错误，values为 `[false,true,1.4,"greeting",null]`，保留Noul0.8和 `jev-fixture-version`，没有捏造reason；改当前规则后冻结replay仍使用旧规则 |
| 旧生命周期 | 当时缺decision key会阻止生成；Stop保留已发出与完成结果；SIGKILL后重启将未结束判断标interrupted，fixture调用不增加。这些是旧耦合执行观察，不能推广为现行只生成/独立评估语义 |
| 浏览器 | loopback双协议fixture下，8次生成×4指标得到24completed/8故意pointer错误；双组12次生成/48判断的分母按组8/4变化；Stop保留24completed并取消24未发出判断。CRUD、合成试算、保存失败/冲突、过滤/分页/键盘/preview均检查过，false/0/分类不与执行错误混淆 |

浏览器使用 `/tmp/pb-eval-ui` 与自建fixture，没有新增项目npm依赖，未证明OS下载落盘。临时CLI脚本 `/tmp/promptbench-evaluation-smoke.py` 与二进制 `/tmp/promptbench-evaluation-smoke-bin` 原记录明确已删除；原临时目录 `/var/folders/zv/lc60y2p53_d0_69htm8jkz0r0000gn/T/promptbench-evaluation-smoke-m295r5h2` 仅为来源，不保证可恢复。其余资产出处统一列在文末。

## Independent evaluation and contracts, 2026-10-23

### 后端

Go1.27.1/darwin-arm64；隔离Docker `postgres:18-alpine`，loopback55438。自动化使用 `promptbench_test` 的新per-test schemas，CLI另用 `promptbench_backend_smoke_test`；没有修改用户配置/数据。全套 `go test ./...`、race与Go vet均记录通过，前端稳定后再次race通过。该记录没有建立最低Go版本或其他平台兼容性。

- 公共 impact/preview/start/save/replay 路径保护 nested required/nullable/type、不 coercion/default、extra fields、Case/JSON Pointer error、`9007199254740993` 与巨大正负 exponent 词法；影响无副作用、历史冻结不变。
- 100 successful generations→5 rounds＝500 code judgments，不新增 generation、不读 decision key；改当前 Case 不影响 frozen source/iteration；subset、stale version、100000 product limit 有回归。
- independent statuses、partial failure/redaction、冻结 evaluation replay 与 generation-only replay 分开；missing target不发decision；Stop已issued judgment收尾并取消7项，原3 generation outputs仍成功。
- atomic shortcut server-owned queue、missing key/zero successful explicit child failure、queued stop/restart无意外派发、global20、internal500 vs404/400/409均有测试。schema forward/recovery byte evidence 见[迁移记录](migrations.md#postgresql-schema-1-to-2-2026-10-23)。

真正 CLI 于8891、临时 YAML/key、计数fixture，没有浏览器负责 chaining：只生成2/decision0；单输出3轮 code `[2,2,2]`；改当前rule后 frozen replay仍 `[2,2,2]` 而current execution `[99,99,99]`；快捷启动生成后server自动4 judgments；重生成无child，最终 generation6/decision0；export snapshot等于原detail。它只覆盖code metrics，不证明真实JEV。临时 script/config/binary 和 backend smoke DB 原文明确已删除。

原记录确认前端app/fixture/browser停止、专用browser/backend smoke数据库及所建Docker容器/匿名volume清理完成；55438不是可继续依赖的现成环境。清理信息不构成用户服务的部署或迁移证明。

### 单次评估简化：后端（2026-10-23）

Go1.27.1/darwin-arm64；新建一次性 Docker `postgres:18-alpine`（`promptbench-ui-pg-20261023`，仅 loopback `127.0.0.1:32774`，合成密码），数据库 `promptbench_test` / `promptbench_ui_smoke_test` / `promptbench_backend_smoke_test` 均以 `_test` 结尾；没有读取真实 `.env`、应用 YAML、用户数据库或密钥。自动化使用 per-test random schemas（`newTestStoreTarget`），独立 smoke 使用自己的数据库、临时 YAML、临时 `--data-dir` 和临时二进制。没有 paid/真实 Provider 调用。

- 合约从“可选生成后多轮评估”改为“选择指标即自动单轮评估”。公共写结构拒绝旧 `after_generation_evaluation` 与 `repeats`（400 unknown field），不再静默忽略；schema 仍为 2，未改表、未重写历史 BYTEA。
- 100 个成功输出 × 1 指标产生 100 个 judgment（修改前记录为 5 轮 × 100）；每个 `(Result, Metric)` 恰好一个 `round=1` outcome。重复提交同一选择创建新的 evaluation 记录，旧记录不变。
- 修改当前指标后对既有固定输出再次评估：不新增 generation 调用、不重新生成文本；新 evaluation 使用新规则，旧 evaluation 字节不变。
- `POST /api/runs` 携带 `metrics`：原子创建 server-owned queued child，generation 终结后单轮执行；不带 `metrics`：仅生成、无 child、decision key lookup 为 0。generation replay 始终 gen-only，清除新 child 配置与只读 legacy 字段。
- 历史多轮 evaluation 的 `repeats` 与 `round>1` 仍可读；其 replay 只创建一轮新记录，原 outcomes 与 rounds 保留，存储 snapshot 未被改写。历史 generation snapshot 的 `after_generation_evaluation` 元数据和值在 GET/export 中仍可读，但不执行、不接受为写输入，generation replay 清除，原始存储 blob 不变；未验证 HTTP 输出与原 blob 的空白字节完全相等。
- 仍覆盖来源冻结、subset、stale409、单执行409、Stop、restart interrupt、global20、partial failure/redaction、100000 上限、missing target 不发 decision、internal500 与其他400/404/409 分类。

独立 HTTP smoke 使用 `promptbench_backend_smoke_test`、临时计数 fixture 和独立进程：2 outputs→2 outcomes、edited metric 无 generation、重复评估为新记录、evaluation replay 单轮且无生成、generation-only 无 child、generation replay 无评估、旧字段400；最终 generation calls 8 / decision calls 0。该 smoke 只覆盖 code metrics，不证明真实 JEV、账户认证或模型质量。本轮临时容器、匿名 volume、测试数据库与临时 fixture/二进制已在最终检查后清理，不保留可复用环境。

### 单次评估简化：浏览器（2026-10-23）

真实嵌入应用18788、临时YAML/key、dedicated UI test DB，managed headless Chromium；临时OpenAI/Typesafe计数fixture在19797。无metrics→2 generation/0 evaluation；选1 metric→再+2 generation/+2 decision且自动单轮；手工评估既有输出→+2 decision/0 generation；修改ruleB后再评估→+2 decision/0 generation。受控6s、concurrency1 Stop：`stopping`时cancelled1/in_flight1，随后`stopped`（已发出调用因后续fault switch失败）；零valid、两个503 error的run为`completed_with_errors`；计数/错误未当作boolean值。

旧inline历史仅以浏览器内存合成探针读取`App.currentDetail`：evaluation summary true1/1与普通“评估”详情可读，未出现旧版入口；真实新batch不显示旧summary。模块syntax与`node --test web/model.test.mjs web/json-preview.test.mjs`共6项通过。截图文件存在并被协调者查看确认：`docs/ui/evaluation-metrics-20261023.png`、`evaluation-reevaluate-20261023.png`、`evaluation-inline-20261023.png`。一次自动化超时是confirm dialog option对象写错，改为`dialogs:'accept'`后通过，不是应用缺陷。没有真实legacy DB、真实或付费Provider。

### 浏览器：真实操作与可核对计数

真实嵌入SPA8878、临时YAML/key、`promptbench_browser_test`、managed headless Chromium（非用户登录Chrome）；fixture9979 `/v1/chat/completions`、`/systemone`、`/counts`，合成503/延迟与固定returned model `fixture-decision-v1`。schema2尚未发布时仅重建该 disposable库；初次4 generation来自重建前试跑，最终schema流程起点4，不把累计计数误读为重复生成。

- 页面创建共享contract，A/B模板共同绑定；将CurrentText改integer、Context改required object时列2模板/4Cases，每Case由0变2个明确错误。延迟impact、延迟真实PUT期间编辑保留，旧响应不能恢复save确认；请求拦截只控制真实发送时机、不伪造响应。

| 浏览器场景 | generation 累计 | decision 累计 | 结果 |
| --- | --- | --- | --- |
| 首次无decision key只生成 | 0→4 | 0→0 | 4/4成功 |
| 最终schema无key只生成 | 4→8 | 0→0 | 4/4成功、未评估 |
| 选2输出×1 metric×3轮 | 8→8 | 0→6 | 6/6 |
| 冻结重评 | 8→8 | 6→12 | `replay_of`，原6判断不替换 |
| current rules合成503 | 8→8 | 12→18 | 6 error，generation保留 |
| 延迟2输出×20轮后Stop | 8→8 | 18→19 | 1 completed/39 cancelled，有效分母1 |
| 自动4输出×2轮后关页 | 8→12 | 19→27 | 重开后linked child8/8，无客户端再start |
| 冻结快照仅重生成 | 12→16 | 27→27 | 4成功、无评估child |
| 两配置×两Case，评估2轮 | 16→20 | 27→35 | 8有效，各配置4 |
| 活跃评估互斥后Stop | 20→20 | 35→36 | 12计划只issued1 |
| 来源生成未终结，80计划后Stop | 20→40 | 36→36 | 中途选14输出仍不能评估；20成功/60取消 |

最终 `/counts`: generation40、decision36、decision_failed6。原 source ID `6e2528a077066515507de4a78a55fca5`；三轮 `de06cf4535d7f1257a3d91f53778bc76`；冻结 replay `4137f03c3e986492fcf561d403e00979`；关页 child `adac6eb659258a589188285289ac150d`；双配置 `9f729a6a4728039fc7f13db210136eb8`。这些是已清理隔离环境的关联证据，不是当前可查服务记录。

- 空选择禁评估，页面提交explicit nonempty Result IDs；双配置summary8→组B4→round2为2→单Case1，详情带原output/returned model；`<script>not executable</script>`保持文本。
- 自动评估缺key/round0禁运行，取消自动评估/修round立即恢复；active时生成/新评估/两种重评禁用；source未终结禁评估。导出各自endpoint HTTP200、6/8 outcomes与两组来源，未含合成key；无OS落盘证据。
- 关页/应用重启后历史仍保留原执行；运行记录refresh同时刷新独立评估（当时7条），generation detail呈现冻结contract/说明。
- 修改模块Node syntax、`node --test web/model.test.mjs web/json-preview.test.mjs` 6项通过。正常流程无app JS error；一次Puppeteer isolated-world等待器动态导入空App导致 `Cannot read properties of null (reading 'busy')`，是等待器错误，不计作应用通过或缺陷。浏览器native confirm由自动化接受，没有模拟generation/evaluation API返回。
- 新库没有真实旧inline历史；旧UI保留“生成时评估（旧版）”路径，保真靠后端回归，不是浏览器现场迁移证据。

原验收记录列出以下六张 WebP。当前仓库中的 `docs/ui/standalone-contract-evaluation/` 路径不可用；以下是原始 caption 与文件名，不是可点击附件或当前 UI 证明：

| 截图 / 原文件名 | 证据范围 |
| --- | --- |
| 共享契约影响：`shared-contract-impact.webp` | 两模板/四Case的不兼容影响 |
| 只生成且决策缺凭据：`generation-only-no-decision-credential.webp` | 最早隔离库试跑，不是最终schema库存 |
| 三轮独立评估：`independent-three-rounds.webp` | 2 outputs×3轮 |
| 配置/轮次比较：`group-round-comparison.webp` | group/round分母 |
| Case/轮次与判断详情：`case-round-judgment-detail.webp` | 筛选/展开原输出和判断 |
| 独立评估进行中：`independent-active-execution.webp` | active/互斥状态 |

## Feasibility and alternatives

来源：2026-10-21原任务的设计/官方文档研究与仓库外探针，后移入原evaluation backend记录。以下不是未完成backlog或当前授权阶段；最早“同批inline、不独立补评”的选择后来已被独立评估取代。当前设计理由在[架构](../architecture.md#design-decisions-and-rationale)，这里只保留依据和实验边界。官方链接是当时引用，本次未联网复核。

### Typesafe / System One

| 官方来源 | 当时核实的依据 |
| --- | --- |
| [SDK目录](https://docs.typesafe.ai/sdk.md)、[Quickstart](https://docs.typesafe.ai/introduction/quickstart.md) | 只列Python与JS/TS，无官方Go SDK；Python3.10+/Node20+；其他语言可直接HTTP |
| [System One API](https://docs.typesafe.ai/api/system-one.md) | `POST https://api.typesafe.ai/v1/systemone`、Bearer、model/state/questions→model/answers/usage；多question共用同一state，不能每题独立state |
| [Noul](https://docs.typesafe.ai/primitives/noul.md) | yes概率0..1，不是bool/独立confidence；平台阈值需显式冻结且保留概率 |
| [Score](https://docs.typesafe.ai/primitives/score.md) | ordered描述levels，建议2..10；位置加权均值范围0..N−1可小数，不是任意量纲精确测量/0–100百分制 |
| [Choice](https://docs.typesafe.ai/primitives/choice.md) | 有限选项，choice/probabilities/confidence；Score亦有distribution/confidence；没有自由reason/explanation |
| [JEV1.13已知限制](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) | 不适合精确计数/算术，对抗性输出可能影响判断；不能把限制无差别扩展到别的版本 |
| [JS RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md)、[Python retries](https://docs.typesafe.ai/sdk/python/api/retries.md) | SDK默认追加2次retry，与应用不自动重试边界冲突，需显式关闭 |
| [Models](https://docs.typesafe.ai/models.md) | 版本与可变alias不同；当时alias表/发布列表不同步，无真实API调用就不能断言账户可用版本 |

用户在可行性问答确认Go stdlib REST代替SDK进程；采用native Noul threshold初始 `p>0.5`、Score原生量程、分类labels；不造JEV reason，不把confidence当正确率。Typesafe归统一Provider，generation/decision能力由协议决定，不能把state/questions/typed answers硬塞进messages/text接口；独立metric请求可自然保持target/partial-failure隔离。这些选择的当前落点由架构负责。

原用户示例 `/Users/tmk/orca/workspaces/agent-evals/drum/scripts/evaluation/tmp_run_luna_prompt_base.py:302–322` 只读：检查指定翻译字段汉字、跳过jp、不看corrected_text；没运行其付费调用。本次未检查这个外部脚本是否仍存在。

### JavaScript替代实验

仓库外独立 Go module `/tmp/promptbench-eval-feasibility-OpIWy5`，本机Go1.27.1/darwin-arm64；没有改仓库go.mod/go.sum、真实数据或服务。临时module是否仍可读未确认。

| 候选 | 实际观察与边界 |
| --- | --- |
| `modernc.org/quickjs v0.24.2` | pure-Go转译，`SetMemoryLimit(16<<20)`、`SetEvalTimeout(200*time.Millisecond)`，不启module loader/host；普通返回 `{"value":true,"n":42,"label":"mixed"}` 约1ms；无限loop约200ms、catastrophic regexp约201ms，均 `InternalError: interrupted`；连续array allocation约70ms `InternalError: out of memory`，随后Close均nil |
| host/module探针 | std/os/require/process/loadFile/fetch/console均undefined；import `qjs:std`失败。只做基本探针，未穷举漏洞，不是安全认证 |
| 与当时SQLite共存 | `CGO_ENABLED=0 go run sqlite_probe.go` 同时用 `modernc.org/sqlite v1.39.1`/QuickJS，VM关闭后读回写入的 `preserved`；不是完整仓库回归。QuickJS当时共享依赖libc1.66.10→1.75.4、memory1.11.0→1.12.1，仍需完整回归 |
| Goja latest（当时） | loop可100ms Interrupt，但无独立JS heap硬额度；当时latest要求Go1.26，高于项目最低1.25，因此未采用；未记录精确commit，不能假称今天latest相同 |
| `fastschema/qjs v0.0.6` 原样接入 | 默认std/os可见并读到临时synthetic sentinel；源码默认CWD挂WASI，实际timeout清理panic。自管wazero、禁目录挂载/设线性memory可阻止读取，但需额外ABI/build维护，故未优先采用 |

QuickJS allocator额度不是整个进程RSS，仍需输入/输出/并发上限。最低Go1.25和其他平台没有独立试验。native uncatchable timeout/OOM与catchable script exception需分开：不能转换不可信thrown object，catchable allocation failure可保留安全generic error。具体实现与限额由当前契约描述，探针不提供完整沙箱认证。

## Historical asset provenance

上述 WebP、下列历史 PNG/WebM 与设计目录的仓库路径均不可用。caption/路径作为取得原来源的线索保留，不构成可点击附件、备份可恢复性或当前 UI 证明。原记录称目录 Git-ignored，这不是文件存在的保证；不得凭文字记录补造截图。

### 核心与Case工作流缺失资产

| 原目录 | caption → 原文件名 |
| --- | --- |
| `docs/ui-check/` | clean workbench → `initial-clean-workbench.png`；fixture results → `run-results-fixture.png`；history comparison → `history-compare.png`；protocol preview → `final-workbench-provider-protocol.png` |
| `docs/ui-check/` | narrow workbench → `narrow-mobile.png`；group dialog → `narrow-dialog.png`；Provider dialog → `provider-narrow-dialog.png` |
| `docs/ui-check/` | Provider management → `provider-management-final.png`；credential dialog → `provider-credential-dialog.png`；clean metadata → `provider-management-clean.png`；manual saved → `provider-manual-set-evidence.png`；clear→env → `provider-cleared-env-evidence.png` |
| `docs/ui-check/` | read-only user Provider page → `final-user-provider-page.png`；empty password dialog → `final-user-provider-dialog.png`；user workbench → `final-user-workbench.png` |
| `docs/case-ui-check/` | isolated27Cases/1080requests workbench → `workbench.png`；8-row library → `case-library.png`；full-page lossless editor → `case-editor.png`；8new/4existing import → `case-import-export.png`；routes/match/default → `group-editor.png` |
| `docs/case-ui-check/` | real-user workbench → `final-user-workbench.png`；four-input library → `final-user-case-library.png` |
| `docs/ui/case-workflow/` | reported original Case workflow design directory；示例数量不是production seed；未保留逐文件清单 |

### 内联评估实现缺失资产

均在 `docs/ui/evaluation-implementation/`；是当时实现captures，不是设计fixtures：

| caption | 原文件名 |
| --- | --- |
| workbench metric selection | `workbench-metrics-config.png` |
| separate progress/stop confirmation | `stop-confirmation.png` |
| summary/independent errors | `evaluation-summary.png` |
| two-group denominators | `evaluation-summary-two-groups.png` |
| completed badges/evaluation detail | `evaluation-detail-completed.png` |
| stopped outputs/completed outcomes retained | `stopped-batch.png` |
| numeric/classification code trial | `metrics-code-trial.png` |
| metric management | `metrics-management.png` |
| table headers | `output-table-header.png` |
| metric columns/preview | `output-table-metrics-preview.png` |
| centered headers/type labels | `output-table-centered-labels.png` |
| pagination over explicitly synthetic data | `output-pagination.png` |
| dynamic metric filters, synthetic results | `output-metric-filters.png` |
| isolated sidebar motion,1.61s/26frames | `sidebar-motion.webm` |

外部用户参考 `PixPin_2026-10-22_11-11-34.mp4` 仅为原报告文件名，本次未确认可用性。历史browser scripts为 `/tmp/pb-eval-ui/{fixture.py,setup.mjs,e2e.mjs,reload-debug.mjs,cleanup-test.mjs}`；未确认仍存在，不是可重复执行的项目工具。

### Pencil页面稿来源（2026-10-21）

私有原报告文件 `/Users/tmk/.pencil/documents/1714fda5-1247-4b0e-920e-49193c6ccc7c/untitled.pen` 本次未打开，无法保证恢复。保留原参考frame `iYftN`；下列静态可编辑desktop稿位于其右侧三列四行，PNG原目录 `docs/ui/evaluation/` 当前缺失。管理页1536×1050，工作台状态1536×1860，缺凭据1536×1940；模型版本/数量/概率/凭据状态都是示例。

| 原页面/caption | frame与原PNG |
| --- | --- |
| 01 code metric：JS/AI prompt/local trial | `LwK8b` → `docs/ui/evaluation/LwK8b.png` |
| 02 model boolean：decision Provider/Noul threshold | `cE4zJ` → `docs/ui/evaluation/cE4zJ.png` |
| 03 model number：ordered descriptions/native scale | `w4x4mI` → `docs/ui/evaluation/w4x4mI.png` |
| 04 model classification：labels/descriptions | `Gi9bp` → `docs/ui/evaluation/Gi9bp.png` |
| 05 unified Provider/capabilities/auth | `J2uvps` → `docs/ui/evaluation/J2uvps.png` |
| 06 batch metric/target config inside workbench | `wnBzY` → `docs/ui/evaluation/wnBzY.png` |
| 07 summary in original output tabs | `ph5kr` → `docs/ui/evaluation/ph5kr.png` |
| 08 judgment in original detail tabs | `ycphq` → `docs/ui/evaluation/ycphq.png` |
| 09 AI prompt with synthetic input only | `sHwam` → `docs/ui/evaluation/sHwam.png` |
| 10 progress/stop in original execution surface | `Z6IIaB` → `docs/ui/evaluation/Z6IIaB.png` |
| 11 first-use/empty metrics | `tr68F` → `docs/ui/evaluation/tr68F.png` |
| 12 missing decision credentials near run action | `EbqXd` → `docs/ui/evaluation/EbqXd.png` |

当时用户审阅指出独立概览/执行页脱离已有workbench，因此06/07/08/10/12改为沿原主体嵌入，不造第二执行入口；保留模板、Case、groups、request preview、run/settings、output split。逐页截图检查修正新增tab fit/fill循环和新区域裁切，未宣称修好原参考JSON视口/固定文字裁切；五张workbench状态重导，查看过完整06。静态稿不是可点击实现或逐页用户验收，未单独绘制移动端/全部dropdown/loading/disconnect状态；这些限制不作为当前产品backlog延续。
