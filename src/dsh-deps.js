import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function resolveDshPackageFromPath() {
  try {
    const dshBin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
    if (dshBin && existsSync(dshBin)) {
      let cur = dirname(realpathSync(dshBin))
      for (let i = 0; i < 6; i++) {
        const direct = join(cur, '@deepseek-ai', 'dsh', 'package.json')
        if (existsSync(direct)) return direct
        const nested = join(cur, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
        if (existsSync(nested)) return nested
        const parent = dirname(cur)
        if (parent === cur) break
        cur = parent
      }
    }
  } catch {}

  const npxBase = join(homedir(), '.npm', '_npx')
  if (existsSync(npxBase)) {
    try {
      for (const ent of readdirSync(npxBase)) {
        const candidate = join(npxBase, ent, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
        if (existsSync(candidate)) return candidate
      }
    } catch {}
  }
  return undefined
}

function candidateRequires(ctx) {
  const anchors = []
  const installAnchor = ctx?.get?.('profileContext')?.installAnchor
  if (typeof installAnchor === 'string' && installAnchor.length > 0) {
    anchors.push(installAnchor)
  }
  if (typeof process.env.DSH_RUNTIME_ROOT === 'string' && process.env.DSH_RUNTIME_ROOT.length > 0) {
    anchors.push(join(process.env.DSH_RUNTIME_ROOT, 'package.json'))
  }
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
    anchors.push(process.argv[1])
  }
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    anchors.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  }
  const pathDshPkg = resolveDshPackageFromPath()
  if (pathDshPkg) {
    anchors.push(pathDshPkg)
  }
  for (const globalPkg of [
    join(homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  ]) {
    if (existsSync(globalPkg)) {
      anchors.push(globalPkg)
    }
  }
  const reqs = [createRequire(import.meta.url)]
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      reqs.push(req)
      for (const bridge of [
        '@deepseek-ai/dsh-app-boot/package.json',
        '@deepseek-ai/dsh-web-app/package.json',
        '@deepseek-ai/dsh-base/package.json',
      ]) {
        try {
          reqs.push(createRequire(req.resolve(bridge)))
        } catch {}
      }
    } catch {}
  }
  return reqs
}

export async function importDshPackage(specifier, ctx) {
  try {
    return await import(specifier)
  } catch {
    for (const req of candidateRequires(ctx)) {
      try {
        const resolved = req.resolve(specifier)
        return await import(pathToFileURL(resolved).href)
      } catch {}
    }
    throw new Error(`Unable to resolve DSH package: ${specifier}`)
  }
}

export function resolvePackageDirFrom(specifier, ctx) {
  for (const req of candidateRequires(ctx)) {
    try {
      return dirname(req.resolve(`${specifier}/package.json`))
    } catch {}
  }
  return undefined
}
