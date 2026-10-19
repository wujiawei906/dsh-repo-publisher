/**
 * 项目模板检测：判断项目类型、已有标准文件、入口、敏感文件与体量。
 *
 * 只读，不修改任何文件；所有异常都降级为提示，保证半成品目录也能被检测。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 语言/生态的标记文件。 */
const KIND_MARKERS = [
  ['node', ['package.json']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
  ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts']],
  ['php', ['composer.json']],
  ['ruby', ['Gemfile']],
]

/** 参与“标准化”判断的文件名（大小写不敏感）。 */
export const STANDARD_FILES = {
  readme: ['readme.md', 'readme', 'readme.txt', 'readme.rst'],
  gitignore: ['.gitignore'],
  license: ['license', 'license.md', 'license.txt', 'copying'],
}

/** 绝不应该进入仓库的文件名。 */
const SENSITIVE_NAMES = ['.env', '.env.local', '.env.production', '.env.development', 'id_rsa', 'id_ed25519', '.npmrc', '.pypirc', 'credentials.json']

/** 遍历时跳过的目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__', '.next', '.nuxt', '.idea', '.vscode'])

/**
 * 判断路径是否存在。
 * @param {string} path - 绝对路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function exists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 读取文本文件，失败返回 null。
 *
 * 去掉 UTF-8 BOM：Windows 上不少工具（含 PowerShell 的 `Set-Content -Encoding utf8`）
 * 会写 BOM，而 `JSON.parse` 遇到它直接失败，会让整个清单被静默忽略。
 * @param {string} path - 绝对路径。
 * @returns {Promise<string|null>} 内容。
 */
async function readText(path) {
  try {
    return (await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')
  } catch {
    return null
  }
}

/**
 * 解析 JSON 文件，失败返回 null。
 * @param {string} path - 绝对路径。
 * @returns {Promise<object|null>} 解析结果。
 */
async function readJson(path) {
  const text = await readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 从 TOML 文本里取一个顶层键的值（只处理 `key = "value"` 这一种形式）。
 * @param {string} text - TOML 文本。
 * @param {string} key - 键名。
 * @returns {string|null} 值。
 */
function tomlValue(text, key) {
  const match = new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`, 'u').exec(text)
  return match === null ? null : match[1]
}

/**
 * 列出目录项（忽略不可读目录）。
 * @param {string} path - 目录。
 * @returns {Promise<{name: string, isDirectory: boolean}[]>} 条目。
 */
async function listDir(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  } catch {
    return []
  }
}

/**
 * 递归统计文件数与体积，跳过依赖目录。
 * @param {string} root - 根目录。
 * @returns {Promise<{fileCount: number, sizeKB: number, top: string[]}>} 统计结果。
 */
async function measure(root) {
  let fileCount = 0
  let bytes = 0
  const top = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = await listDir(current)
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (current === root) top.push(`${entry.name}/`)
        stack.push(full)
        continue
      }
      if (current === root) top.push(entry.name)
      try {
        const info = await stat(full)
        fileCount += 1
        bytes += info.size
      } catch {
        // 读不到就跳过
      }
    }
  }
  return { fileCount, sizeKB: Math.round(bytes / 1024), top: top.slice(0, 40) }
}

/**
 * 检测项目。
 * @param {string} directory - 项目绝对路径。
 * @returns {Promise<object>} 检测结果。
 * @throws {Error} 目录不存在时。
 */
export async function detectProject(directory) {
  let info
  try {
    info = await stat(directory)
  } catch {
    throw new Error(`项目目录不存在：${directory}`)
  }
  if (!info.isDirectory()) throw new Error(`不是目录：${directory}`)

  const top = await listDir(directory)
  const names = top.map((entry) => entry.name)
  const lower = names.map((name) => name.toLowerCase())

  const kinds = []
  for (const [kind, markers] of KIND_MARKERS) {
    if (markers.some((marker) => lower.includes(marker.toLowerCase()))) kinds.push(kind)
  }
  if (kinds.length === 0) kinds.push('generic')

  const packageJson = kinds.includes('node') ? await readJson(join(directory, 'package.json')) : null
  const pyprojectText = lower.includes('pyproject.toml') ? await readText(join(directory, 'pyproject.toml')) : null
  const requirementsText = lower.includes('requirements.txt') ? await readText(join(directory, 'requirements.txt')) : null

  const present = {
    readme: STANDARD_FILES.readme.find((name) => lower.includes(name)) ?? null,
    gitignore: STANDARD_FILES.gitignore.find((name) => lower.includes(name)) ?? null,
    license: STANDARD_FILES.license.find((name) => lower.includes(name)) ?? null,
    ci: null,
  }
  if (lower.includes('.github')) {
    const workflows = await listDir(join(directory, '.github', 'workflows'))
    present.ci = workflows.find((entry) => !entry.isDirectory && /\.ya?ml$/iu.test(entry.name))?.name ?? null
  }

  const name = (typeof packageJson?.name === 'string' && packageJson.name !== '' ? packageJson.name : null)
    ?? (pyprojectText === null ? null : tomlValue(pyprojectText, 'name'))
    ?? basename(directory)
  const description = (typeof packageJson?.description === 'string' ? packageJson.description : '')
    || (pyprojectText === null ? '' : (tomlValue(pyprojectText, 'description') ?? ''))
  const license = (typeof packageJson?.license === 'string' ? packageJson.license : '')
    || (pyprojectText === null ? '' : (tomlValue(pyprojectText, 'license') ?? ''))

  let entry = null
  if (kinds.includes('node')) {
    const main = typeof packageJson?.main === 'string' ? packageJson.main : null
    for (const candidate of [main, 'index.js', 'src/index.js', 'index.mjs', 'src/main.js'].filter(Boolean)) {
      if (await exists(join(directory, candidate))) { entry = candidate; break }
    }
  } else if (kinds.includes('python')) {
    for (const candidate of ['main.py', 'app.py', '__main__.py', 'src/main.py']) {
      if (await exists(join(directory, candidate))) { entry = candidate; break }
    }
  } else if (kinds.includes('go')) {
    entry = await exists(join(directory, 'main.go')) ? 'main.go' : null
  } else if (kinds.includes('rust')) {
    entry = await exists(join(directory, 'src', 'main.rs')) ? 'src/main.rs' : null
  }

  const hasGit = await exists(join(directory, '.git', 'HEAD'))
  let remote = null
  if (hasGit) {
    remote = (await readText(join(directory, '.git', 'config')))
    if (remote !== null) {
      const match = /\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/u.exec(remote)
      remote = match === null ? null : match[1]
    }
  }

  const sensitive = names.filter((name) => SENSITIVE_NAMES.includes(name))
  const largeFiles = []
  for (const entryName of names) {
    const full = join(directory, entryName)
    try {
      const fileInfo = await stat(full)
      if (fileInfo.isFile() && fileInfo.size > 20 * 1024 * 1024) largeFiles.push(`${entryName} (${Math.round(fileInfo.size / 1048576)} MB)`)
    } catch {
      // 忽略
    }
  }

  const stats = await measure(directory)
  const scripts = packageJson?.scripts !== undefined && packageJson.scripts !== null ? Object.keys(packageJson.scripts) : []

  return {
    directory,
    name,
    description,
    license,
    kinds,
    entry,
    scripts,
    present,
    packageJson,
    hasGit,
    remote,
    sensitive,
    largeFiles,
    stats,
    top: stats.top,
    notes: [
      present.readme === null ? '缺少 README' : null,
      present.gitignore === null ? '缺少 .gitignore' : null,
      present.license === null ? '缺少 LICENSE' : null,
      sensitive.length > 0 ? `发现敏感文件：${sensitive.join('、')}` : null,
      largeFiles.length > 0 ? `发现大文件：${largeFiles.join('、')}` : null,
    ].filter((note) => note !== null),
  }
}
