# 迁移与历史保真证据

这些是特定历史阶段的已记录观察，原报告未绑定不可变 commit，不是当前用户库存、运行状态或新的迁移报告，也不建立备份现在仍可恢复的结论。当前存储契约见[架构](../architecture.md#storage-and-migration)，下次验证方法见[验证指南](../verification.md)。

## 血缘与证据种类

| 阶段 | 存储/状态血缘 | 证据对象 |
| --- | --- | --- |
| 凭据/协议升级（原记录无独立日期） | 旧 SQLite；state version 3→4 | 当时真实用户配置；历史/result 行为空；另有非空历史回归 |
| Case 工作流升级（原记录无独立日期） | 同一旧 SQLite 血缘 schema 2→3；state version 4→5 | 当时真实用户配置、在线副本预演和只读验收；历史/手动凭据仍为空 |
| PostgreSQL/config 切换，2026-10-22 | 后续 SQLite 离线备份→PostgreSQL | 真实源已有 14 批次/206 results；与前两阶段不是同一时点的库存；另有加密凭据/失败回滚合成预演 |
| 独立评估，2026-10-23 | **PostgreSQL** schema 1→2 | 模拟已发布 schema1 的隔离回归；未记录真实用户旧数据现场升级 |

SQLite schema2/schema3 与 PostgreSQL schema1/schema2 是不同编号空间；state version 是乐观并发版本，不是数据库 schema。不能将早期零历史、后期 14 批次和合成测试行混为一份数据清单。

## 凭据与协议：state version 3→4

来源：原 `docs/backend-check.md` 的 Credential/protocol migration acceptance，配合原 `docs/ui-check.md` 的只读集成验收。

- 真实升级保留原 4 条 Cases、1 个双消息模板、2 个 Providers、2 个组及所选 Case IDs。canonical 比较确认，除 state version 与 Provider protocol/ref 的加法变更外，其余值与 IDs 不变。
- 两个 Provider 获得 `openai-chat-completions` 和稳定 legacy credential refs，没有创建手动凭据。私有 master key/schema metadata 的生成没有设置、替换或清除用户凭据。
- 升级前后及最终替换前保留一致 SQLite 备份及匹配 key：目录 0700、文件 0600。重启比较保留 state、history IDs、summaries、result bytes；**真实 history/results 当时为空**，非空旧历史保真来自回归测试。
- 只读 API/Chromium 检查健康端点、当时唯一协议、两个 Provider 的非秘密 env 可用性；密码框为空且为 `type=password`、`autocomplete=new-password`，预览使用目录生成的协议/POST endpoint。检查前后 state 字节相同，没有保存、运行或输入 key。

当时报告的用户页面截图现在不可用，原路径保存在[历史资产来源](validation.md#historical-asset-provenance)，不作为现存附件。

## Case 工作流：SQLite schema 2→3 / state version 4→5

来源：原 `docs/case-backend-check.md` 的 Migration and final acceptance，及原 `docs/case-ui-check.md` 的 Final read-only user acceptance。

### 备份、预演与授权切换方法

1. 使用只读源连接及 **SQLite online backup API** 创建一致副本，并保留匹配 key；不是对运行中的 DB 文件做不安全直接复制。目录 0700、DB/key 0600。
2. 在空环境迁移副本，不调用 Provider。授权 rollout 前重新读取实际 state/history、确认 idle，重新制作新副本预演，并比较全部 8 个原 Case×group 预览。预演不改源 state/runs。
3. 仅在这些 gates 后优雅停止所拥有的旧服务。`~/.promptbench/backups/` 下保留停止后的 DB/key 一致对，以及额外的迁移后备份对。原 key 字节保持不变。
4. 必需的既有凭据环境值只在内存转移；未打印、未嵌入命令、未另写明文 env-file，也未写入 state/snapshots。

这是当时执行过的方法，不是授权现在重做或回滚真实库。备份位置仅为历史来源，没有当前可恢复性保证。

### 实际用户数据比较

| 不变量 | 当时接受的证据 |
| --- | --- |
| 库存 | schema2→3、state4→5；原 4 Cases、0 collections、0 history/results；150 条合成 Case 和假历史没有进入用户数据 |
| Case identity/input | 新 random 32-hex Case IDs，draft 引用正确映射；variables 仅移除执行所有的 `TargetLanguageNameMap`，文本/类型/空白不变；当前 DTO 为 id/variables/derived variables_json，不携带 Case name/description |
| 配置 | 两组原字段/参数及 runs20 保留，加显式 zh-CN→en/English routes；settings 仍为 3/20/120；模板 roles/content（含用户 `hi`）、Provider immutable credential refs 和非秘密可用性 metadata 不变 |
| 原始归档 | 私有 migration archive 的 raw `state_data` 等于停止后 schema2 原始字节；credential/history/result 行与 key 字节相等；最终重启不改 schema3 stored state bytes |
| 预览一致 | 全部 8 个旧 Case×group 的 `raw_request`、`prompt_hash`、endpoint、protocol、method、非秘密 headers 与最终服务相等；全为精确 zh-CN→en/English，无 default，无 Provider 调用 |
| Lossless projection | 只读 render/projection 保留 `1.50`、`9007199254740993`、原 CRLF、nested `2.00` 与不同的 null/[]；state bytes 不变 |
| 集成检查 | 嵌入 HTML/JS/CSS 与仓库资产相等；只读 Chromium 的工作台、库、组编辑器、设置无 app/console errors，state bytes/runs 不变 |

真实加密凭据/history/result 行当时均为 0；非空保真是测试证据。工作台显示真实 4 Cases×20 repeats×2 groups＝160 个潜在请求，没有启动批次。只读验收没有 save/import/delete/run/replay/restart；临时自有测试服务停止，未重置无关进程或用户输入。

相关历史回归还保护：`TestFrozenCollectionProvenanceSurvivesRenameMembershipAndDeletion` 的原集合名称/成员及独立 slice；`TestLegacyHistoryExportRetainsRecordedCaseIdentityAndBody` 的旧 Case identity、raw bodies/hash；root nil/[] 兼容仅限根资源列表，不扩展到嵌套变量。

## SQLite → PostgreSQL/config：2026-10-22

来源：原 `docs/backend-check.md` 的 PostgreSQL/config cutover — 2026-10-22。此时运行时与集成测试已改为只使用 PostgreSQL；下列真实备份库存取代早期零历史观察，但不把早期记录改写成有历史。

### 合成预演与失败安全

- 外部合成导入预演拒绝 wrong schema/key/authentication/orphan data；注入复制中途失败时连 DDL 一起回滚。
- 成功预演逐列比较所有值、keys 和 BYTEA hash；重复导入/非空目标被拒绝。
- 实际应用启动保留已完成合成批次，将未结束批次标 interrupted；之后 immutable-history reconciliation 通过。
- 加密凭据导入只由合成/测试数据建立，不是下述真实源的现场证明。

原记录没有保留一个仓库内通用导入工具或可复用脚本路径；这些观察不意味着运行时会自动打开 SQLite，亦不应据此发明迁移命令。

### 真实离线备份导入

| 表/对象 | 导入数量 |
| --- | ---: |
| state | 1 |
| batches | 14 |
| results | 206 |
| credentials | 0 |
| migration archives | 1 |

- 独立 prelaunch 比较匹配每一列、key 与 BYTEA hash。启动后的 immutable-history reconciliation 也匹配，**没有跳过任何可能被 recovery 修改的 cell**。
- 原 SQLite/key hashes 始终不变。
- 只读真实 API 加载 state 与全部 14 个 history details；资源清单为 4 Cases、2 templates、3 Providers、3 metrics。浏览器渲染相同资源及原历史。没有真实 Provider 请求或 replay。
- 实际源没有手动凭据行，不能将此处成功导入解释为真实加密凭据迁移验收。
- 实际配置权限为 0600；Git 只忽略实际 config，不忽略 example。密码/DSN 未进入进程参数或验证日志。

相关集成检查：严格 `TestConfig` 无数据库通过；专用 `_test` 库和每测试唯一 schema 上 focused 及全套 race 通过；丢失 Store session 后原 Store 无法重连/派发，fresh Store 恢复 interrupted；实际二进制验证 YAML port、`--listen` override、缺 config 时 `--help`、第二进程被拒且未创建另一 key 目录；fixture 批次跨刷新/重启/历史/replay 保留原字节/hash，HTTP422 保存为 failed 而非 DB error。这里本地使用 PostgreSQL 17.7，未建立远端 TLS、真实模型访问/质量或 transaction-pooling 兼容性；后者不受支持。

## PostgreSQL schema 1 to 2 (2026-10-23)

来源：原 `docs/evaluation-backend-check.md` 的 Input contracts and independent evaluations；当前可定位测试为 [evaluation_test.go](../../internal/workbench/evaluation_test.go)。

- `TestSchemaOneForwardMigrationPreservesRawHistory` 在隔离 PostgreSQL 模拟已发布 schema1：保存刻意带空白的 summary/snapshot/result JSON、内联旧 metric outcomes 和大整数 `9007199254740993`，移除独立评估表并设置 schema version1，经真实 `openStore` startup 路径升级。
- schema2 仅增加独立 execution/outcome 表。比较 schema version2 以及原 state、summary、snapshot、result 的 raw BYTEA 完全不变；不是 JSON 语义等价比较，也没有将旧 inline outcomes 回填重算。
- `TestEvaluationRestartInterruptsQueuedAndRunningWithoutRewritingEvidence` 重开真实隔离 Store：queued/running 独立评估标 interrupted，已完成 judgment、原 generation result 与 evaluation snapshot BYTEA 均不改写。旧 inline recovery 回归继续保留。
- 2026-10-23 全套测试和 race 通过的历史范围详见[验证证据](validation.md#independent-evaluation-and-contracts-2026-10-23)。新建浏览器库没有真实用户旧 inline 历史，浏览器没有独立证明旧用户数据升级；也没有现场迁移当前用户 PostgreSQL 库的记录。
