# 验证指南

本文给出当前代码的可复用验证路径，不记录某轮执行结果。当前行为以 [API](api.md)、[Case API](case-api.md) 和[架构](architecture.md)为准；已发生的迁移与检查分别见[迁移证据](evidence/migrations.md)和[验证证据](evidence/validation.md)。

## 环境与数据隔离

- Go 最低版本来自 `go.mod`：1.25.0。前端语法检查和测试需要 Node.js LTS；没有 npm/Bun 构建流程。
- 后端集成测试需要可连接的 PostgreSQL。显式设置 `PROMPTBENCH_TEST_DATABASE_URL`，数据库名称必须以 `_test` 结尾。缺失配置或名称不合规会失败，不会跳过或读取正常应用配置。
- [teststore_test.go](../internal/workbench/teststore_test.go) 为每个测试创建随机 `pb_…` schema，并使用独立临时密钥目录；清理先关闭 Store，再只删除该测试拥有的 schema。测试角色须能创建/删除 schema；会话丢失测试还需能终止自己拥有的测试连接。不要把正常应用数据库作为目标，即使修改名称也不行。
- `make test-backend` 和 `make test-race` 在环境变量为空且 `.env.test` 存在时读取它。直接 `go test` 不做这一步。测试连接值只来自专用测试配置，不复制真实 `.env`、实际 YAML 或密钥。
- 浏览器/CLI smoke 使用另一个全新的空 PostgreSQL 数据库（建议也以 `_test` 结尾）及独立临时 `--data-dir`。不同应用进程不要共享 smoke 数据库；应用的 schema 锁会阻止第二个实例。
- 仓库 `database/`、真实配置、`credentials.key`、用户备份不是测试材料。不要通过删除数据、重建正常 schema 或重置真实数据库消除失败。只清理本轮创建且已核实归属的进程、数据库、schema 和临时文件。

## 自动化入口

在仓库根目录运行；先通过私有环境设置测试 DSN，不在日志、命令示例或提交中放真实密码。

初次配置可复制公开示例，使用 shell-compatible `NAME='value'` 语法，并对连接中凭据的特殊字符做 URL encoding：

```sh
cp .env.test.example .env.test
chmod 600 .env.test
# 私下编辑为专用 _test 库；不要提交该文件。
```

此文件由 shell source，应视为可信本地配置。已有环境变量优先；使用 Make 入口无需额外 export。直接 `go test` 必须显式提供环境变量。

```sh
make help
make ci-check
make test
make test-race
```

| 命令 | 实际覆盖/副作用 |
| --- | --- |
| `make fmt` / `make fmt-check` | 前者原地格式化，后者只检查并拒绝未格式化 Go 文件 |
| `make lint` | Go vet 与 JS 语法检查；JS 语法检查不是类型检查 |
| `make type-check` | `go build ./...`，编译/类型检查 Go packages，不写根目录应用二进制 |
| `make test-backend` | 只运行 Go 全套测试；需要测试 PostgreSQL，可按上述规则读取 `.env.test` |
| `make test-frontend` | 只运行 `node --test web/*.test.mjs`；不需要 PostgreSQL |
| `make ci-check` | `fmt-check`、Go vet、全部 `web/js/*.js` 与 `web/*.mjs` 的 Node 语法检查、`go build ./...`；不运行数据库测试，不修改格式 |
| `make test` | Go 全套测试及 `node --test web/*.test.mjs`；需要测试 PostgreSQL |
| `make test-race` | Go 全套 race 测试，然后前端测试；需要测试 PostgreSQL |
| `make check` | 先 **原地 gofmt**，再 lint、类型检查、测试；仅在允许改格式时使用，不等同只读检查 |
| `make build` | 构建根目录 `promptbench` 可执行文件，包含嵌入式前端资源 |

组合检查的各阶段顺序执行，即使使用 `make -j`。`.github/workflows/ci.yml` 在 PR、push 到 `main` 和手动触发时只运行 `make ci-check`：不启动 PostgreSQL、不运行测试、不构建容器镜像、不部署。CI 通过不能替代本地测试与 race。

聚焦检查可直接运行，例如：

```sh
go test ./internal/workbench -run TestConfig -count=1
go test ./internal/workbench -run 'TestInputContract|TestIndependentEvaluation|TestEvaluation|TestSchemaOneForwardMigration' -count=1
go test -race ./internal/workbench -run 'TestGlobalCapStopAndNoBrowserOwnership|TestMixedGenerationDecisionGlobalConcurrency|TestPostgresSessionLossDoesNotReconnect' -count=1
node --test web/model.test.mjs web/json-preview.test.mjs
```

除纯配置/纯函数子集外，仍须预先设置测试 DSN。聚焦检查不是完整回归的替代品；Go 全套测试、race、前端测试各自提供不同证据。协议测试会修改全局 adapter registry，不要擅自给现有测试增加 `t.Parallel()`。

## 本地 fixture 与独立 CLI smoke

先创建专用空 PostgreSQL smoke 数据库。按 `config/config.example.yml` 的 `server`/`database` 结构，在仓库外建立权限 0600 的私有 YAML，数据库指向这个新库；`sslmode` 应符合所用环境。示例中的实际 YAML 路径必须存在，不是自动创建数据库的命令。

两个终端分别运行：

```sh
go run ./cmd/fixture --listen 127.0.0.1:9797 --delay 150ms
go run . --config /path/to/private-smoke.yml --listen 127.0.0.1:8788 --data-dir /path/to/new-private-smoke-key-dir
```

直接 `go run .` 不自动读取 `.env`；`make run`/`make dev` 会在 `.env` 存在时传入它，因此隔离 smoke 优先使用前者，并确保进程没有继承真实 Provider 密钥。密钥目录应为新私有位置，不复用正常应用目录。前端资源编译时嵌入：修改 `web/` 后必须重启 `go run .` 或重新构建，浏览器刷新不能替代重启。

在页面新增匿名 Provider：协议 OpenAI Chat Completions，base URL `http://127.0.0.1:9797/v1`，凭据 env 名留空。只启用这个 fixture Provider 的对照组；先设一条 Case、一个组、一次生成，并检查预览请求总数，避免种子组默认 20 次重复产生意外真实调用。预览本身不发送模型请求。

[cmd/fixture/main.go](../cmd/fixture/main.go) 只实现 `/v1/chat/completions`：

| model | 行为 |
| --- | --- |
| 普通任意名称 | 200，回显角色/内容，输出含 `LOCAL HTTP FIXTURE — not a model response`，返回模型名带 `-fixture-returned` |
| `fixture-http-error` | HTTP 422，错误体可用于验证失败持久化 |
| `fixture-invalid-json` | HTTP 200，但响应为 `not JSON (fixture)`，用于区分传输成功与解码失败 |
| `fixture-auth-manual` / `fixture-auth-env` | 比较 Bearer 与 fixture 进程的合成 `PROMPTBENCH_FIXTURE_MANUAL_KEY` / `PROMPTBENCH_FIXTURE_ENV_KEY`；未配置返回 500，不匹配返回 401，只报告匹配类型、不输出密钥 |

凭据 smoke 仍只用合成值：启动 fixture 时设置 `PROMPTBENCH_FIXTURE_MANUAL_KEY=fixture-manual-only PROMPTBENCH_FIXTURE_ENV_KEY=fixture-env-only`；独立应用进程设置 `FAKE_PROVIDER_ENV=fixture-env-only`。Provider env 名填 `FAKE_PROVIDER_ENV`、manual 填 `fixture-manual-only`，选择 `fixture-auth-manual` 应得到 `AUTH MATCH: manual`；清除覆盖后改为 `fixture-auth-env` 应得到 `AUTH MATCH: env`。wrong auth 应为401，不回显值；再查 GET/详情/导出不含这些合成 key。

加长 `--delay` 可观察进度与 Stop。fixture 不支持 Typesafe `/systemone`、决策请求计数、故障注入开关或 JSON 翻译输出；不要将历史 `/tmp` Python fixture 当作仓库可用工具。模型评估传输由 `metric_typesafe_test.go`、`metric_integration_test.go` 的本地 `httptest` fixture 覆盖。需要在浏览器验证模型评估时，应另外提供仅用合成凭据、匹配该协议并可计数/延迟的 loopback fixture；否则明确标记这部分未验证。代码指标的独立评估可直接复用普通生成 fixture 输出，不要求决策服务。

## 按风险选择场景

| 改动风险 | 自动化入口/不变量 | 浏览器或实际 CLI 场景 |
| --- | --- | --- |
| 请求、模板、协议、参数 | `backend_test.go`：preview/sent/persisted 字节与 hash 相等；遗漏/null/0/字符串不同；失败不重试、不跳转；凭据不泄漏 | 预览→一次生成→详情/导出；改当前模板后按冻结快照重新生成，确认旧请求仍一致 |
| Case、导入、数字精度、范围 | `case_workflow_test.go` 及 Case package/import 测试：原子失败、去重、集合、路由、lossless patch、冻结 provenance | JSON/JSONL 的新建/复用/混合非法批次；`9007199254740993`、`1.50`、CRLF、null/[]；集合重叠/排除；导出再导入；预览后编辑/版本冲突禁止提交 |
| 共享输入契约 | `input_contract_test.go`：nested type、required/nullable、数字指数原样、影响无写入、冻结历史 | 两模板绑定同一契约；不兼容 Case 明确 JSON Pointer；影响请求/保存期间继续编辑，旧响应不能恢复确认或覆盖新编辑 |
| 独立评估 | `evaluation_test.go`、`metric_integration_test.go`：来源冻结、子集、重评、每输出×指标恰好一次、100000 上限、生成不读取决策凭据、独立状态 | 只生成缺决策凭据仍可完成；原有输出表/预览/汇总中切换同一评估版本，无独立评估 TAB/工作区；对终态批次重新评估使用当前保存指标，对全部成功输出各判断一次，不重新生成；旧版本仍可查看，历史子集不扩大覆盖，多轮记录保留轮次，内联记录不与独立版本拼接，缺失判断不从其他版本补齐；当前查看子集版本不缩小重算范围；筛选分母只来自选定版本；冻结重放保留 API 契约，不要求客户端重放按钮；关页后自动子执行仍完成；仅重生成不附带评估 |
| JavaScript/JEV 边界 | `metric_code_test.go`、`metric_typesafe_test.go`：严格返回类型、目标提取、超时/OOM/新 VM、host 禁用、typed primitives、响应上限、脱敏/不重试 | 使用合成目标试算；代码异常/取值缺失不能变成 false；模型场景须有独立 fixture，不能以代码指标替代模型传输检查 |
| 调度、停止、恢复、数据库 | 全套 race；`TestGlobalCapStopAndNoBrowserOwnership`、`TestMixedGenerationDecisionGlobalConcurrency`、`TestPostgresSessionLossDoesNotReconnect`、恢复/forward-migration 测试 | 延迟 fixture 中 Stop：已发出调用收尾，未发出取消；重启同一隔离库无自动重发；只在自己的测试连接执行会话终止，不对正常实例操作 |
| 凭据、安全、异步保存 | `credentials_test.go`、`revoke_test.go`、后端安全测试；版本 409 与失败原子性 | 合成 env→manual→clear；密码字段重开为空；失败/冲突保留待提交更改；保存期间新编辑保留 dirty；GET/详情/导出不含合成密钥 |
| 前端模块、输出、布局 | `make lint-frontend`、`make test-frontend`；语法/纯函数测试不等于浏览器验证 | 真实嵌入式资源；桌面与 390px；导航/对话框可达；长 JSON/注入文本；轮询保留选择、tab、滚动/焦点；过滤、分页、预览、键盘及 reduced-motion 选受影响部分 |

## 证据与完成边界

记录本轮实际 revision/环境、已运行命令和退出结果、实际操作与断言、隔离对象、失败/未验证项、清理范围。测试通过不替代浏览器操作；截图不替代字节比较；fixture 通过不证明付费 Provider 可用、认证、模型质量或账单行为。不要把历史记录的通过状态沿用为本轮结果。

- 导出可验证 HTTP 200、attachment/Blob 文件名和类型、实际内容及 round trip。工具没有 OS 下载管理器/落盘证据时，不宣称文件已进入用户 Downloads。
- 人为延迟、网络拦截、合成 409/503 证明指定处理路径，不证明自然发生的供应商故障。区分应用异常与自动化等待器自身异常。
- QuickJS 的额度不等于整个进程 RSS 上限或完整沙箱安全认证。真实 JEV 指令遵循、语义质量、可变 alias 稳定性、远端 TLS/其他平台均须另有相应证据。
- 迁移检查应在授权、可恢复的副本上执行，并比较原始 snapshot/result 字节；当前自动回归与历史真实用户迁移不可混用为同一种证据。具体历史方法见[迁移证据](evidence/migrations.md)。
