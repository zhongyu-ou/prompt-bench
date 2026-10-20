# Promptbench frontend UI check

日期：2026-10-20  
实现文件：`web/index.html`、`web/app.js`、`web/style.css`（未修改 Go 文件）  
测试方式：真实 Chromium 浏览器（1536×1024 与 390×844 视口）+ 隔离的 Go 服务（`127.0.0.1:8788`，临时 data-dir `/tmp/promptbench-ui-smoke`、`/tmp/promptbench-protocol-smoke`、`/tmp/promptbench-final-clean`）+ 本机 fixture（`127.0.0.1:9797`，假凭据 `fixture-manual-only` / `fixture-env-only`）。交付服务 8787 未使用，默认数据目录未写入。

fixture 输出显式包含 `LOCAL HTTP FIXTURE — not a model response`；截图中的运行结果仅为本机测试证据，不代表真实模型质量或在线 Provider 验证。

## 截图

| 截图 | 内容 |
|---|---|
| `docs/ui-check/initial-clean-workbench.png` | 干净临时数据库首次加载，无运行历史；seed case/template/provider 来自后端。 |
| `docs/ui-check/run-results-fixture.png` | fixture 批次结果：成功、HTTP 422、非法 JSON 失败；筛选与展开后的 raw request/raw response。 |
| `docs/ui-check/history-compare.png` | 两个历史批次按 case × 配置并排对比，展示参数、endpoint、输出条数。 |
| `docs/ui-check/narrow-mobile.png` | 390×844 窄屏；页面无水平溢出，案例/导航内部横向滚动。 |
| `docs/ui-check/narrow-dialog.png` | 窄屏对照配置弹窗，提交操作可见可达。 |
| `docs/ui-check/provider-management-final.png` | Provider 管理：协议列、手动密钥/环境变量可用状态与凭据优先级。 |
| `docs/ui-check/provider-credential-dialog.png` | Provider 编辑：空只写密码框、已保存手动密钥提示、清除动作。 |
| `docs/ui-check/provider-narrow-dialog.png` | 390px 窄屏 Provider 凭据弹窗，协议/密钥/提交均可见。 |
| `docs/ui-check/final-workbench-provider-protocol.png` | 最终干净工作台：协议、方法+URL、请求详情与底部输出在 1536×1024 内。 |
| `docs/ui-check/provider-management-clean.png` | 干净 seed Provider 列表（协议 + 真实环境变量可用状态）。 |
| `docs/ui-check/provider-manual-set-evidence.png` | Auth evidence Provider 已保存手动密钥（元数据 manual，密码不回显）。 |
| `docs/ui-check/provider-cleared-env-evidence.png` | 显式清除手动密钥后回退环境变量（元数据 env）。 |

1536×1024 干净工作台输出面板下边界约为 y=1017，位于视口内；长模板行与请求 JSON 使用各自面板的内部滚动。

## 已实际执行的交互

1. **Case 编辑与保存**：编辑 `water_ecology` 变量 JSON，加入任意字段 `SmokeMarker` 与带 HTML 的文本；保存后 GET `/api/state` 保留该字段。服务端版本递增到 v2。
2. **模板 Go 语法**：在模板中追加 `{{- if .SmokeMarker }}`、`{{- range $lang, $name := .TargetLanguageNameMap }}` 等；保存与预览成功。预览 JSON 包含渲染后的 `marker=keep-arbitrary` 与 `lang en => English`，不含原始 `{{- range`。
3. **Provider CRUD**：通过“模型配置”添加无认证 fixture Provider（`http://127.0.0.1:9797/v1`，环境变量为空）；保存到草稿。页面只保存环境变量名。
4. **对照配置**：添加 3 个 fixture 组，分别使用 `fixture-ok`、`fixture-http-error`、`fixture-invalid-json`；高级 JSON 中保留 `fixture_custom`。禁用两个 seed 组，选择一个 case，按钮显示 `运行 5 次`；另一次配置显示 `320 次`。
5. **参数语义**：右栏显示 `未发送`、显式 `null`、数值 `0.2`、`none`；非标准值只在高级 JSON 中显示为“其他（见高级 JSON）”，并在预览请求中保留。
6. **实际运行**：5 次请求完成，状态 `完成（有错误）`，进度 5/5。结果包含成功、上游 HTTP 422、响应 JSON 解码失败；展开行可看到精确 `raw_request`、原始错误响应、解析 output/error。
7. **筛选**：按状态 `失败` 得 2/5，按组 `Fixture OK` 得 3/5，按 case `water_ecology` 得 5/5。
8. **停止**：复跑 320 次批次后停止，最终 `已停止`，summary 为 `cancelled=300, completed=7, failed=13, in_flight=0`；已派发请求完成并落库。
9. **刷新恢复**：320 次批次运行中刷新页面，恢复同一个批次 `#dc656ec7275afd058f26298343199330`，进度从 0/320 继续到 220/320，排版/编辑器未重置。
10. **轮询不覆盖未保存编辑**：运行中对模板追加未保存文本，设置光标位置 94、文本框滚动 160；等待 4 秒（进度 0→80/320），文本、光标、滚动位置与焦点均保持不变，保存状态仍为“有未保存更改”。
11. **保存竞态（延迟 PUT）**：将 `PUT /api/state` 延迟 1.2s，保存期间继续编辑模板。服务端保存了提交快照（无 `RACE_EDIT_AFTER_SUBMIT`），界面保留后续编辑并显示“有未保存更改”，未把新编辑误标为已保存。
12. **预览竞态**：延迟 PUT 并在预览保存期间继续编辑，预览未执行，界面提示“保存期间草稿又被编辑”，状态为“需刷新”。另将 preview 响应延迟 1.2s，在响应返回前编辑模板；旧响应被丢弃，预览正文保持原样，状态为“需刷新”。
13. **模板/配置绑定显式化**：复制第二个模板并仅让 `group_2` 绑定副本。选择组时编辑器自动聚焦该组绑定模板；手动浏览另一模板时显示“编辑器模板≠配置绑定模板 · 切到绑定模板”。此时 `group_1` 预览仍使用 `asr`（不含副本 marker），`group_2` 预览使用副本（含 marker），确认预览/运行不随编辑器浏览而漂移。
14. **历史**：列表显示持久化批次；详情包含批次统计、冻结 case/模板/provider/组/渲染请求与结果。复跑生成新批次（`replay_of` 保留），对比页按 case × 配置展示参数/输出。
15. **导出**：页面导出按钮指向 `/api/runs/{id}/export`；同源请求返回 200、`Content-Disposition: attachment; filename="promptbench-....json"`，约 1.4 MB，包含 batch/snapshot/results，未发现 key 形态字符串。当前 relay 浏览器未暴露实际下载文件事件，因此未把“文件落盘”作为已验证项。
16. **窄屏**：390px 下 `document.documentElement.scrollWidth=375 < innerWidth=390`，没有页面级水平滚动条；Save/Run、模板选择、编辑按钮均在视口内。导航与 case 列表为内部横向滚动。弹窗宽 343px，提交按钮可见。
17. **安全**：fixture 回显包含 `<img src=x onerror="window.__xss=1">` 的 case 文本；结果页 `window.__xss` 保持 `undefined`，DOM 中未生成 `img` 元素。所有动态内容通过文本转义/`textContent` 渲染。
18. **控制台**：以上流程中浏览器 `errors` 集合为空。

## Provider 协议与手动凭据（2026-10-20 新增）

实现：`Provider 管理` 使用 `GET /api/protocols` 目录（当前仅 `openai-chat-completions`，无虚假 Anthropic/Gemini 选项）；Provider 保存 `protocol`、`credential_ref`，类型列与 endpoint 提示均来自目录。手动密钥通过 `PUT /api/state` 的 write-only `credential_updates` 与草稿原子提交；GET 只返回 `credentials` 非秘密状态。

实际浏览器验证（隔离 8788 + 临时 DB + 本地 auth fixture，假值 `fixture-manual-only` / `fixture-env-only`）：

1. **目录驱动**：协议选择器只有一个服务端已实现选项；类型提示、Base URL 提示、认证提示来自 `/api/protocols`。未知协议选项为禁用并阻止保存/运行。
2. **环境变量回退**：创建 env-only Provider（`FAKE_PROVIDER_ENV`，无手动密钥）→ GET 元数据 `manual_set=false, source=env, available=true`。`fixture-auth-env` 成功输出 `AUTH MATCH: env`，`fixture-auth-manual` 返回 401。
3. **手动覆盖优先**：在密码框输入假密钥后保存 → 元数据 `manual_set=true, source=manual`。同一批次变为 `fixture-auth-env` 401、`fixture-auth-manual` 成功 `AUTH MATCH: manual`。密码框提交/关闭后清空；重新打开和刷新页面后值为空，仅显示“已保存手动密钥，留空不更换”。截图 `provider-manual-set-evidence.png`。
4. **替换行为**：把已保存手动密钥替换为 `fixture-manual-wrong` 并保存，两个 auth 模型均 401（证明旧密钥没有继续生效、也没有回退 env）；GET state/export 中均无该假密钥值。
5. **显式清除回退**：点击“清除手动密钥，改用环境变量”并保存 → 元数据 `manual_set=false, source=env`；再次运行恢复 env 成功 / manual 401。Provider 名称编辑不会清除已保存覆盖。截图 `provider-cleared-env-evidence.png`。
6. **无认证与缺失环境**：空 env + 无手动密钥 → `source=anonymous, available=true, requires_auth=false`，`fixture-ok` 实际运行成功；未设置的 env → `source=missing, available=false`，列表显示“缺少凭据/环境变量缺失”。
7. **密码不泄漏**：成功保存后 GET state、历史详情 DOM、批次 export 均不含假密钥或 `Bearer`；替换后的 wrong 值与 env 值也未出现在 export（最近验证批次 23,357 bytes）。密码字段只存在于对话框打开期间的 DOM。浏览器无 localStorage/sessionStorage 写入。
8. **失败与冲突保留**：模拟 PUT 500 后，列表仍显示“待保存：手动密钥”，密码不回显；另制造 state version 409，pending 密钥仍保留，重新载入前明确警告并清除。
9. **异步保存竞态**：延迟 PUT 期间提交替换密钥，并在 in-flight 时再提交“清除”。响应后服务端保留已提交的手动密钥，而客户端仍保留后来的清除 pending；状态显示“有未保存更改”，再次保存才回退 env。只清除已成功提交且未变化的 mutation。
10. **清除+删除原子保存**：对已保存手动密钥的 Provider 先 pending clear 再删除，同一 PUT 成功（版本递增，Provider/引用组移除，credentials 元数据不再包含该 id）。未清除的已保存覆盖删除时确认文案明确说明加密引用仍保留供历史复跑；新未保存 Provider 删除会丢弃全部 pending 密钥。
11. **冻结历史**：快照请求显示 `POST`、协议名、`requires_auth` 和 `credential_ref`；方法/非认证 headers 在折叠详情中；raw request/export 不含 Authorization 或密钥。预览显示 `POST <endpoint>`、协议、非认证 headers 与精确 `raw_request`，endpoint 由服务端目录/适配器生成，不在前端硬编码 `/chat/completions`。
12. **窄屏 Provider**：390px 下 Provider 表位于内部横向滚动容器，页面 `scrollWidth=390`；凭据弹窗宽 358px，协议、密码、清除操作、提交均可达。
13. **控制台**：以上流程浏览器 errors/console 为空。

## 限制

- 测试只调用本机 fixture，未调用真实模型 Provider。
- 初始截图使用后端 seed 数据，但无虚构运行历史；运行截图均来自 fixture 实际执行。
- 当前只有 `openai-chat-completions` 一个真实适配器；多协议目录行为通过目录选项、未知协议阻止和冻结协议字段验证，未实现/未宣称其他原生厂商适配器。
- Provider 功能与竞态测试在隔离 8788/临时数据目录完成；最终 8787 由 supervised `promptbench-final-user-8787` 运行最终构建。本会话未重启/写入用户服务，只做只读验证，前后 state hash 一致。

## 最终交付启动复核（历史阶段，Provider 协议变更前）

以下只读复核对应加入 Provider 协议/手动凭据之前的资源阶段，保留作为当时证据：

- 8787 默认数据目录 seed 四个 case、1 模板、2 配置、version v1、runs 为空；预览仅调用 `/api/preview`。
- 旧资源包含模板/配置绑定提示、`state_version`、保存快照竞态修复和窄屏修复。
- 1536×1024 文档宽 1521，输出面板下边界 1019，浏览器 errors/console 为空。
- 历史截图：`docs/ui-check/final-workbench.png`。

Provider 协议/手动凭据版本的干净隔离复核：1536×1024 文档宽 1536（无页面水平滚动），输出面板下边界 989，预览新增协议与方法+URL 行，请求详情默认折叠；截图 `docs/ui-check/final-workbench-provider-protocol.png`。

### 最终 8787 用户服务只读复核

- 服务：supervised `promptbench-final-user-8787`，PID42232，`http://127.0.0.1:8787`，项目根 `./promptbench`，默认数据目录，继承真实环境。二进制 SHA256 `28c02061101f59f282e24230e490f7604764b98c679831896d83e1b083a51189`（backend 最终 stale-tab409 修复构建）。独立 `go test -race -count=1 ./...` 通过2.320s，无race报告；`go build -o /tmp/promptbench-final-verify .` 的 hash 与 live binary 完全一致。服务端 `/app.js`/`/style.css`/`/` 哈希与仓库资源一致。
- 迁移：自动 pre-credentials 备份 `~/.promptbench/backups/pre-credentials-20261020T075803292429Z/promptbench.sqlite`；另建 `post-credentials-20261020T075952Z/{promptbench.sqlite,credentials.key}`，均 `0600`。旧 v3 → 新 v4，移除纯新增 protocol/ref/version 后 canonical state hash 完全一致；cases+templates hash 一致；runs/result 均为空且 ID 集合未变。
- API：health ok；protocols 仅 `openai-chat-completions`；state v4，4 cases/1 template/2 providers/2 groups，非秘密凭据均 `source=env, available=true, requires_auth=true`；runs `[]`。
- 只读浏览器 1536×1024：Provider 表显示协议列与环境变量可用状态；编辑弹窗密码框为空、`type=password`、`autocomplete=new-password`，未显示已保存 secret；工作台预览显示协议和 `POST <目录生成 endpoint>`。未保存、未运行、未输入密钥。检查前后 `/api/state` 字节哈希均为 `805269349f836b0a4aa3f4d2eba859cf502320be73534f736dddec42da019b99`。Console/errors 为空。
- 截图：`docs/ui-check/final-user-provider-page.png`、`final-user-provider-dialog.png`、`final-user-workbench.png`。
- 已只停止 owned 临时服务 `promptbench-credential-app-8789` 与 `promptbench-credential-fixture-9798`；最终 8787 保持运行。

## 隔离验证端点与元数据（2026-10-20 Provider 契约）

- 测试 App（已停止）：`http://127.0.0.1:8788`，PID 22138，临时 data-dir `/tmp/promptbench-credentials-ui`（最终凭据证据）与 `/tmp/promptbench-final-clean`（干净布局复核）；更早的 `/tmp/promptbench-protocol-smoke` 保存了失败/冲突/删除竞态证据。
- 测试 fixture（已停止）：`http://127.0.0.1:9797`，PID 85762；仅使用假值 `PROMPTBENCH_FIXTURE_MANUAL_KEY=fixture-manual-only`、`PROMPTBENCH_FIXTURE_ENV_KEY=fixture-env-only`；测试 App 使用 `FAKE_PROVIDER_ENV=fixture-env-only`。真实付费 Provider 未被调用。
- `GET /api/protocols` 仅返回 `openai-chat-completions`；UI 选择器只有该选项，无 Anthropic/Gemini 等虚假项。
- `GET /api/state` 的 `credentials` 只含非秘密元数据；实测 `manual_set`、`env_available`、`source`（manual/env/anonymous/missing）、`available`、`requires_auth` 与真实 fixture 行为一致。
- 成功手动覆盖保存后：`source=manual, available=true, manual_set=true`；清除后：`source=env, manual_set=false`（env 可用时）；空 env/无手动：`source=anonymous, requires_auth=false`；未设置的 env：`source=missing, available=false`。
- `GET /api/state`、历史 DOM、批次 export 与 raw request 均未出现假密钥或 Authorization；`credential_ref` 为非秘密冻结引用。
- 清理浏览器 console 后最终复核 errors/console 均为空；页面只加载同源 `app.js`/`style.css`，无外部资源依赖。
- **8787 未重启、未写入**；其在线服务与默认数据目录保持原状，待后端协调迁移/重建后启动最终资源。

