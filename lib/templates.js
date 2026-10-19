/**
 * 标准化文件生成：根据检测结果补齐 README / .gitignore / LICENSE / CI，
 * 并补全 package.json 里发布所需的字段。
 *
 * 只生成“缺失的东西”，已有文件默认不动（`force` 才会覆盖 README）。
 */

/** 各生态的 .gitignore 条目。 */
const GITIGNORE = {
  node: ['node_modules/', 'dist/', 'build/', 'coverage/', '*.log', '.env', '.env.*', '!.env.example', '.DS_Store'],
  python: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '*.egg-info/', 'dist/', 'build/', '.pytest_cache/', '.env', '.env.*', '!.env.example', '.DS_Store'],
  go: ['/bin/', '*.exe', '*.test', '*.out', '.env', '.env.*', '.DS_Store'],
  rust: ['/target/', '.env', '.env.*', '.DS_Store'],
  java: ['target/', '*.class', '.env', '.DS_Store'],
  php: ['vendor/', '.env', '.DS_Store'],
  ruby: ['vendor/bundle/', '.bundle/', '.env', '.DS_Store'],
  generic: ['.env', '.env.*', '*.log', '.DS_Store'],
}

/** 各生态的安装说明。 */
const INSTALL = {
  node: '```bash\nnpm install\n```',
  python: '```bash\npython -m venv .venv\nsource .venv/bin/activate   # Windows: .venv\\Scripts\\activate\npip install -r requirements.txt\n```',
  go: '```bash\ngo build ./...\n```',
  rust: '```bash\ncargo build\n```',
  java: '```bash\nmvn install   # 或 ./gradlew build\n```',
  php: '```bash\ncomposer install\n```',
  ruby: '```bash\nbundle install\n```',
  generic: '按项目说明准备运行环境。',
}

/** 各生态的 CI 步骤。 */
const CI_STEPS = {
  node: ["      - uses: actions/setup-node@v4", "        with:", "          node-version: '20'", '      - run: npm ci', '      - run: npm test --if-present'],
  python: ["      - uses: actions/setup-python@v5", '        with:', "          python-version: '3.12'", '      - run: pip install -r requirements.txt', '      - run: pytest -q'],
  go: ["      - uses: actions/setup-go@v5", '        with:', "          go-version: '1.22'", '      - run: go build ./...', '      - run: go test ./...'],
  rust: ['      - run: cargo build --verbose', '      - run: cargo test --verbose'],
  java: ["      - uses: actions/setup-java@v4", '        with:', "          distribution: 'temurin'", "          java-version: '21'", '      - run: ./mvnw -B verify'],
  php: ["      - uses: shivammathur/setup-php@v2", '        with:', "          php-version: '8.3'", '      - run: composer install', '      - run: vendor/bin/phpunit'],
  ruby: ['      - uses: ruby/setup-ruby@v1', '        with:', '          bundler-cache: true', '      - run: bundle exec rake'],
}

/**
 * 生成 MIT 许可证全文。
 * @param {string} author - 版权人。
 * @param {number} year - 年份。
 * @returns {string} 许可证文本。
 */
function mitLicense(author, year) {
  return [
    'MIT License',
    '',
    `Copyright (c) ${year} ${author}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '',
  ].join('\n')
}

/**
 * 拼一份可用的 README。
 * @param {object} detected - 检测结果。
 * @param {object} options - `description`、`repositoryUrl`、`license`、`author`、`year`。
 * @returns {string} README 文本。
 */
function renderReadme(detected, options) {
  const kind = detected.kinds[0] ?? 'generic'
  const description = (options.description || detected.description || '').trim() || '（在这里补充一句话说明这个项目做什么）'
  const lines = [`# ${options.name}`, '', description, '']
  lines.push('## 安装', '', INSTALL[kind] ?? INSTALL.generic, '')

  lines.push('## 使用', '')
  if (detected.scripts.length > 0) {
    lines.push('```bash')
    for (const script of detected.scripts.slice(0, 6)) lines.push(`npm run ${script}`)
    lines.push('```', '')
  } else if (detected.entry !== null) {
    const runner = kind === 'python' ? `python ${detected.entry}` : `node ${detected.entry}`
    lines.push('```bash', runner, '```', '')
  } else {
    lines.push('参见项目内各文件与注释。', '')
  }

  if (detected.stats.top.length > 0) {
    lines.push('## 目录结构', '', '```')
    for (const name of detected.stats.top.slice(0, 20)) lines.push(name)
    lines.push('```', '')
  }

  if (options.repoUrl !== null) {
    lines.push('## 仓库', '', options.repoUrl, '')
  }

  const license = options.license === 'none' ? null : options.license
  if (license !== null) {
    lines.push('## License', '', `${license} © ${options.year} ${options.author}`, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * 拼 .gitignore。
 * @param {string[]} kinds - 项目类型。
 * @returns {string} .gitignore 文本。
 */
function renderGitignore(kinds) {
  const lines = new Set()
  for (const kind of kinds) for (const line of GITIGNORE[kind] ?? []) lines.add(line)
  return `${[...lines].join('\n')}\n`
}

/**
 * 拼 CI 工作流。
 * @param {string[]} kinds - 项目类型。
 * @returns {string|null} 工作流文本，或 null。
 */
function renderCi(kinds) {
  const kind = kinds.find((entry) => Array.isArray(CI_STEPS[entry]))
  if (kind === undefined) return null
  return [
    'name: CI',
    '',
    'on:',
    '  push:',
    '  pull_request:',
    '',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...CI_STEPS[kind],
    '',
  ].join('\n')
}

/**
 * 计算需要写入的文件列表。
 * @param {object} detected - 检测结果。
 * @param {object} options - 生成选项。
 * @returns {{path: string, content: string, action: 'create'|'update', reason: string}[]} 计划。
 */
export function planStandardFiles(detected, options) {
  const plan = []
  const author = options.author || (typeof detected.packageJson?.author === 'string' ? detected.packageJson.author : '') || options.owner
  const year = options.year ?? new Date().getFullYear()
  const license = options.license === 'none' ? null : (options.license || detected.license || 'MIT')

  if (detected.present.readme === null || options.force === true) {
    plan.push({
      path: 'README.md',
      content: renderReadme(detected, { name: options.name, description: options.description, repoUrl: options.repoUrl, license, author, year }),
      action: 'create',
      reason: detected.present.readme === null ? '项目缺少 README' : '按 force 重新生成 README',
    })
  }

  if (detected.present.gitignore === null) {
    plan.push({ path: '.gitignore', content: renderGitignore(detected.kinds), action: 'create', reason: '项目缺少 .gitignore' })
  }

  if (license !== null && detected.present.license === null && license.toLowerCase() === 'mit') {
    plan.push({ path: 'LICENSE', content: mitLicense(author, year), action: 'create', reason: '项目缺少 LICENSE（按 MIT 生成）' })
  }

  if (options.includeCI !== false && detected.present.ci === null) {
    const ci = renderCi(detected.kinds)
    if (ci !== null) {
      plan.push({ path: '.github/workflows/ci.yml', content: ci, action: 'create', reason: '补充基础 CI 工作流' })
    }
  }

  if (detected.kinds.includes('node') && detected.packageJson !== null) {
    const manifest = { ...detected.packageJson }
    const patch = {}
    if (typeof manifest.name !== 'string' || manifest.name === '') patch.name = options.name
    if (typeof manifest.description !== 'string' || manifest.description === '') patch.description = options.description || detected.description || ''
    if (license !== null && (typeof manifest.license !== 'string' || manifest.license === '')) patch.license = license
    if (typeof manifest.repository !== 'object' && options.repoUrl !== null) patch.repository = { type: 'git', url: options.repoUrl }
    if (typeof manifest.version !== 'string') patch.version = '0.1.0'
    if (Object.keys(patch).length > 0) {
      plan.push({
        path: 'package.json',
        content: `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`,
        action: 'update',
        reason: `补全 package.json 字段：${Object.keys(patch).join('、')}`,
      })
    }
  }

  return plan
}
