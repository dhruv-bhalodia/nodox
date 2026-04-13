#!/usr/bin/env node
/**
 * nodox CLI
 *
 * Commands:
 *   npx nodox init    — detect Jest/Vitest, inject setup file into config
 *   npx nodox prune   — wipe .apicache.json and start fresh
 *   npx nodox status  — show current cache stats
 */

import fs from 'fs'
import path from 'path'
import { pruneCache, readCache, getCacheStats } from '../layer4/cache-manager.js'
import { findCacheFile } from '../layer4/cache-reader.js'

const [, , command, ...args] = process.argv

// ── Colours ───────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
}

function log(msg)  { console.log(msg) }
function ok(msg)   { console.log(`  ${c.green}✓${c.reset}  ${msg}`) }
function info(msg) { console.log(`  ${c.cyan}◆${c.reset}  ${msg}`) }
function warn(msg) { console.log(`  ${c.yellow}!${c.reset}  ${msg}`) }
function err(msg)  { console.log(`  ${c.red}✗${c.reset}  ${msg}`) }
function dim(msg)  { console.log(`  ${c.dim}${msg}${c.reset}`) }

// ── Command dispatch ───────────────────────────────────────────────────────
switch (command) {
  case 'init':
    runInit()
    break
  case 'prune':
    runPrune()
    break
  case 'status':
    runStatus()
    break
  case '--help':
  case '-h':
  case undefined:
    printHelp()
    break
  default:
    err(`Unknown command: ${command}`)
    log('')
    printHelp()
    process.exit(1)
}

// ── init ──────────────────────────────────────────────────────────────────

function runInit() {
  log('')
  log(`  ${c.cyan}${c.bold}◆ nodox init${c.reset}`)
  log('')

  const cwd = process.cwd()

  // 1. Detect test runner
  const runner = detectTestRunner(cwd)
  if (!runner) {
    err('No Jest or Vitest config found in the current directory.')
    dim('Expected: jest.config.js, jest.config.ts, vitest.config.js, or vitest.config.ts')
    dim('Run this command from your project root.')
    log('')
    process.exit(1)
  }

  info(`Detected test runner: ${c.bold}${runner.name}${c.reset}`)

  // 2. Determine the setup file path to inject
  // We reference the nodox package by package name so it works whether
  // nodox is installed globally or as a devDependency.
  const setupEntry = 'nodox-cli/jest-setup'

  // 3. Inject into config
  const result = injectSetupFile(runner.configFile, setupEntry, runner.name)

  if (result.alreadyPresent) {
    ok(`nodox setup file already present in ${path.basename(runner.configFile)}`)
    log('')
    dim('Nothing to do. Your test suite is already wired.')
  } else {
    // Write updated config
    fs.writeFileSync(runner.configFile, result.content, 'utf8')
    ok(`Added ${c.cyan}${setupEntry}${c.reset} to ${c.bold}${path.basename(runner.configFile)}${c.reset}`)
    log('')
    dim('Next time you run your tests, nodox will record HTTP exchanges')
    dim('and write them to .apicache.json in your project root.')
  }

  // 4. Add .apicache.json to .gitignore if it exists
  ensureGitignore(cwd)

  log('')
  info('Setup complete. Run your tests to populate the schema cache:')
  dim(`  ${runner.testCommand}`)
  log('')
}

// ── prune ─────────────────────────────────────────────────────────────────

function runPrune() {
  log('')
  log(`  ${c.cyan}${c.bold}◆ nodox prune${c.reset}`)
  log('')

  const cacheFile = findCacheFile() || path.resolve(process.cwd(), '.apicache.json')

  if (!fs.existsSync(cacheFile)) {
    warn('No .apicache.json found — nothing to prune.')
    log('')
    dim(`Expected location: ${cacheFile}`)
    log('')
    return
  }

  // Show what's being wiped
  const cache = readCache(cacheFile)
  const stats = getCacheStats(cache)
  info(`Found cache with ${stats.routeCount} routes (${stats.withOutput} with output schemas)`)

  pruneCache(cacheFile)
  ok('Cache pruned. .apicache.json now contains 0 routes.')
  log('')
  dim('Run your test suite to repopulate from scratch:')
  dim('  npx jest  or  npx vitest')
  log('')
}

// ── status ────────────────────────────────────────────────────────────────

function runStatus() {
  log('')
  log(`  ${c.cyan}${c.bold}◆ nodox status${c.reset}`)
  log('')

  const cacheFile = findCacheFile()

  if (!cacheFile) {
    warn('No .apicache.json found.')
    dim('Run `npx nodox init` then run your test suite to create it.')
    log('')
    return
  }

  const cache = readCache(cacheFile)
  const stats = getCacheStats(cache)

  info(`Cache file: ${c.dim}${cacheFile}${c.reset}`)
  info(`Routes: ${c.bold}${stats.routeCount}${c.reset}`)
  info(`  with input schema:  ${stats.withInput}`)
  info(`  with output schema: ${stats.withOutput}`)

  if (cache.generatedAt) {
    const date = new Date(cache.generatedAt)
    info(`Last updated: ${date.toLocaleString()}`)
  }

  log('')
  info(`View documentation at: ${c.bold}http://localhost:<PORT>/__nodox${c.reset}`)

  if (stats.routeCount > 0) {
    log('')
    log(`  ${c.dim}Routes in cache:${c.reset}`)
    for (const [key, entry] of Object.entries(cache.routes)) {
      const hasIn  = entry.input  ? c.green + '✓ input' + c.reset  : c.dim + '  input' + c.reset
      const hasOut = entry.output ? c.green + '✓ output' + c.reset : c.dim + '  output' + c.reset
      const count  = `seen ${entry.seenCount || 1}x`
      log(`    ${c.dim}${entry.method.padEnd(7)}${c.reset} ${entry.path.padEnd(40)} ${hasIn}  ${hasOut}  ${c.dim}${count}${c.reset}`)
    }
  }

  log('')
}

// ── help ──────────────────────────────────────────────────────────────────

function printHelp() {
  log('')
  log(`  ${c.cyan}${c.bold}◆ nodox${c.reset}`)
  log('')
  log(`  ${c.bold}Commands:${c.reset}`)
  log(`    ${c.cyan}npx nodox init${c.reset}    Wire test suite seeding into Jest or Vitest`)
  log(`    ${c.cyan}npx nodox prune${c.reset}   Wipe .apicache.json and start fresh`)
  log(`    ${c.cyan}npx nodox status${c.reset}  Show current cache stats`)
  log('')
  log(`  ${c.bold}Docs:${c.reset} https://github.com/dhruv-bhalodia/nodox`)
  log('')
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Detect the test runner and its config file in cwd.
 * Returns { name, configFile, testCommand } or null.
 */
function detectTestRunner(cwd) {
  // Jest configs (check before vitest — projects more commonly use Jest)
  const jestConfigs = [
    'jest.config.js', 'jest.config.ts', 'jest.config.mjs',
    'jest.config.cjs', 'jest.config.json',
  ]
  for (const f of jestConfigs) {
    const full = path.join(cwd, f)
    if (fs.existsSync(full)) {
      return { name: 'Jest', configFile: full, testCommand: 'npx jest' }
    }
  }

  // Also check package.json for "jest" key
  const pkgJson = path.join(cwd, 'package.json')
  if (fs.existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
      if (pkg.jest) {
        return { name: 'Jest (package.json)', configFile: pkgJson, testCommand: 'npx jest' }
      }
    } catch { /* ignore */ }
  }

  // Vitest configs
  const vitestConfigs = [
    'vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs',
  ]
  for (const f of vitestConfigs) {
    const full = path.join(cwd, f)
    if (fs.existsSync(full)) {
      return { name: 'Vitest', configFile: full, testCommand: 'npx vitest' }
    }
  }

  return null
}

/**
 * Inject the nodox setup file into a Jest or Vitest config.
 * Returns { content: string, alreadyPresent: boolean }.
 *
 * Jest:   setupFiles goes at top-level of the config object
 * Vitest: setupFiles must be nested inside test: {}
 */
function injectSetupFile(configFile, setupEntry, runnerName) {
  // Special case: package.json with "jest" key
  if (path.basename(configFile) === 'package.json') {
    return injectIntoPackageJson(configFile, setupEntry)
  }

  const content = fs.readFileSync(configFile, 'utf8')

  if (content.includes(setupEntry)) {
    return { content, alreadyPresent: true }
  }

  if (runnerName.startsWith('Vitest')) {
    return injectIntoVitestConfig(content, setupEntry)
  }

  // Jest: already has setupFiles at top level?
  if (/setupFiles\s*:/.test(content)) {
    const updated = content.replace(
      /setupFiles\s*:\s*\[/,
      `setupFiles: ['${setupEntry}', `
    )
    return { content: updated, alreadyPresent: false }
  }

  // Jest: no setupFiles — inject into the exported config object
  const updated = injectIntoExport(content, `  setupFiles: ['${setupEntry}'],`)
  return { content: updated, alreadyPresent: false }
}

/**
 * Inject setupFiles into a Vitest config under the test: {} block.
 * Vitest requires setupFiles to be inside test: {}, not at top level.
 */
function injectIntoVitestConfig(content, setupEntry) {
  const testBlockMatch = content.match(/\btest\s*:\s*\{/)

  if (testBlockMatch) {
    // test: {} block exists — check if setupFiles is already inside it
    if (/\btest\s*:\s*\{[^]*?setupFiles\s*:/.test(content)) {
      // Already has setupFiles inside test block — prepend to it
      const updated = content.replace(
        /(\btest\s*:\s*\{[^]*?setupFiles\s*:\s*\[)/,
        `$1'${setupEntry}', `
      )
      return { content: updated, alreadyPresent: false }
    }

    // Inject setupFiles right after the opening brace of test: {
    const insertAt = testBlockMatch.index + testBlockMatch[0].length
    const before = content.slice(0, insertAt)
    const after = content.slice(insertAt)
    const needsComma = after.trimStart()[0] !== '}'
    return {
      content: `${before}\n    setupFiles: ['${setupEntry}'],${needsComma ? '\n' : ''}${after}`,
      alreadyPresent: false,
    }
  }

  // No test: {} block — inject one into the top-level config object
  const line = `  test: {\n    setupFiles: ['${setupEntry}'],\n  },`
  return { content: injectIntoExport(content, line), alreadyPresent: false }
}

/**
 * Inject into package.json "jest" config key.
 */
function injectIntoPackageJson(pkgFile, setupEntry) {
  const raw = fs.readFileSync(pkgFile, 'utf8')
  const pkg = JSON.parse(raw)

  if (!pkg.jest) return { content: raw, alreadyPresent: false }

  if (pkg.jest.setupFiles?.includes(setupEntry)) {
    return { content: raw, alreadyPresent: true }
  }

  pkg.jest.setupFiles = [setupEntry, ...(pkg.jest.setupFiles || [])]
  return { content: JSON.stringify(pkg, null, 2) + '\n', alreadyPresent: false }
}

/**
 * Inject a line into the first exported object literal in a JS config file.
 * Works for: export default { }, module.exports = { }, defineConfig({ })
 */
function injectIntoExport(content, lineToInject) {
  // Strategy: find the last closing brace of the top-level export and insert before it
  // This is deliberately naive — it handles the 99% case without a full AST parser.

  // Find the opening of the config object
  // Match: export default {, module.exports = {, defineConfig({
  const openMatch = content.match(/(export\s+default\s*\{|module\.exports\s*=\s*\{|defineConfig\s*\(\s*\{)/)
  if (!openMatch) {
    // Can't find the config object — append a warning comment
    return content + `\n// TODO: add setupFiles: ['${lineToInject}'] manually\n`
  }

  // Find the matching closing brace by counting braces
  let depth = 0
  let lastClose = -1
  const start = openMatch.index + openMatch[0].lastIndexOf('{')

  for (let i = start; i < content.length; i++) {
    if (content[i] === '{') depth++
    else if (content[i] === '}') {
      depth--
      if (depth === 0) { lastClose = i; break }
    }
  }

  if (lastClose === -1) return content

  // Insert the line before the closing brace
  const before = content.slice(0, lastClose)
  const after = content.slice(lastClose)

  // Add comma after last real entry if needed
  const trimmed = before.trimEnd()
  const needsComma = trimmed.length > 0 &&
    !trimmed.endsWith(',') &&
    !trimmed.endsWith('{')

  return `${trimmed}${needsComma ? ',' : ''}\n${lineToInject}\n${after}`
}

/**
 * Add .apicache.json to .gitignore if a .gitignore exists and doesn't already include it.
 */
function ensureGitignore(cwd) {
  const gitignorePath = path.join(cwd, '.gitignore')
  if (!fs.existsSync(gitignorePath)) return

  const content = fs.readFileSync(gitignorePath, 'utf8')
  if (content.includes('.apicache.json')) return

  fs.appendFileSync(gitignorePath, '\n# nodox schema cache\n.apicache.json\n')
  ok(`Added .apicache.json to .gitignore`)
}
