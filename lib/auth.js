/**
 * 令牌解析：发布需要写权限，因此优先读发布专用令牌文件。
 *
 * 顺序：`GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_ACCESS_TOKEN` 环境变量 →
 * `$DSH_HOME/github-token-publish` → `$DSH_HOME/github-token`。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 环境变量候选。 */
const ENV_NAMES = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ACCESS_TOKEN']

/**
 * Harness 主目录。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * 令牌文件候选路径（发布专用优先）。
 * @returns {string[]} 路径列表。
 */
export function tokenFiles() {
  const home = dshHome()
  return [join(home, 'github-token-publish'), join(home, 'github-token'), join(home, 'github-token.txt')]
}

/**
 * 解析当前可用令牌。
 * @returns {Promise<{token: string|null, source: string|null}>} 结果。
 */
export async function resolveAuth() {
  for (const name of ENV_NAMES) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return { token: value.trim(), source: `环境变量 ${name}` }
  }
  for (const file of tokenFiles()) {
    try {
      const text = await readFile(file, 'utf8')
      for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const value = trimmed.includes('=') ? trimmed.split('=').slice(1).join('=').trim() : trimmed
        if (value !== '') return { token: value, source: `令牌文件 ${file}` }
      }
    } catch {
      // 下一个候选
    }
  }
  return { token: null, source: null }
}
