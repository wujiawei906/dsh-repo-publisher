/** Subprocess helper: bounded output, cancellable, never throwing. */
import { spawn } from 'node:child_process'

const MAX_OUTPUT_CHARS = 8000

/**
 * Keep the tail of captured text.
 * @param {string} value - Raw captured stream.
 * @returns {string} Bounded text.
 */
function bound(value) {
  const text = String(value ?? '')
  return text.length <= MAX_OUTPUT_CHARS ? text : `…[truncated]…\n${text.slice(-MAX_OUTPUT_CHARS)}`
}

/** Whether a command name needs a Windows command shell to resolve shims. */
function needsShell(command) {
  return process.platform === 'win32' && !/[\\/]/u.test(command)
}

/**
 * Terminate a child process together with everything it spawned.
 * @param {import('node:child_process').ChildProcess} child - Child process.
 */
function killTree(child) {
  if (child?.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined)
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // fall through
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * Run one program and capture its result without ever rejecting.
 * @param {string} command - Executable name or path.
 * @param {string[]} args - Arguments.
 * @param {object} options - `cwd`, `env`, `timeoutMs`, `signal`.
 * @returns {Promise<object>} Captured result.
 */
export function runCommand(command, args = [], options = {}) {
  const { cwd, env, timeoutMs = 600000, signal } = options
  const useShell = needsShell(command)
  const file = useShell ? (process.env.ComSpec ?? 'cmd.exe') : command
  const argv = useShell ? ['/d', '/s', '/c', command, ...args] : args
  const printable = [command, ...args].map((part) => (/\s/u.test(part) ? `"${part}"` : part)).join(' ')

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, argv, { cwd, env: env === undefined ? process.env : { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ command, args, printable, code: 1, stdout: '', stderr: '', failed: true, timedOut: false, aborted: false, missing: false, message: String(error?.message ?? error).slice(0, 400) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null

    const finish = (code, extra = {}) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve({
        command, args, printable, code,
        stdout: bound(stdout), stderr: bound(stderr),
        failed: code !== 0,
        timedOut: extra.timedOut === true,
        aborted: extra.aborted === true,
        missing: extra.missing === true,
        message: extra.message,
      })
    }

    const onAbort = () => {
      killTree(child)
      finish(1, { aborted: true, message: '已取消' })
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        killTree(child)
        finish(1, { aborted: true, message: '已取消' })
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      killTree(child)
      finish(1, { timedOut: true, message: `超时（${timeoutMs} ms）` })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      const missing = error?.code === 'ENOENT' || error?.code === 'EINVAL'
      finish(1, { missing, message: String(error?.message ?? error).slice(0, 400) })
    })
    child.on('close', (code) => finish(code === null ? 1 : code))
  })
}
