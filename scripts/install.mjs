#!/usr/bin/env node
// Install dsh-bvs-pets into a DSH profile (symlink + package.json), no pnpm.
// Idempotent: safe to run again. Backs up package.json first.

import { copyFile, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(scriptDir, '..')
const PACKAGE = 'dsh-bvs-pets'

function parseArgs(argv) {
  const o = { dryRun: false, profile: undefined, dshHome: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') o.dryRun = true
    else if (argv[i] === '--profile') o.profile = argv[++i]
    else if (argv[i] === '--dsh-home') o.dshHome = argv[++i]
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('usage: node scripts/install.mjs [--dry-run] [--profile web] [--dsh-home PATH]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }
  return o
}

function profileFrom(o) {
  const home = o.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  if (!isAbsolute(home)) {
    console.error(`DSH_HOME must be absolute, got: ${home}`)
    process.exit(2)
  }
  const profile = o.profile || process.env.DSH_PROFILE || 'web'
  return { dir: resolve(join(home, 'profiles', profile)), profile }
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const { dir, profile } = profileFrom(o)
  const pkgFile = join(dir, 'package.json')
  const link = join(dir, 'node_modules', PACKAGE)

  const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
  pkg.dependencies = pkg.dependencies || {}
  const linkSpec = `link:${pluginDir.replaceAll('\\', '/')}`
  const alreadyDep = pkg.dependencies[PACKAGE] === linkSpec
  pkg.dependencies[PACKAGE] = linkSpec
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  const alreadyBundle = pkg.dsh.profile.bundles.includes(PACKAGE)
  if (!alreadyBundle) pkg.dsh.profile.bundles.push(PACKAGE)

  console.log(`plugin:  ${pluginDir}`)
  console.log(`profile: ${profile} (${dir})`)
  console.log(`dep:     ${alreadyDep ? 'already' : 'add'}`)
  console.log(`bundle:  ${alreadyBundle ? 'already' : 'add'}`)

  if (o.dryRun) {
    console.log('dry run: no files changed')
    return
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+$/, '')
  const backup = join(dir, 'data', PACKAGE, `install-backup-${stamp}`)
  await mkdir(backup, { recursive: true })
  await copyFile(pkgFile, join(backup, 'package.json'))
  console.log(`backup:  ${backup}`)

  const tmp = `${pkgFile}.${PACKAGE}-${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(pkg, null, 2) + '\n')
  await rename(tmp, pkgFile)

  await mkdir(join(dir, 'node_modules'), { recursive: true })
  try {
    const st = await lstat(link)
    if (st.isSymbolicLink()) {
      const cur = await readlink(link)
      if (resolve(dirname(link), cur) !== pluginDir) await unlink(link)
    } else {
      console.error(`refusing to replace non-symlink: ${link}`)
      process.exit(2)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await symlink(pluginDir, link, 'dir')

  const vpkg = JSON.parse(await readFile(pkgFile, 'utf8'))
  const vlink = await lstat(link)
  const ok = vpkg.dependencies?.[PACKAGE] === linkSpec
    && vpkg.dsh?.profile?.bundles?.includes(PACKAGE)
    && vlink.isSymbolicLink()
  if (!ok) {
    console.error(`verify failed; restore from ${backup}`)
    process.exit(1)
  }
  console.log('')
  console.log('installed. Fully quit DSH (menu bar / Dock) and reopen it.')
}

await main()
