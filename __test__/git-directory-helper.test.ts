import * as core from '@actions/core'
import * as fs from 'fs'
import * as gitDirectoryHelper from '../lib/git-directory-helper'
import * as io from '@actions/io'
import * as path from 'path'
import {execFileSync, spawn} from 'child_process'
import {IGitCommandManager} from '../lib/git-command-manager'

const testWorkspace = path.join(__dirname, '_temp', 'git-directory-helper')
let repositoryPath: string
let repositoryUrl: string
let clean: boolean
let ref: string
let git: IGitCommandManager

describe('git-directory-helper tests', () => {
  beforeAll(async () => {
    // Clear test workspace
    await io.rmRF(testWorkspace)
  })

  beforeEach(() => {
    // Mock error/warning/info/debug
    jest.spyOn(core, 'error').mockImplementation(jest.fn())
    jest.spyOn(core, 'warning').mockImplementation(jest.fn())
    jest.spyOn(core, 'info').mockImplementation(jest.fn())
    jest.spyOn(core, 'debug').mockImplementation(jest.fn())
  })

  afterEach(() => {
    // Unregister mocks
    jest.restoreAllMocks()
  })

  const cleansWhenCleanTrue = 'cleans when clean true'
  it(cleansWhenCleanTrue, async () => {
    // Arrange
    await setup(cleansWhenCleanTrue)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.tryClean).toHaveBeenCalled()
    expect(git.tryReset).toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  const checkoutDetachWhenNotDetached = 'checkout detach when not detached'
  it(checkoutDetachWhenNotDetached, async () => {
    // Arrange
    await setup(checkoutDetachWhenNotDetached)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.checkoutDetach).toHaveBeenCalled()
  })

  const doesNotCheckoutDetachWhenNotAlreadyDetached =
    'does not checkout detach when already detached'
  it(doesNotCheckoutDetachWhenNotAlreadyDetached, async () => {
    // Arrange
    await setup(doesNotCheckoutDetachWhenNotAlreadyDetached)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    const mockIsDetached = git.isDetached as jest.Mock<any, any>
    mockIsDetached.mockImplementation(async () => {
      return true
    })

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.checkoutDetach).not.toHaveBeenCalled()
  })

  const doesNotCleanWhenCleanFalse = 'does not clean when clean false'
  it(doesNotCleanWhenCleanFalse, async () => {
    // Arrange
    await setup(doesNotCleanWhenCleanFalse)
    clean = false
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.isDetached).toHaveBeenCalled()
    expect(git.branchList).toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
    expect(git.tryClean).not.toHaveBeenCalled()
    expect(git.tryReset).not.toHaveBeenCalled()
  })

  const removesContentsWhenCleanFails = 'removes contents when clean fails'
  it(removesContentsWhenCleanFails, async () => {
    // Arrange
    await setup(removesContentsWhenCleanFails)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    let mockTryClean = git.tryClean as jest.Mock<any, any>
    mockTryClean.mockImplementation(async () => {
      return false
    })

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files).toHaveLength(0)
    expect(git.tryClean).toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalled()
    expect(git.tryReset).not.toHaveBeenCalled()
  })

  const removesContentsWhenDifferentRepositoryUrl =
    'removes contents when different repository url'
  it(removesContentsWhenDifferentRepositoryUrl, async () => {
    // Arrange
    await setup(removesContentsWhenDifferentRepositoryUrl)
    clean = false
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    const differentRepositoryUrl =
      'https://github.com/my-different-org/my-different-repo'

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      differentRepositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files).toHaveLength(0)
    expect(core.warning).not.toHaveBeenCalled()
    expect(git.isDetached).not.toHaveBeenCalled()
  })

  const removesContentsWhenNoGitDirectory =
    'removes contents when no git directory'
  it(removesContentsWhenNoGitDirectory, async () => {
    // Arrange
    await setup(removesContentsWhenNoGitDirectory)
    clean = false
    await io.rmRF(path.join(repositoryPath, '.git'))
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files).toHaveLength(0)
    expect(core.warning).not.toHaveBeenCalled()
    expect(git.isDetached).not.toHaveBeenCalled()
  })

  const removesContentsWhenResetFails = 'removes contents when reset fails'
  it(removesContentsWhenResetFails, async () => {
    // Arrange
    await setup(removesContentsWhenResetFails)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    let mockTryReset = git.tryReset as jest.Mock<any, any>
    mockTryReset.mockImplementation(async () => {
      return false
    })

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files).toHaveLength(0)
    expect(git.tryClean).toHaveBeenCalled()
    expect(git.tryReset).toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalled()
  })

  const removesContentsWhenUndefinedGitCommandManager =
    'removes contents when undefined git command manager'
  it(removesContentsWhenUndefinedGitCommandManager, async () => {
    // Arrange
    await setup(removesContentsWhenUndefinedGitCommandManager)
    clean = false
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      undefined,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files).toHaveLength(0)
    expect(core.warning).not.toHaveBeenCalled()
  })

  const removesLocalBranches = 'removes local branches'
  it(removesLocalBranches, async () => {
    // Arrange
    await setup(removesLocalBranches)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    const mockBranchList = git.branchList as jest.Mock<any, any>
    mockBranchList.mockImplementation(async (remote: boolean) => {
      return remote ? [] : ['local-branch-1', 'local-branch-2']
    })

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.branchDelete).toHaveBeenCalledWith(false, 'local-branch-1')
    expect(git.branchDelete).toHaveBeenCalledWith(false, 'local-branch-2')
  })

  const cleanWhenSubmoduleStatusIsFalse =
    'cleans when submodule status is false'

  it(cleanWhenSubmoduleStatusIsFalse, async () => {
    // Arrange
    await setup(cleanWhenSubmoduleStatusIsFalse)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    //mock bad submodule

    const submoduleStatus = git.submoduleStatus as jest.Mock<any, any>
    submoduleStatus.mockImplementation(async (remote: boolean) => {
      return false
    })

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files).toHaveLength(0)
    expect(git.tryClean).toHaveBeenCalled()
  })

  const doesNotCleanWhenSubmoduleStatusIsTrue =
    'does not clean when submodule status is true'

  it(doesNotCleanWhenSubmoduleStatusIsTrue, async () => {
    // Arrange
    await setup(doesNotCleanWhenSubmoduleStatusIsTrue)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    const submoduleStatus = git.submoduleStatus as jest.Mock<any, any>
    submoduleStatus.mockImplementation(async (remote: boolean) => {
      return true
    })

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert

    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.tryClean).toHaveBeenCalled()
  })

  const removesLockFiles = 'removes lock files'
  it(removesLockFiles, async () => {
    // Arrange
    await setup(removesLockFiles)
    clean = false
    await fs.promises.writeFile(
      path.join(repositoryPath, '.git', 'index.lock'),
      ''
    )
    await fs.promises.writeFile(
      path.join(repositoryPath, '.git', 'shallow.lock'),
      ''
    )
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    let files = await fs.promises.readdir(path.join(repositoryPath, '.git'))
    expect(files).toHaveLength(0)
    files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.isDetached).toHaveBeenCalled()
    expect(git.branchList).toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
    expect(git.tryClean).not.toHaveBeenCalled()
    expect(git.tryReset).not.toHaveBeenCalled()
  })

  const removesEveryAbandonedLockFile = 'removes every abandoned lock file'
  it(removesEveryAbandonedLockFile, async () => {
    // Arrange: the locks a canceled `git sparse-checkout set`, `git config`,
    // `git update-ref` and a submodule fetch leave behind
    await setup(removesEveryAbandonedLockFile)
    clean = false
    const gitDir = path.join(repositoryPath, '.git')
    const abandoned = [
      path.join(gitDir, 'info', 'sparse-checkout.lock'),
      path.join(gitDir, 'config.lock'),
      path.join(gitDir, 'HEAD.lock'),
      path.join(gitDir, 'packed-refs.lock'),
      path.join(gitDir, 'refs', 'remotes', 'origin', 'main.lock'),
      path.join(gitDir, 'modules', 'third_party', 'dlss', 'shallow.lock'),
      path.join(gitDir, 'modules', 'third_party', 'dlss', 'index.lock')
    ]
    for (const lockPath of abandoned) {
      await fs.promises.mkdir(path.dirname(lockPath), {recursive: true})
      await fs.promises.writeFile(lockPath, '')
    }
    const kept = [
      path.join(gitDir, 'info', 'sparse-checkout'),
      path.join(gitDir, 'objects', 'pack', 'pack-1.keep')
    ]
    for (const keptPath of kept) {
      await fs.promises.mkdir(path.dirname(keptPath), {recursive: true})
      await fs.promises.writeFile(keptPath, '')
    }

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    for (const lockPath of abandoned) {
      expect(fs.existsSync(lockPath)).toBe(false)
    }
    for (const keptPath of kept) {
      expect(fs.existsSync(keptPath)).toBe(true)
    }
    expect(core.warning).not.toHaveBeenCalled()
  })

  // A lock's holder is read from /proc, which only a Linux host has.
  const itWithProc = fs.existsSync('/proc/self/fd') ? it : it.skip

  const keepsALockFileALiveProcessHolds =
    'keeps a lock file a live process holds'
  itWithProc(keepsALockFileALiveProcessHolds, async () => {
    // Arrange: a live process with the lock open, as a running git holds it
    await setup(keepsALockFileALiveProcessHolds)
    const held = path.join(
      repositoryPath,
      '.git',
      'info',
      'sparse-checkout.lock'
    )
    const abandoned = path.join(repositoryPath, '.git', 'config.lock')
    await fs.promises.mkdir(path.dirname(held), {recursive: true})
    await fs.promises.writeFile(held, '')
    await fs.promises.writeFile(abandoned, '')
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    const holder = spawn(
      'sh',
      ['-c', 'exec 3<"$0"; echo ready; exec sleep 30', held],
      {
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await new Promise<void>(resolve =>
      holder.stdout.once('data', () => resolve())
    )

    try {
      // Act
      const prepared = gitDirectoryHelper.prepareExistingDirectory(
        git,
        repositoryPath,
        repositoryUrl,
        clean,
        ref
      )

      // Assert: the checkout stops, naming the lock and its holder, and
      // leaves the repository as it is
      await expect(prepared).rejects.toThrow(
        `'${held}' is held by process ${holder.pid} (sleep)`
      )
      expect(fs.existsSync(held)).toBe(true)
      expect(fs.existsSync(abandoned)).toBe(false)
      expect(fs.existsSync(path.join(repositoryPath, 'my-file'))).toBe(true)
      expect(git.isDetached).not.toHaveBeenCalled()
      expect(git.tryClean).not.toHaveBeenCalled()
    } finally {
      holder.kill('SIGKILL')
    }
  })

  const keepsEveryLockWhileGitRunsInTheRepository =
    'keeps every lock while git runs in the repository'
  itWithProc(keepsEveryLockWhileGitRunsInTheRepository, async () => {
    // Arrange: a live git process whose working directory is the repository
    await setup(keepsEveryLockWhileGitRunsInTheRepository)
    execFileSync('git', ['init', '--quiet', repositoryPath])
    const locks = [
      path.join(repositoryPath, '.git', 'info', 'sparse-checkout.lock'),
      path.join(repositoryPath, '.git', 'config.lock')
    ]
    await fs.promises.mkdir(path.join(repositoryPath, '.git', 'info'), {
      recursive: true
    })
    for (const lockPath of locks) {
      await fs.promises.writeFile(lockPath, '')
    }
    const running = spawn('git', ['hash-object', '--stdin'], {
      cwd: repositoryPath,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    const comm = path.join('/proc', `${running.pid}`, 'comm')
    while (
      !fs.existsSync(comm) ||
      fs.readFileSync(comm, 'utf8').trim() !== 'git'
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    try {
      // Act
      const prepared = gitDirectoryHelper.prepareExistingDirectory(
        git,
        repositoryPath,
        repositoryUrl,
        clean,
        ref
      )

      // Assert: every lock stays and the checkout stops, naming the process
      await expect(prepared).rejects.toThrow(
        `process ${running.pid} (git), running in the repository`
      )
      for (const lockPath of locks) {
        expect(fs.existsSync(lockPath)).toBe(true)
      }
      expect(git.isDetached).not.toHaveBeenCalled()
      expect(git.tryClean).not.toHaveBeenCalled()
    } finally {
      running.kill('SIGKILL')
    }
  })

  const removesAncestorRemoteBranch = 'removes ancestor remote branch'
  it(removesAncestorRemoteBranch, async () => {
    // Arrange
    await setup(removesAncestorRemoteBranch)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    const mockBranchList = git.branchList as jest.Mock<any, any>
    mockBranchList.mockImplementation(async (remote: boolean) => {
      return remote ? ['origin/remote-branch-1', 'origin/remote-branch-2'] : []
    })
    ref = 'remote-branch-1/conflict'

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.branchDelete).toHaveBeenCalledTimes(1)
    expect(git.branchDelete).toHaveBeenCalledWith(
      true,
      'origin/remote-branch-1'
    )
  })

  const removesDescendantRemoteBranches = 'removes descendant remote branch'
  it(removesDescendantRemoteBranches, async () => {
    // Arrange
    await setup(removesDescendantRemoteBranches)
    await fs.promises.writeFile(path.join(repositoryPath, 'my-file'), '')
    const mockBranchList = git.branchList as jest.Mock<any, any>
    mockBranchList.mockImplementation(async (remote: boolean) => {
      return remote
        ? ['origin/remote-branch-1/conflict', 'origin/remote-branch-2']
        : []
    })
    ref = 'remote-branch-1'

    // Act
    await gitDirectoryHelper.prepareExistingDirectory(
      git,
      repositoryPath,
      repositoryUrl,
      clean,
      ref
    )

    // Assert
    const files = await fs.promises.readdir(repositoryPath)
    expect(files.sort()).toEqual(['.git', 'my-file'])
    expect(git.branchDelete).toHaveBeenCalledTimes(1)
    expect(git.branchDelete).toHaveBeenCalledWith(
      true,
      'origin/remote-branch-1/conflict'
    )
  })
})

async function setup(testName: string): Promise<void> {
  testName = testName.replace(/[^a-zA-Z0-9_]+/g, '-')

  // Repository directory
  repositoryPath = path.join(testWorkspace, testName)
  await fs.promises.mkdir(path.join(repositoryPath, '.git'), {recursive: true})

  // Repository URL
  repositoryUrl = 'https://github.com/my-org/my-repo'

  // Clean
  clean = true

  // Ref
  ref = ''

  // Git command manager
  git = {
    branchDelete: jest.fn(),
    branchExists: jest.fn(),
    branchList: jest.fn(async () => {
      return []
    }),
    disableSparseCheckout: jest.fn(),
    sparseCheckout: jest.fn(),
    sparseCheckoutNonConeMode: jest.fn(),
    checkout: jest.fn(),
    checkoutDetach: jest.fn(),
    config: jest.fn(),
    configExists: jest.fn(),
    fetch: jest.fn(),
    getDefaultBranch: jest.fn(),
    getWorkingDirectory: jest.fn(() => repositoryPath),
    init: jest.fn(),
    isDetached: jest.fn(),
    lfsFetch: jest.fn(),
    lfsInstall: jest.fn(),
    log1: jest.fn(),
    remoteAdd: jest.fn(),
    removeEnvironmentVariable: jest.fn(),
    revParse: jest.fn(),
    setEnvironmentVariable: jest.fn(),
    shaExists: jest.fn(),
    submoduleForeach: jest.fn(),
    submoduleSync: jest.fn(),
    submoduleUpdate: jest.fn(),
    submoduleStatus: jest.fn(async () => {
      return true
    }),
    tagExists: jest.fn(),
    tryClean: jest.fn(async () => {
      return true
    }),
    tryConfigUnset: jest.fn(),
    tryDisableAutomaticGarbageCollection: jest.fn(),
    tryGetFetchUrl: jest.fn(async () => {
      // Sanity check - this function shouldn't be called when the .git directory doesn't exist
      await fs.promises.stat(path.join(repositoryPath, '.git'))
      return repositoryUrl
    }),
    getSubmoduleConfigPaths: jest.fn(async () => {
      return []
    }),
    tryConfigUnsetValue: jest.fn(async () => {
      return true
    }),
    tryGetConfigValues: jest.fn(async () => {
      return []
    }),
    tryGetConfigKeys: jest.fn(async () => {
      return []
    }),
    tryReset: jest.fn(async () => {
      return true
    }),
    version: jest.fn()
  }
}
