/**
 * GitHub 发布：建仓库、写文件、提交并推送。
 *
 * 认证走 git 的 `http.extraheader` 环境式配置（不出现在命令行、不写进
 * `.git/config`）；推送前覆盖本机可能存在的失效代理键，避免 `git push`
 * 卡在「Failed to connect … over proxy」。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { runCommand } from './exec.js'
import { uploadViaApi } from './api-upload.js'

/** GitHub API 基地址。 */
const API = 'https://api.github.com'

/** 覆盖本机可能存在的失效代理（含 URL 专属键）。 */
const PROXY_OVERRIDES = [
  '-c', 'http.proxy=',
  '-c', 'https.proxy=',
  '-c', 'http.https://github.com.proxy=',
  '-c', 'http.github.com.proxy=',
]

/**
 * 判断文件/目录是否存在。
 * @param {string} path - 绝对路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 读取令牌能力：classic token 返回 OAuth scopes 字符串，fine-grained token 返回空串。
 *
 * 推送 `.github/workflows/` 需要 classic token 的 `workflow` scope；
 * 缺这个 scope 时 GitHub 会拒绝整个 push，所以生成 CI 前必须先问一句。
 * @param {object} options - `token`、`signal`。
 * @returns {Promise<{ok: boolean, scopes: string, classic: boolean}>} 能力信息。
 */
export async function tokenScopes(options) {
  const { token, signal } = options
  const response = await fetch(`${API}/user`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-repo-publisher' },
    signal,
  }).catch(() => null)
  if (response === null || !response.ok) return { ok: false, scopes: '', classic: false }
  const scopes = response.headers.get('x-oauth-scopes')
  return { ok: true, scopes: scopes ?? '', classic: scopes !== null }
}

/**
 * 判断令牌能否推送工作流文件。
 * @param {{ok: boolean, scopes: string, classic: boolean}} ability - 令牌能力。
 * @returns {boolean} 是否具备 workflow 权限。
 */
export function canWriteWorkflows(ability) {
  return ability.classic && /\bworkflow\b/u.test(ability.scopes)
}

/**
 * 读取仓库当前状态。
 * @param {object} options - `token`、`owner`、`name`、`signal`。
 * @returns {Promise<{exists: boolean, url: string|null, private: boolean|null}>} 状态。
 */
export async function inspectRepository(options) {
  const { token, owner, name, signal } = options
  const response = await fetch(`${API}/repos/${owner}/${name}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-repo-publisher',
      'x-github-api-version': '2022-11-28',
    },
    signal,
  })
  if (response.status === 200) {
    const body = await response.json()
    return { exists: true, url: body.html_url, private: body.private === true }
  }
  if (response.status === 404) return { exists: false, url: null, private: null }
  const detail = await response.text().catch(() => '')
  throw new Error(`读取仓库状态失败：HTTP ${response.status} ${detail.slice(0, 200)}`)
}

/**
 * 确保远端仓库存在，不存在则创建。
 * @param {object} options - `token`、`owner`、`name`、`description`、`privateRepo`、`signal`。
 * @returns {Promise<{created: boolean, url: string, private: boolean}>} 结果。
 */
export async function ensureRepository(options) {
  const { token, owner, name, description, privateRepo = false, signal } = options
  const current = await inspectRepository({ token, owner, name, signal })
  if (current.exists) return { created: false, url: current.url, private: current.private === true }

  const response = await fetch(`${API}/user/repos`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-repo-publisher',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ name, description: description ?? '', private: privateRepo }),
    signal,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`创建仓库失败：HTTP ${response.status} ${body.message ?? ''}`)
  }
  return { created: true, url: body.html_url, private: body.private === true }
}

/**
 * 把计划中的文件写入项目目录。
 * @param {string} directory - 项目根目录。
 * @param {{path: string, content: string}[]} plan - 文件计划。
 * @returns {Promise<string[]>} 实际写入的相对路径。
 */
export async function writePlannedFiles(directory, plan) {
  const written = []
  for (const item of plan) {
    const full = join(directory, item.path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, item.content, 'utf8')
    written.push(item.path)
  }
  return written
}

/**
 * 初始化 git 仓库、提交并推送到 GitHub。
 * @param {object} options - `directory`、`token`、`owner`、`name`、`branch`、`message`、`signal`、`timeoutMs`。
 * @returns {Promise<{ok: boolean, branch: string, commit: string|null, remote: string, output: string, steps: object[]}>} 结果。
 */
export async function commitAndPush(options) {
  const { directory, token, owner, name, branch = 'main', message = 'chore: initial commit', signal, timeoutMs = 600000 } = options
  const steps = []
  const run = async (args, extra = {}) => {
    const result = await runCommand('git', [...PROXY_OVERRIDES, ...args], { cwd: directory, timeoutMs, signal, ...extra })
    steps.push({ cmd: result.printable, code: result.code })
    return result
  }

  if (!await exists(join(directory, '.git'))) {
    const init = await run(['init', '-b', branch])
    if (init.failed) throw new Error(`git init 失败：${init.message ?? init.stderr}`)
  }

  const add = await run(['add', '-A'])
  if (add.failed) throw new Error(`git add 失败：${add.message ?? add.stderr}`)

  const hasHead = await exists(join(directory, '.git', 'HEAD')) && (await run(['rev-parse', '--verify', 'HEAD'])).code === 0
  const status = await run(['status', '--porcelain'])
  const dirty = status.stdout.trim() !== ''
  let commit = null
  if (dirty || !hasHead) {
    const made = await run(['-c', `user.name=${owner}`, '-c', `user.email=${owner}@users.noreply.github.com`, 'commit', '-m', message])
    if (made.failed && !/nothing to commit|no changes added/iu.test(`${made.stdout}\n${made.stderr}`)) {
      throw new Error(`git commit 失败：${made.message ?? made.stderr}`)
    }
  }
  const head = await run(['rev-parse', 'HEAD'])
  if (head.code === 0) commit = head.stdout.trim()

  const remote = `https://github.com/${owner}/${name}.git`
  await run(['remote', 'remove', 'origin'])
  const added = await run(['remote', 'add', 'origin', remote])
  if (added.failed) throw new Error(`设置 remote 失败：${added.message ?? added.stderr}`)

  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  const pushArgs = ['-c', `http.extraheader=${header}`, 'push', '-u', 'origin', `HEAD:${branch}`]

  // 这条链路会出现 "Recv failure: Connection was reset" 之类的瞬时中断；
  // push 是幂等的（没有新提交时会直接成功），所以按退避策略重试几次。
  let push = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    push = await run(pushArgs, { env: { GIT_TERMINAL_PROMPT: '0' } })
    if (!push.failed) break
    const retryable = /Recv failure|Connection was reset|Could not connect|Connection timed out|early EOF|remote end hung up|RPC failed|failed to connect/iu.test(`${push.stderr}\n${push.message ?? ''}`)
    if (!retryable || attempt === 3) break
    steps.push({ cmd: `retry ${attempt} after transient network error`, code: push.code })
    await new Promise((resolve) => { setTimeout(resolve, 2500 * attempt) })
  }

  const output = `${push.stdout}\n${push.stderr}`.trim().split('\n').slice(-6).join('\n').slice(0, 1500)
  if (push.failed) {
    // git 协议在部分网络下完全不通，而 api.github.com 通常稳定：
    // 对空仓库回退到 Git Data API 上传，避免整个发布因为传输层而失败。
    try {
      const api = await uploadViaApi({ token, owner, name, directory, branch, message, signal })
      return {
        ok: true,
        branch,
        commit: api.commit,
        remote,
        output: `git push 失败（${push.message ?? `退出码 ${push.code}`}），已改用 GitHub API 上传 ${api.files} 个文件（${Math.round(api.bytes / 1024)} KB）`,
        steps,
        viaApi: true,
      }
    } catch (error) {
      return {
        ok: false,
        branch,
        commit,
        remote,
        output,
        steps,
        message: `${push.message ?? `push 退出码 ${push.code}`}；API 兜底失败：${String(error?.message ?? error)}`,
      }
    }
  }
  return { ok: true, branch, commit, remote, output, steps, viaApi: false }
}

/**
 * 读取指定 token 文件里的令牌。
 * @param {string[]} files - 候选路径。
 * @returns {Promise<{token: string|null, source: string|null}>} 结果。
 */
export async function readTokenFiles(files) {
  for (const file of files) {
    try {
      const text = await readFile(file, 'utf8')
      for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const value = trimmed.includes('=') ? trimmed.split('=').slice(1).join('=').trim() : trimmed
        if (value !== '') return { token: value, source: file }
      }
    } catch {
      // 下一个候选
    }
  }
  return { token: null, source: null }
}
