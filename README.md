# 仓库发布器（@local/dsh-repo-publisher）

一个 Host 插件（bundle）：**检测项目模板 → 补齐标准 GitHub 文件 → 创建远端仓库 → 推送**。

把一个「能跑但不像个开源项目」的目录（缺 README、缺 `.gitignore`、`package.json` 字段不全）整理成规范仓库并发布，一次工具调用完成。

## 工具 `publish_repository`

| 参数 | 默认 | 说明 |
|---|---|---|
| `directory` | 必填 | 要发布的项目目录 |
| `repository` | 目录名 | `owner/repo` 或只写 `name`；`owner` 默认取令牌账号 |
| `description` | 从清单读取 | 仓库描述 |
| `private` | `false` | 是否私有仓库 |
| `license` | `MIT` | `none` 表示不生成 LICENSE |
| `author` | 清单作者 / 账号 | LICENSE 版权人 |
| `includeCI` | `true` | 生成 `.github/workflows/ci.yml`（令牌缺 `workflow` scope 时自动跳过） |
| `dryRun` | `false` | 只生成文件、返回计划，不建仓不推送 |
| `force` | `false` | 重新生成 README（默认绝不覆盖已有文件） |
| `commitMessage` | 内置 | 提交信息 |

## 它做什么

**1. 模板检测**（只读）

- 语言/生态：`package.json`、`pyproject.toml`/`requirements.txt`、`go.mod`、`Cargo.toml`、`pom.xml`、`composer.json`、`Gemfile`
- 已有标准文件：README 的各种大小写写法、`.gitignore`、`LICENSE`、`.github/workflows/*.yml`
- 名称/描述/许可证：从 `package.json` 或 `pyproject.toml` 读取（**带 BOM 的文件也能解析**）
- 入口文件、`npm scripts`、顶层目录（用于 README 的目录结构）
- 敏感文件（`.env`、私钥、`.npmrc`）与大文件（>20 MB）会列入提示
- 体量统计（跳过 `node_modules`/`.git` 等）

**2. 生成标准文件**（只补缺失）

- `README.md`：按项目类型生成安装、使用、目录结构、License 段落
- `.gitignore`：按生态合并（node/python/go/rust/java/php/ruby）
- `LICENSE`：MIT 全文（`license: none` 可关）
- `.github/workflows/ci.yml`：按语言的 setup + 测试步骤
- `package.json`：补 `name`/`version`/`description`/`license`/`repository`

**3. 创建并推送**

- 远端仓库不存在 → `POST /user/repos` 创建；已存在 → 直接推送，不覆盖历史
- `git init -b main` → `add -A` → `commit` → `push -u origin HEAD:main`
- 认证走 `http.extraheader`（不在命令行、不写进 `.git/config`）
- 推送前覆盖本机可能存在的失效代理键（`http.<url>.proxy`）

## 容错（都是实测踩出来的）

| 情况 | 处理 |
|---|---|
| `git push` 因网络抖动失败（`Recv failure` / `Connection reset`） | 退避重试 3 次 |
| git 协议完全不通（`Could not connect`） | 回退到 **GitHub API 上传**（Git Data API 建 blob/tree/commit/ref，仅限空仓库） |
| 令牌缺 `workflow` scope | 自动跳过 CI 文件并说明原因（否则 GitHub 会拒绝**整个** push） |
| 项目清单带 UTF-8 BOM | 读取时剥离 BOM，避免 `JSON.parse` 静默失败 |
| 已生成过 CI / 标准文件 | 二次运行判定为「已齐全」，不会重复生成或覆盖 |

## 令牌要求

按顺序读取：`GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_ACCESS_TOKEN` → `$DSH_HOME/github-token-publish` → `$DSH_HOME/github-token`。

- **建仓库 + 推送**：classic token 需要 `repo`；fine-grained token 需要 `Administration: write`（建仓）+ `Contents: write`（推送）
- **推送 CI 工作流**：classic token 需要额外勾选 `workflow`；没有就跳过 CI
- 发布用的高权限令牌建议单独放在 `github-token-publish`，不要和只读的搜索令牌混用

## 典型用法

```
用户：把 D:\my-tool 发布成一个开源仓库
→ publish_repository(directory: "D:\\my-tool", description: "一个 xx 工具", license: "MIT")
```

先看计划不改动：

```
→ publish_repository(directory: "D:\\my-tool", dryRun: true)
```

## 安装与卸载

```powershell
dsh plugin --profile desktop add git+https://github.com/wujiawei906/dsh-repo-publisher
```

卸载：从 `dsh.profile.bundles` 移除 `@local/dsh-repo-publisher`，再在 profile 目录 `pnpm remove @local/dsh-repo-publisher`。

## 目录结构

```
index.js            publish_repository 工具定义、编排、报告渲染
lib/detect.js       模板检测（语言、标准文件、入口、敏感文件、体量）
lib/templates.js    标准文件生成（README/.gitignore/LICENSE/CI/package.json）
lib/publish.js      建仓库、提交推送、push 重试与 API 兜底、令牌能力探测
lib/api-upload.js   Git Data API 上传（空仓库兜底）
lib/auth.js         令牌发现（环境变量 / 发布专用文件 / 通用文件）
lib/exec.js         spawn 子进程执行（超时、取消、进程树清理）
```
