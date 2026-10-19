/**
 * Repo Publisher — 把本地项目标准化并发布到 GitHub。
 *
 * 流程：检测项目模板 → 补齐缺失的标准文件 → 创建远端仓库 → 提交推送。
 * 网络差时 `git push` 会失败，插件会先按退避重试，仍失败则回退到 GitHub API 上传；
 * 缺少 `workflow` scope 时自动跳过 CI 文件（否则 GitHub 会拒绝整个 push）。
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveAuth } from './lib/auth.js'
import { detectProject } from './lib/detect.js'
import { planStandardFiles } from './lib/templates.js'
import { canWriteWorkflows, commitAndPush, ensureRepository, tokenScopes, writePlannedFiles } from './lib/publish.js'

/** Cordis plugin identity. */
export const name = 'repo-publisher'
/** Registry this tool registers into. */
export const inject = ['tools']

/** 最长报告长度。 */
const MAX_REPORT_CHARS = 7000

/**
 * 记录一次激活，便于确认 bundle 已挂载。
 */
function noteActivation() {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    appendFileSync(join(home, 'repo-publisher.log'), `${new Date().toISOString()} repo-publisher activated (pid ${process.pid})\n`, 'utf8')
  } catch {
    // 诊断失败不影响插件
  }
}

/**
 * 解析工作区目录。
 * @param {object} exec - 工具执行上下文。
 * @returns {string} 绝对路径。
 */
function workspaceOf(exec) {
  const workspace = exec?.agent?.session?.header?.cwd
  if (typeof workspace === 'string' && workspace.trim() !== '') return workspace
  return process.cwd()
}

/**
 * 把仓库名规整成 `owner/name`。
 * @param {string} raw - 用户输入。
 * @param {string} fallbackOwner - 缺省 owner。
 * @param {string} fallbackName - 缺省仓库名。
 * @returns {{owner: string, name: string}} 结果。
 */
function parseRepository(raw, fallbackOwner, fallbackName) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { owner: fallbackOwner, name: fallbackName }
  if (text.includes('/')) {
    const [owner, repo] = text.split('/')
    return { owner: owner.trim(), name: repo.trim() }
  }
  return { owner: fallbackOwner, name: text }
}

/**
 * 渲染发布报告。
 * @param {object} value - 工具输出。
 * @returns {string} 报告文本。
 */
function renderReport(value) {
  const lines = []
  const label = { published: '已发布', prepared: '已生成（未推送）', failed: '失败' }[value.status] ?? value.status
  lines.push(`仓库发布：${value.repository}`)
  lines.push(`项目目录：${value.directory}`)
  lines.push(`项目类型：${value.detected.kinds.join('、')}｜入口：${value.detected.entry ?? '未识别'}`)
  lines.push(`判定：${label}${value.url === '' ? '' : `｜${value.url}`}${value.commit === '' ? '' : `｜commit ${value.commit.slice(0, 7)}`}`)
  lines.push(`令牌：${value.token.source ?? '未配置'}（scopes: ${value.token.scopes === '' ? '无/fine-grained' : value.token.scopes}${value.token.canWriteWorkflows ? '，可写 workflow' : '，不可写 workflow'}）`)
  lines.push('')
  if (value.detected.notes.length > 0) {
    lines.push('检测到：')
    for (const note of value.detected.notes) lines.push(`- ${note}`)
    lines.push('')
  }
  if (value.plan.length === 0) {
    lines.push('标准文件：已齐全，无需补齐')
  } else {
    lines.push(`标准文件计划（${value.plan.length} 项）：`)
    for (const item of value.plan) lines.push(`- ${item.path} [${item.action}] ${item.reason}`)
  }
  if (value.written.length > 0) {
    lines.push('', `已写入：${value.written.join('、')}`)
  }
  if (value.notes.length > 0) {
    lines.push('', '说明：')
    for (const note of value.notes) lines.push(`- ${note}`)
  }
  const text = lines.join('\n')
  return text.length <= MAX_REPORT_CHARS ? text : `${text.slice(0, MAX_REPORT_CHARS)}\n…（已截断）`
}

/**
 * 注册发布工具。
 * @param {object} ctx - 插件上下文。
 */
export function apply(ctx) {
  noteActivation()
  ctx.tools.register(defineTool({
    name: 'publish_repository',
    description: [
      '把一个本地项目标准化并发布到 GitHub 仓库：检测项目类型与缺失的标准文件，补齐 README/.gitignore/LICENSE/CI 与 package.json 字段，创建远端仓库，然后提交推送。',
      '需要发布令牌（GITHUB_TOKEN 环境变量，或 $DSH_HOME/github-token-publish / github-token 文件），classic token 需含 repo scope；要推 CI 工作流还需要 workflow scope，缺这个 scope 时插件会自动跳过 CI。',
      'dryRun=true 时只生成文件、不创建仓库也不推送，适合先看计划。',
      '目标仓库已存在时不会覆盖历史；git push 因网络失败会自动重试，仍失败则回退到 GitHub API 上传（仅限空仓库）。',
    ].join(''),
    parameters: {
      directory: { type: 'string', required: true, description: '要发布的项目目录（绝对路径或相对当前目录）。' },
      repository: { type: 'string', description: '目标仓库，可写 owner/repo 或只写 name（默认取目录名，owner 默认为令牌账号）。' },
      description: { type: 'string', description: '仓库描述；缺省时取 package.json/pyproject 里的描述。' },
      private: { type: 'boolean', description: '是否创建为私有仓库，默认 false。' },
      license: { type: 'string', description: '要生成的许可证，默认 MIT；设为 none 表示不生成。' },
      author: { type: 'string', description: 'LICENSE 的版权人，默认取 package.json 的 author 或令牌账号。' },
      includeCI: { type: 'boolean', description: '是否生成 .github/workflows/ci.yml，默认 true（令牌无 workflow scope 时自动跳过）。' },
      dryRun: { type: 'boolean', description: '只生成文件并返回计划，不建仓库、不推送，默认 false。' },
      force: { type: 'boolean', description: '为 true 时重新生成 README（覆盖已有内容），默认 false。' },
      commitMessage: { type: 'string', description: '提交信息，默认 "chore: initial commit (standardized by repo-publisher)"。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          directory: { type: 'string', required: true },
          repository: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['published', 'prepared', 'failed'] },
          url: { type: 'string', required: true },
          commit: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          viaApi: { type: 'boolean', required: true },
          detected: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kinds: { type: 'array', required: true, items: { type: 'string' } },
              name: { type: 'string', required: true },
              entry: { type: 'string', required: true },
              notes: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          plan: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                action: { type: 'string', required: true, enum: ['create', 'update'] },
                reason: { type: 'string', required: true },
              },
            },
          },
          written: { type: 'array', required: true, items: { type: 'string' } },
          token: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              source: { type: 'string', required: true },
              scopes: { type: 'string', required: true },
              canWriteWorkflows: { type: 'boolean', required: true },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    execute: async (args, exec) => {
      const directory = resolve(args.directory)
      const notes = []
      const auth = await resolveAuth()
      if (auth.token === null) {
        throw new Error('没有可用的 GitHub 令牌：请设置 GITHUB_TOKEN，或把令牌写入 $DSH_HOME/github-token-publish')
      }

      const ability = await tokenScopes({ token: auth.token, signal: exec?.signal })
      const workflow = canWriteWorkflows(ability)
      const detected = await detectProject(directory)

      // 令牌账号作为 owner 的兜底
      let account = ''
      try {
        const me = await fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${auth.token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-repo-publisher' },
          signal: exec?.signal,
        })
        if (me.ok) account = String((await me.json()).login ?? '')
      } catch {
        // 拿不到账号时留给 parseRepository 的兜底
      }

      const parsed = parseRepository(args.repository, account, basename(directory))
      const repository = `${parsed.owner}/${parsed.name}`
      const repoUrl = `https://github.com/${repository}`
      const license = args.license === undefined ? 'MIT' : args.license

      let includeCI = args.includeCI !== false
      if (includeCI && !workflow) {
        includeCI = false
        notes.push('令牌缺少 workflow scope，已跳过 CI 工作流（否则 GitHub 会拒绝整个 push）')
      }

      const plan = planStandardFiles(detected, {
        name: parsed.name,
        owner: parsed.owner || account,
        description: args.description ?? '',
        repoUrl,
        license,
        author: args.author ?? '',
        includeCI,
        force: args.force === true,
      })

      const base = {
        directory,
        repository,
        url: '',
        commit: '',
        branch: 'main',
        viaApi: false,
        detected: {
          kinds: detected.kinds,
          name: detected.name,
          entry: detected.entry ?? '',
          notes: detected.notes,
        },
        plan: plan.map((item) => ({ path: item.path, action: item.action, reason: item.reason })),
        written: [],
        token: { source: auth.source ?? '', scopes: ability.scopes, canWriteWorkflows: workflow },
        notes,
      }

      const written = await writePlannedFiles(directory, plan)
      base.written = written
      if (args.dryRun === true) {
        notes.push('dryRun：只生成了文件，没有创建仓库、也没有推送')
        return { ...base, status: 'prepared' }
      }

      const repo = await ensureRepository({
        token: auth.token,
        owner: parsed.owner,
        name: parsed.name,
        description: args.description ?? detected.description ?? '',
        privateRepo: args.private === true,
        signal: exec?.signal,
      })
      notes.push(repo.created ? '远端仓库不存在，已创建' : '远端仓库已存在，直接推送')

      const push = await commitAndPush({
        directory,
        token: auth.token,
        owner: parsed.owner,
        name: parsed.name,
        branch: 'main',
        message: args.commitMessage ?? 'chore: initial commit (standardized by repo-publisher)',
        signal: exec?.signal,
      })
      notes.push(push.output)
      if (!push.ok) {
        notes.push(`推送失败：${push.message ?? '未知原因'}`)
        return { ...base, status: 'failed', url: repo.url ?? repoUrl, commit: push.commit ?? '', branch: push.branch, viaApi: push.viaApi === true }
      }
      if (push.viaApi === true) notes.push('git push 不通，已改用 GitHub API 上传')
      return {
        ...base,
        status: 'published',
        url: repo.url ?? repoUrl,
        commit: push.commit ?? '',
        branch: push.branch,
        viaApi: push.viaApi === true,
      }
    },
    isConcurrencySafe: () => false,
    timeoutMs: 900000,
    presentCall: () => ({ card: 'generic', title: '标准化并发布仓库', kind: 'write' }),
  }))
}
