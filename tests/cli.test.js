/**
 * CLI Tests
 *
 * Tests for npx nodox init / prune / status commands.
 * Tests the helper functions directly — we don't shell out to the CLI binary.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { writeCache, readCache, pruneCache } from '../src/layer4/cache-manager.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nodox-cli-'))
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ── Test runner detection ─────────────────────────────────────────────────

describe('test runner detection', () => {
  // We replicate detectTestRunner logic here so we can test it in isolation
  function detectTestRunner(cwd) {
    const jestConfigs = [
      'jest.config.js', 'jest.config.ts', 'jest.config.mjs',
      'jest.config.cjs', 'jest.config.json',
    ]
    for (const f of jestConfigs) {
      if (fs.existsSync(path.join(cwd, f))) {
        return { name: 'Jest', configFile: path.join(cwd, f), testCommand: 'npx jest' }
      }
    }
    const pkgPath = path.join(cwd, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        if (pkg.jest) return { name: 'Jest (package.json)', configFile: pkgPath, testCommand: 'npx jest' }
      } catch {}
    }
    const vitestConfigs = ['vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs']
    for (const f of vitestConfigs) {
      if (fs.existsSync(path.join(cwd, f))) {
        return { name: 'Vitest', configFile: path.join(cwd, f), testCommand: 'npx vitest' }
      }
    }
    return null
  }

  test('detects jest.config.js', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'jest.config.js'), 'export default {}', 'utf8')
    const result = detectTestRunner(dir)
    expect(result.name).toBe('Jest')
    expect(result.testCommand).toBe('npx jest')
    cleanup(dir)
  })

  test('detects jest.config.ts', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'jest.config.ts'), 'export default {}', 'utf8')
    const result = detectTestRunner(dir)
    expect(result.name).toBe('Jest')
    cleanup(dir)
  })

  test('detects vitest.config.js', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'vitest.config.js'), 'export default {}', 'utf8')
    const result = detectTestRunner(dir)
    expect(result.name).toBe('Vitest')
    expect(result.testCommand).toBe('npx vitest')
    cleanup(dir)
  })

  test('detects jest config in package.json', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ jest: { testEnvironment: 'node' } }), 'utf8')
    const result = detectTestRunner(dir)
    expect(result.name).toBe('Jest (package.json)')
    cleanup(dir)
  })

  test('returns null when no config found', () => {
    const dir = makeTmpDir()
    const result = detectTestRunner(dir)
    expect(result).toBeNull()
    cleanup(dir)
  })

  test('prefers jest over vitest when both present', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'jest.config.js'), 'export default {}', 'utf8')
    fs.writeFileSync(path.join(dir, 'vitest.config.js'), 'export default {}', 'utf8')
    const result = detectTestRunner(dir)
    expect(result.name).toBe('Jest')
    cleanup(dir)
  })
})

// ── Config injection ──────────────────────────────────────────────────────

describe('config injection (injectIntoExport)', () => {
  function injectIntoExport(content, lineToInject) {
    const openMatch = content.match(/(export\s+default\s*\{|module\.exports\s*=\s*\{|defineConfig\s*\(\s*\{)/)
    if (!openMatch) return content + '\n// TODO: add ' + lineToInject + ' manually\n'
    let depth = 0, lastClose = -1
    const start = openMatch.index + openMatch[0].lastIndexOf('{')
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++
      else if (content[i] === '}') { depth--; if (depth === 0) { lastClose = i; break } }
    }
    if (lastClose === -1) return content
    const before = content.slice(0, lastClose)
    const after = content.slice(lastClose)
    const trimmed = before.trimEnd()
    const needsComma = trimmed.length > 0 && !trimmed.endsWith(',') && !trimmed.endsWith('{')
    return `${trimmed}${needsComma ? ',' : ''}\n${lineToInject}\n${after}`
  }

  test('injects into clean export default {}', () => {
    const content = `export default {\n  testEnvironment: 'node',\n}`
    const result = injectIntoExport(content, "  setupFiles: ['nodox-cli/jest-setup'],")
    expect(result).toContain("setupFiles: ['nodox-cli/jest-setup']")
    expect(result).toContain("testEnvironment: 'node'")
  })

  test('injects into module.exports = {}', () => {
    const content = `module.exports = {\n  testEnvironment: 'node',\n}`
    const result = injectIntoExport(content, "  setupFiles: ['nodox-cli/jest-setup'],")
    expect(result).toContain("setupFiles: ['nodox-cli/jest-setup']")
  })

  test('injects into defineConfig({})', () => {
    const content = `import { defineConfig } from 'vitest/config'\nexport default defineConfig({\n  test: { environment: 'node' },\n})`
    const result = injectIntoExport(content, "  setupFiles: ['nodox-cli/jest-setup'],")
    expect(result).toContain("setupFiles: ['nodox-cli/jest-setup']")
  })

  test('adds comma before injected line when last entry has no trailing comma', () => {
    const content = `export default {\n  testEnvironment: 'node'\n}`
    const result = injectIntoExport(content, "  setupFiles: ['nodox-cli/jest-setup'],")
    // Should have comma after testEnvironment line
    expect(result).toContain("'node',")
  })

  test('does not double-comma when last entry already has trailing comma', () => {
    const content = `export default {\n  testEnvironment: 'node',\n}`
    const result = injectIntoExport(content, "  setupFiles: ['nodox-cli/jest-setup'],")
    expect(result).not.toContain("'node',,")
  })

  test('produces valid structure after injection', () => {
    const content = `export default {\n  testEnvironment: 'node',\n  transform: {},\n}`
    const result = injectIntoExport(content, "  setupFiles: ['nodox-cli/jest-setup'],")
    // Verify brace balance
    const opens  = (result.match(/\{/g) || []).length
    const closes = (result.match(/\}/g) || []).length
    expect(opens).toBe(closes)
  })
})

// ── setupFiles already present check ─────────────────────────────────────

describe('alreadyPresent detection', () => {
  function injectSetupFile(content, setupEntry) {
    if (content.includes(setupEntry)) return { content, alreadyPresent: true }
    if (/setupFiles\s*:/.test(content)) {
      const updated = content.replace(/setupFiles\s*:\s*\[/, `setupFiles: ['${setupEntry}', `)
      return { content: updated, alreadyPresent: false }
    }
    // fallback to injectIntoExport (simplified)
    return { content: content + `\n  setupFiles: ['${setupEntry}'],`, alreadyPresent: false }
  }

  test('detects when nodox is already present in config', () => {
    const content = `export default {\n  setupFiles: ['nodox-cli/jest-setup'],\n}`
    const result = injectSetupFile(content, 'nodox-cli/jest-setup')
    expect(result.alreadyPresent).toBe(true)
  })

  test('adds to existing setupFiles array', () => {
    const content = `export default {\n  setupFiles: ['other-setup'],\n}`
    const result = injectSetupFile(content, 'nodox-cli/jest-setup')
    expect(result.alreadyPresent).toBe(false)
    expect(result.content).toContain('nodox-cli/jest-setup')
    expect(result.content).toContain('other-setup')
  })

  test('returns alreadyPresent false for clean config', () => {
    const content = `export default {\n  testEnvironment: 'node',\n}`
    const result = injectSetupFile(content, 'nodox-cli/jest-setup')
    expect(result.alreadyPresent).toBe(false)
  })
})

// ── gitignore management ──────────────────────────────────────────────────

describe('gitignore management', () => {
  function ensureGitignore(cwd) {
    const gitignorePath = path.join(cwd, '.gitignore')
    if (!fs.existsSync(gitignorePath)) return false
    const content = fs.readFileSync(gitignorePath, 'utf8')
    if (content.includes('.apicache.json')) return false // already there
    fs.appendFileSync(gitignorePath, '\n# nodox schema cache\n.apicache.json\n')
    return true
  }

  test('adds .apicache.json when .gitignore exists', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n', 'utf8')
    const added = ensureGitignore(dir)
    expect(added).toBe(true)
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    expect(content).toContain('.apicache.json')
    cleanup(dir)
  })

  test('does not duplicate when .apicache.json already in .gitignore', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.apicache.json\n', 'utf8')
    const added = ensureGitignore(dir)
    expect(added).toBe(false)
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    const count = (content.match(/\.apicache\.json/g) || []).length
    expect(count).toBe(1)
    cleanup(dir)
  })

  test('does nothing when no .gitignore exists', () => {
    const dir = makeTmpDir()
    const added = ensureGitignore(dir)
    expect(added).toBe(false)
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
    cleanup(dir)
  })
})

// ── prune command ─────────────────────────────────────────────────────────

describe('prune command', () => {
  test('wipes routes from cache file', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')
    writeCache(file, {
      routes: {
        'GET:/a': { method: 'GET', path: '/a', output: { type: 'array' }, seenCount: 5 },
        'POST:/b': { method: 'POST', path: '/b', input: { type: 'object' }, seenCount: 2 },
      }
    })

    pruneCache(file)

    const result = readCache(file)
    expect(Object.keys(result.routes)).toHaveLength(0)
    cleanup(dir)
  })

  test('prune keeps the file on disk', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')
    writeCache(file, { routes: { 'GET:/test': { method: 'GET', path: '/test' } } })
    pruneCache(file)
    expect(fs.existsSync(file)).toBe(true)
    cleanup(dir)
  })
})

// ── status command ────────────────────────────────────────────────────────

describe('status command data', () => {
  test('getCacheStats returns correct counts', async () => {
    const { getCacheStats } = await import('../src/layer4/cache-manager.js')
    const cache = {
      routes: {
        'GET:/a':    { input: null, output: { type: 'array' } },
        'POST:/b':   { input: { type: 'object' }, output: { type: 'object' } },
        'DELETE:/c': { input: null, output: null },
      }
    }
    const stats = getCacheStats(cache)
    expect(stats.routeCount).toBe(3)
    expect(stats.withInput).toBe(1)
    expect(stats.withOutput).toBe(2)
  })
})
