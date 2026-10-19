/**
 * GitHub API 上传兜底。
 *
 * 当 `git push` 因为网络原因失败（这台机器上 github.com:443 的 git 协议时通时断，
 * 而 api.github.com 一直稳定）时，用 Git Data API 直接创建 blob / tree / commit /
 * ref，把文件写进空仓库。只用于初始化空仓库，不覆盖已有历史。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** 上传时跳过的目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__', '.next', '.idea', '.vscode'])

/** 单文件上限（GitHub blob API 上限 100 MB，这里保守一些）。 */
const MAX_FILE_BYTES = 20 * 1024 * 1024

/**
 * 递归收集要上传的文件。
 * @param {string} root - 项目根目录。
 * @param {string} dir - 当前目录。
 * @param {{path: string, file: string, sizeKB: number}[]} out - 收集结果。
 * @returns {Promise<{path: string, file: string, sizeKB: number}[]>} 文件列表。
 */
export async function collectFiles(root, dir = root, out = []) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(root, full, out)
      continue
    }
    const info = await stat(full).catch(() => null)
    if (info === null || info.size > MAX_FILE_BYTES) continue
    out.push({ path: relative(root, full).replace(/\\/gu, '/'), file: full, sizeKB: Math.round(info.size / 1024) })
  }
  return out
}

/**
 * 通过 GitHub API 把目录内容写入一个空仓库。
 * @param {object} options - `token`、`owner`、`name`、`directory`、`branch`、`message`、`signal`。
 * @returns {Promise<{commit: string, files: number, bytes: number}>} 结果。
 * @throws {Error} 仓库已有内容或任一请求失败时。
 */
export async function uploadViaApi(options) {
  const { token, owner, name, directory, branch = 'main', message = 'chore: initial commit', signal } = options
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'dsh-repo-publisher',
    'x-github-api-version': '2022-11-28',
  }
  const call = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com${path}`, { ...init, headers, signal })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${path} → HTTP ${response.status} ${detail.slice(0, 200)}`)
    }
    return response.json()
  }

  const existing = await fetch(`https://api.github.com/repos/${owner}/${name}/git/ref/heads/${branch}`, { headers, signal })
  if (existing.ok) throw new Error('仓库已有内容，API 兜底只用于初始化空仓库')

  const files = await collectFiles(directory)
  if (files.length === 0) throw new Error('没有可上传的文件')
  if (files.length > 300) throw new Error(`文件太多（${files.length} 个），API 兜底不适用，请重试 git push`)

  const tree = []
  let bytes = 0
  for (const file of files) {
    const buffer = await readFile(file.file)
    bytes += buffer.length
    const blob = await call(`/repos/${owner}/${name}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: buffer.toString('base64'), encoding: 'base64' }),
    })
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const createdTree = await call(`/repos/${owner}/${name}/git/trees`, { method: 'POST', body: JSON.stringify({ tree }) })
  const commit = await call(`/repos/${owner}/${name}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: createdTree.sha, parents: [] }),
  })
  await call(`/repos/${owner}/${name}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  })
  return { commit: commit.sha, files: files.length, bytes }
}
