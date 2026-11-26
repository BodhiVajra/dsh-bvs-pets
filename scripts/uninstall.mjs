#!/usr/bin/env node
// Remove dsh-bvs-pets from a DSH profile (reverts package.json + symlink).

import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const PACKAGE = 'dsh-bvs-pets'

function parseArgs(argv) {
  const o = { profile: undefined, dshHome: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') o.profile = argv[++i]
    else if (argv[i] === '--dsh-home') o.dshHome = argv[++i]
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('usage: node scripts/uninstall.mjs [--profile web] [--dsh-home PATH]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }
  return o
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const home = o.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  if (!isAbsolute(home)) {
    console.error(`DSH_HOME must be absolute, got: ${home}`)
    process.exit(2)
  }
  const profile = o.profile || process.env.DSH_PROFILE || 'web'
  const dir = resolve(join(home, 'profiles', profile))
  const pkgFile = join(dir, 'package.json')
  const link = join(dir, 'node_modules', PACKAGE)

  const pkg = JSON.parse(await readFile(pkgFile, 'utf8'))
  if (pkg.dependencies) delete pkg.dependencies[PACKAGE]
  if (pkg.dsh?.profile?.bundles) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PACKAGE)
  }

  const tmp = `${pkgFile}.${PACKAGE}-${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(pkg, null, 2) + '\n')
  await rename(tmp, pkgFile)

  try {
    const st = await lstat(link)
    if (st.isSymbolicLink()) await unlink(link)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  console.log(`removed ${PACKAGE} from ${dir}`)
}

await main()
