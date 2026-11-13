import * as assert from 'assert'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as fsHelper from './fs-helper'
import * as io from '@actions/io'
import * as path from 'path'
import {IGitCommandManager} from './git-command-manager'

export async function prepareExistingDirectory(
  git: IGitCommandManager | undefined,
  repositoryPath: string,
  repositoryUrl: string,
  clean: boolean,
  ref: string
): Promise<void> {
  assert.ok(repositoryPath, 'Expected repositoryPath to be defined')
  assert.ok(repositoryUrl, 'Expected repositoryUrl to be defined')

  // Indicates whether to delete the directory contents
  let remove = false

  // Check whether using git or REST API
  if (!git) {
    remove = true
  }
  // Fetch URL does not match
  else if (
    !fsHelper.directoryExistsSync(path.join(repositoryPath, '.git')) ||
    repositoryUrl !== (await git.tryGetFetchUrl())
  ) {
    remove = true
  } else {
    await removeAbandonedLockFiles(repositoryPath)

    try {
      core.startGroup('Removing previously created refs, to avoid conflicts')
      // Checkout detached HEAD
      if (!(await git.isDetached())) {
        await git.checkoutDetach()
      }

      // Remove all refs/heads/*
      let branches = await git.branchList(false)
      for (const branch of branches) {
        await git.branchDelete(false, branch)
      }

      // Remove any conflicting refs/remotes/origin/*
      // Example 1: Consider ref is refs/heads/foo and previously fetched refs/remotes/origin/foo/bar
      // Example 2: Consider ref is refs/heads/foo/bar and previously fetched refs/remotes/origin/foo
      if (ref) {
        ref = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`
        if (ref.startsWith('refs/heads/')) {
          const upperName1 = ref.toUpperCase().substr('REFS/HEADS/'.length)
          const upperName1Slash = `${upperName1}/`
          branches = await git.branchList(true)
          for (const branch of branches) {
            const upperName2 = branch.substr('origin/'.length).toUpperCase()
            const upperName2Slash = `${upperName2}/`
            if (
              upperName1.startsWith(upperName2Slash) ||
              upperName2.startsWith(upperName1Slash)
            ) {
              await git.branchDelete(true, branch)
            }
          }
        }
      }
      core.endGroup()

      // Check for submodules and delete any existing files if submodules are present
      if (!(await git.submoduleStatus())) {
        remove = true
        core.info('Bad Submodules found, removing existing files')
      }

      // Clean
      if (clean) {
        core.startGroup('Cleaning the repository')
        if (!(await git.tryClean())) {
          core.debug(
            `The clean command failed. This might be caused by: 1) path too long, 2) permission issue, or 3) file in use. For further investigation, manually run 'git clean -ffdx' on the directory '${repositoryPath}'.`
          )
          remove = true
        } else if (!(await git.tryReset())) {
          remove = true
        }
        core.endGroup()

        if (remove) {
          core.warning(
            `Unable to clean or reset the repository. The repository will be recreated instead.`
          )
        }
      }
    } catch (error) {
      core.warning(
        `Unable to prepare the existing repository. The repository will be recreated instead.`
      )
      remove = true
    }
  }

  if (remove) {
    // Delete the contents of the directory. Don't delete the directory itself
    // since it might be the current working directory.
    core.info(`Deleting the contents of '${repositoryPath}'`)
    for (const file of await fs.promises.readdir(repositoryPath)) {
      await io.rmRF(path.join(repositoryPath, file))
    }
  }
}

/**
 * Deletes every git lock file in the repository at `repositoryPath`, and in
 * the repositories of its submodules under `.git/modules`, that no live
 * process holds.
 *
 * Git takes a lock by creating `<file>.lock` and removes it when the command
 * ends. A git process killed mid-command, as a canceled job's orphaned git is,
 * leaves the lock behind, and every later git command that takes the same
 * lock fails with "File exists". On a runner that keeps its work directory
 * between jobs, that one lock fails every job the runner takes afterwards.
 *
 * A lock is held while a live process has the lock file open or a live git
 * process runs in the repository. A held lock stays and the checkout fails,
 * naming the process: every git command the checkout runs would fail on the
 * lock, and recreating the repository, the checkout's answer to a failed
 * clean, would delete it from under that process. The processes are read
 * from /proc; on a host without one, the runner giving one job at a time the
 * work directory decides that a lock present as the job starts is abandoned.
 */
export async function removeAbandonedLockFiles(
  repositoryPath: string
): Promise<void> {
  const lockPaths = await findLockFiles(path.join(repositoryPath, '.git'))
  if (lockPaths.length === 0) {
    return
  }
  const holders = findLockHolders(lockPaths, repositoryPath)
  for (const lockPath of lockPaths) {
    if (holders.has(lockPath)) {
      continue
    }
    try {
      await io.rmRF(lockPath)
      core.info(`Removed the abandoned git lock '${lockPath}'`)
    } catch (error) {
      core.debug(
        `Unable to delete '${lockPath}'. ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (holders.size > 0) {
    const held = [...holders]
      .map(([lockPath, holder]) => `'${lockPath}' is held by ${holder}`)
      .join('; ')
    throw new Error(
      `A live process holds a git lock of the repository '${repositoryPath}': ${held}. The checkout leaves the repository to it.`
    )
  }
}

/**
 * The `*.lock` files under a git directory, skipping the object stores,
 * which hold no lock files and can be very large.
 */
export async function findLockFiles(gitDir: string): Promise<string[]> {
  const found: string[] = []
  const pending: string[] = [gitDir]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, {withFileTypes: true})
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'objects' && entry.name !== 'lfs') {
          pending.push(entryPath)
        }
      } else if (entry.name.endsWith('.lock')) {
        found.push(entryPath)
      }
    }
  }
  return found.sort()
}

/**
 * Which of `lockPaths` a live process holds, mapped to a description of that
 * process: a git process whose working directory is inside `repositoryPath`,
 * which holds every lock of the repository for as long as it runs, or else a
 * process with the lock file open. Empty on a host without /proc.
 *
 * /proc is read synchronously: a scan of every process's descriptors is tens
 * of thousands of reads on a busy host, and each one awaited separately costs
 * a round trip through the thread pool.
 */
function findLockHolders(
  lockPaths: string[],
  repositoryPath: string
): Map<string, string> {
  const holders = new Map<string, string>()
  let pids: string[]
  try {
    pids = fs
      .readdirSync('/proc')
      .filter(name => /^[0-9]+$/.test(name) && name !== `${process.pid}`)
  } catch {
    return holders
  }
  // The kernel names an open file and a working directory by its real path.
  const repository = realPathOf(repositoryPath)
  for (const pid of pids) {
    const procDir = path.join('/proc', pid)
    const name = readProcName(procDir)
    if (name !== 'git' && !name.startsWith('git-')) {
      continue
    }
    const cwd = readLink(path.join(procDir, 'cwd'))
    if (
      cwd !== undefined &&
      (cwd === repository || cwd.startsWith(`${repository}${path.sep}`))
    ) {
      for (const lockPath of lockPaths) {
        holders.set(
          lockPath,
          `process ${pid} (${name}), running in the repository`
        )
      }
      return holders
    }
  }
  const wanted = new Map<string, string>()
  for (const lockPath of lockPaths) {
    wanted.set(realPathOf(lockPath), lockPath)
  }
  for (const pid of pids) {
    const procDir = path.join('/proc', pid)
    let fds: string[]
    try {
      fds = fs.readdirSync(path.join(procDir, 'fd'))
    } catch {
      // The process ended or belongs to another user.
      continue
    }
    for (const fd of fds) {
      const target = readLink(path.join(procDir, 'fd', fd))
      const lockPath = target === undefined ? undefined : wanted.get(target)
      if (lockPath) {
        holders.set(lockPath, `process ${pid} (${readProcName(procDir)})`)
      }
    }
  }
  return holders
}

/** A process's command name, or `unknown` once it has ended. */
function readProcName(procDir: string): string {
  try {
    return fs.readFileSync(path.join(procDir, 'comm'), 'utf8').trim()
  } catch {
    return 'unknown'
  }
}

/** The target of a /proc link, or undefined once it is gone or unreadable. */
function readLink(linkPath: string): string | undefined {
  try {
    return fs.readlinkSync(linkPath)
  } catch {
    return undefined
  }
}

function realPathOf(filePath: string): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return path.resolve(filePath)
  }
}
