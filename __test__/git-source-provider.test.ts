import * as core from '@actions/core'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as gitSourceProvider from '../lib/git-source-provider'
import * as http from 'http'
import * as io from '@actions/io'
import * as path from 'path'
import {AddressInfo} from 'net'
import {execFileSync, spawn} from 'child_process'
import {IGitSourceSettings} from '../lib/git-source-settings'

const testWorkspace = path.join(__dirname, '_temp', 'git-source-provider')
const owner = 'owner'
const name = 'repo'
const submoduleName = 'sub'
// A failed fetch is tried three times, 10 to 20 s apart.
const gitTestTimeout = 120000

let server: http.Server
let serverUrl: string
let projectRoot: string
let authorPath: string
let repositoryPath: string
let originalRunnerTemp: string | undefined

describe('git-source-provider tests', () => {
  beforeAll(async () => {
    await io.rmRF(testWorkspace)
    projectRoot = path.join(testWorkspace, 'server')
    server = await startGitHttpServer(projectRoot)
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    // The submodule fetch configures its auth in a global git config the
    // checkout writes under RUNNER_TEMP.
    originalRunnerTemp = process.env['RUNNER_TEMP']
    process.env['RUNNER_TEMP'] = path.join(testWorkspace, 'runner-temp')
    await io.mkdirP(process.env['RUNNER_TEMP'])
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
    if (originalRunnerTemp === undefined) {
      delete process.env['RUNNER_TEMP']
    } else {
      process.env['RUNNER_TEMP'] = originalRunnerTemp
    }
  })

  beforeEach(() => {
    jest.spyOn(core, 'error').mockImplementation(jest.fn())
    jest.spyOn(core, 'warning').mockImplementation(jest.fn())
    jest.spyOn(core, 'info').mockImplementation(jest.fn())
    jest.spyOn(core, 'debug').mockImplementation(jest.fn())
    jest.spyOn(core, 'startGroup').mockImplementation(jest.fn())
    jest.spyOn(core, 'endGroup').mockImplementation(jest.fn())
    jest.spyOn(core, 'saveState').mockImplementation(jest.fn())
    jest.spyOn(core, 'setOutput').mockImplementation(jest.fn())
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const indexNamesAnObjectNobodyServes =
    'recreates a kept repository whose index names an object the store lacks and the remote does not serve (OrigoZero/zero#25635)'
  it(
    indexNamesAnObjectNobodyServes,
    async () => {
      // A sparse checkout leaves dir-b/b.txt skip-worktree in a partial
      // clone, its blob never fetched.
      await setup(indexNamesAnObjectNobodyServes)
      const first = await commit({
        'dir-a/a.txt': 'a, first\n',
        'dir-b/b.txt': uniqueText('b')
      })
      await gitSourceProvider.getSource(settingsFor(first, ['dir-a']))
      expect(fs.existsSync(path.join(repositoryPath, 'dir-b', 'b.txt'))).toBe(
        false
      )

      // A bit flips in the index entry's object name as git writes the
      // index, so the index's own checksum holds.
      const blob = git(repositoryPath, 'rev-parse', `${first}:dir-b/b.txt`)
      const named = flipIndexEntryObjectName(repositoryPath, blob)
      expect(() =>
        git(path.join(projectRoot, owner, name), 'cat-file', '-e', named)
      ).toThrow()

      // The next job checks out the whole tree of a new commit.
      const second = await commit({'dir-a/a.txt': 'a, second\n'})
      await gitSourceProvider.getSource(settingsFor(second, undefined))

      await expectCheckedOut(second)
    },
    gitTestTimeout
  )

  const packHoldsACorruptObject =
    'recreates a kept repository whose pack holds a corrupt object read by the checkout (OrigoZero/zero#25433)'
  it(
    packHoldsACorruptObject,
    async () => {
      const first = await arrangeCorruptPack(packHoldsACorruptObject)

      // The job runs again at the same commit: the fetch brings nothing new,
      // and the checkout reads the corrupt blob.
      await gitSourceProvider.getSource(settingsFor(first, undefined))

      await expectCheckedOut(first)
    },
    gitTestTimeout
  )

  const packHoldsACorruptObjectTheFetchReads =
    'recreates a kept repository whose pack holds a corrupt object read by the fetch (OrigoZero/zero#25433)'
  it(
    packHoldsACorruptObjectTheFetchReads,
    async () => {
      await arrangeCorruptPack(packHoldsACorruptObjectTheFetchReads)

      // The next job checks out a new commit holding the same blob: the fetch
      // reads the corrupt copy as it stores the one it received.
      const second = await commit({'dir-a/a.txt': 'a, second\n'})
      await gitSourceProvider.getSource(settingsFor(second, undefined))

      await expectCheckedOut(second)
    },
    gitTestTimeout
  )

  const submoduleStoreHoldsACorruptObject =
    'recreates a kept repository whose submodule store holds a corrupt object read by the submodule update'
  it(
    submoduleStoreHoldsACorruptObject,
    async () => {
      await setup(submoduleStoreHoldsACorruptObject)
      const submoduleAuthor = await serveRepository(submoduleName)
      const subFirst = await commit(
        {'s1.txt': 's1, first\n', 's2.txt': uniqueText('s2')},
        {},
        submoduleAuthor
      )
      const first = await commit(
        {
          '.gitmodules': `[submodule "sub"]\n\tpath = sub\n\turl = ../${submoduleName}\n`,
          'dir-a/a.txt': 'a, first\n',
          'dir-b/b.txt': uniqueText('b')
        },
        {sub: subFirst}
      )
      await gitSourceProvider.getSource(
        withSubmodules(settingsFor(first, undefined))
      )
      const submodulePath = path.join(repositoryPath, 'sub')
      expect(git(submodulePath, 'rev-parse', 'HEAD')).toBe(subFirst)

      // A bit flips in the submodule's stored copy of s2.txt's blob.
      const blob = git(submodulePath, 'rev-parse', `${subFirst}:s2.txt`)
      corruptObject(path.join(repositoryPath, '.git', 'modules', 'sub'), blob)
      expect(() => git(submodulePath, 'cat-file', '-p', blob)).toThrow(
        /is corrupt|data stream error|unable to unpack/
      )

      // The next job checks out a commit pinning a new submodule commit that
      // moves s2.txt to s3.txt: the submodule's checkout writes s3.txt from
      // the stored copy.
      await fs.promises.rename(
        path.join(submoduleAuthor, 's2.txt'),
        path.join(submoduleAuthor, 's3.txt')
      )
      const subSecond = await commit(
        {'s1.txt': 's1, second\n'},
        {},
        submoduleAuthor
      )
      const second = await commit(
        {'dir-a/a.txt': 'a, second\n'},
        {sub: subSecond}
      )
      await gitSourceProvider.getSource(
        withSubmodules(settingsFor(second, undefined))
      )

      await expectCheckedOut(second)
      expect(git(submodulePath, 'rev-parse', 'HEAD')).toBe(subSecond)
      expect(fs.readFileSync(path.join(submodulePath, 's3.txt'), 'utf8')).toBe(
        execFileSync('git', ['show', `${subSecond}:s3.txt`], {
          cwd: submoduleAuthor,
          encoding: 'utf8'
        })
      )
      expect(git(submodulePath, 'status', '--porcelain')).toBe('')
      git(submodulePath, 'fsck', '--no-dangling')
    },
    gitTestTimeout
  )

  const failsOnceInAFreshDirectory =
    'reports a failed checkout in a fresh directory without recreating it'
  it(
    failsOnceInAFreshDirectory,
    async () => {
      await setup(failsOnceInAFreshDirectory)
      await commit({'dir-a/a.txt': 'a\n'})
      const unknown = crypto.randomBytes(20).toString('hex')

      await expect(
        gitSourceProvider.getSource(settingsFor(unknown, undefined))
      ).rejects.toThrow()

      expect(core.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('kept from an earlier job')
      )
    },
    gitTestTimeout
  )
})

/**
 * A kept repository whose pack holds dir-b/b.txt's blob with a flipped bit:
 * a full checkout fetches every blob into one pack (more objects than
 * fetch.unpackLimit), and a sparse checkout then leaves dir-b/b.txt
 * skip-worktree with its blob still in that pack. Returns the commit.
 */
async function arrangeCorruptPack(testName: string): Promise<string> {
  await setup(testName)
  const files: {[file: string]: string} = {
    'dir-a/a.txt': 'a, first\n',
    'dir-b/b.txt': uniqueText('b')
  }
  for (let i = 0; i < 120; i++) {
    files[`dir-c/c${i}.txt`] = uniqueText(`c${i}`)
  }
  const first = await commit(files)
  await gitSourceProvider.getSource(settingsFor(first, undefined))
  await gitSourceProvider.getSource(settingsFor(first, ['dir-a']))
  expect(fs.existsSync(path.join(repositoryPath, 'dir-b', 'b.txt'))).toBe(false)

  const blob = git(repositoryPath, 'rev-parse', `${first}:dir-b/b.txt`)
  corruptObject(path.join(repositoryPath, '.git'), blob)
  expect(() => git(repositoryPath, 'cat-file', '-p', blob)).toThrow(
    /is corrupt|data stream error/
  )
  return first
}

/**
 * The repository holds `commitSha` checked out in full, and the checkout
 * recreated the repository it kept.
 */
async function expectCheckedOut(commitSha: string): Promise<void> {
  expect(git(repositoryPath, 'rev-parse', 'HEAD')).toBe(commitSha)
  expect(
    fs.readFileSync(path.join(repositoryPath, 'dir-b', 'b.txt'), 'utf8')
  ).toBe(fileText(commitSha, 'dir-b/b.txt'))
  expect(git(repositoryPath, 'status', '--porcelain')).toBe('')
  git(repositoryPath, 'fsck', '--no-dangling')
  expect(core.warning).toHaveBeenCalledWith(
    expect.stringContaining(
      'The checkout failed in the repository kept from an earlier job'
    )
  )
}

async function setup(testName: string): Promise<void> {
  testName = testName.replace(/[^a-zA-Z0-9_]+/g, '-')
  const root = path.join(testWorkspace, testName)
  repositoryPath = path.join(root, 'work')
  await io.mkdirP(repositoryPath)
  authorPath = await serveRepository(name)
}

/**
 * Serves an empty repository named `repositoryName` at
 * <projectRoot>/<owner>/<repositoryName>, the path a fetch URL of the
 * checkout names, and returns the path of a new repository that pushes to it.
 */
async function serveRepository(repositoryName: string): Promise<string> {
  const served = path.join(projectRoot, owner, repositoryName)
  await io.rmRF(served)
  await io.mkdirP(served)
  git(served, 'init', '--bare', '-q', '-b', 'main')
  git(served, 'config', 'uploadpack.allowFilter', 'true')
  git(served, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
  git(served, 'config', 'http.receivepack', 'false')

  const author = path.join(
    path.dirname(repositoryPath),
    `${repositoryName}-author`
  )
  await io.rmRF(author)
  await io.mkdirP(author)
  git(author, 'init', '-q', '-b', 'main')
  git(author, 'config', 'user.name', 'test')
  git(author, 'config', 'user.email', 'test@example.com')
  git(author, 'remote', 'add', 'origin', served)
  return author
}

/**
 * Writes `files` in the author repository `author`, records each of
 * `gitlinks` as a submodule at the commit it names, commits and pushes to
 * main.
 */
async function commit(
  files: {[file: string]: string},
  gitlinks: {[file: string]: string} = {},
  author: string = authorPath
): Promise<string> {
  for (const [file, text] of Object.entries(files)) {
    const filePath = path.join(author, file)
    await io.mkdirP(path.dirname(filePath))
    await fs.promises.writeFile(filePath, text)
  }
  git(author, 'add', '--all')
  for (const [file, commitSha] of Object.entries(gitlinks)) {
    git(
      author,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${commitSha},${file}`
    )
  }
  git(author, 'commit', '-q', '-m', 'commit')
  git(author, 'push', '-q', 'origin', 'main')
  return git(author, 'rev-parse', 'HEAD')
}

function fileText(commitSha: string, file: string): string {
  return execFileSync('git', ['show', `${commitSha}:${file}`], {
    cwd: authorPath,
    encoding: 'utf8'
  })
}

function uniqueText(label: string): string {
  return `${label}\n${crypto.randomBytes(512).toString('hex')}\n`
}

function settingsFor(
  commitSha: string,
  sparseCheckout: string[] | undefined
): IGitSourceSettings {
  return {
    repositoryPath,
    repositoryOwner: owner,
    repositoryName: name,
    ref: 'refs/heads/main',
    commit: commitSha,
    clean: true,
    filter: undefined,
    sparseCheckout: sparseCheckout as string[],
    sparseCheckoutConeMode: true,
    fetchDepth: 1,
    fetchTags: false,
    showProgress: false,
    lfs: false,
    submodules: false,
    nestedSubmodules: false,
    authToken: 'token',
    sshKey: '',
    sshKnownHosts: '',
    sshStrict: true,
    sshUser: '',
    persistCredentials: false,
    workflowOrganizationId: undefined,
    setSafeDirectory: false,
    githubServerUrl: serverUrl
  } as IGitSourceSettings
}

function withSubmodules(settings: IGitSourceSettings): IGitSourceSettings {
  return {...settings, submodules: true}
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/**
 * Flips one bit of the object name the index entry for `blob` holds, and
 * writes the index's trailing checksum over the changed bytes, the way an
 * index git wrote from corrupted memory reads. Returns the name the entry
 * then holds.
 */
function flipIndexEntryObjectName(repository: string, blob: string): string {
  const indexPath = path.join(repository, '.git', 'index')
  const bytes = fs.readFileSync(indexPath)
  const at = bytes.indexOf(Buffer.from(blob, 'hex'))
  expect(at).toBeGreaterThan(0)
  expect(bytes.indexOf(Buffer.from(blob, 'hex'), at + 1)).toBe(-1)
  bytes[at + 19] ^= 0x02
  const body = bytes.subarray(0, bytes.length - 20)
  crypto.createHash('sha1').update(body).digest().copy(bytes, body.length)
  fs.writeFileSync(indexPath, bytes)
  return bytes.subarray(at, at + 20).toString('hex')
}

/**
 * Flips one bit in the last byte of the object `objectName` the git directory
 * `gitDir` stores, loose or packed: the adler32 check that closes its zlib
 * stream.
 */
function corruptObject(gitDir: string, objectName: string): void {
  const loose = path.join(
    gitDir,
    'objects',
    objectName.substring(0, 2),
    objectName.substring(2)
  )
  if (fs.existsSync(loose)) {
    fs.chmodSync(loose, 0o644)
    const bytes = fs.readFileSync(loose)
    bytes[bytes.length - 1] ^= 0x01
    fs.writeFileSync(loose, bytes)
    return
  }
  const packDir = path.join(gitDir, 'objects', 'pack')
  for (const idx of fs.readdirSync(packDir).filter(f => f.endsWith('.idx'))) {
    const listing = git(gitDir, 'verify-pack', '-v', path.join(packDir, idx))
    for (const line of listing.split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields[0] !== objectName) {
        continue
      }
      expect(fields.length).toBe(5) // stored whole, not as a delta
      const sizeInPack = Number(fields[3])
      const offset = Number(fields[4])
      const packPath = path.join(packDir, idx.replace(/\.idx$/, '.pack'))
      fs.chmodSync(packPath, 0o644)
      const bytes = fs.readFileSync(packPath)
      bytes[offset + sizeInPack - 1] ^= 0x01
      fs.writeFileSync(packPath, bytes)
      return
    }
  }
  throw new Error(`'${gitDir}' stores no object ${objectName}`)
}

/**
 * Serves the repositories under `root` over git's smart HTTP protocol through
 * `git http-backend`, on a free port of 127.0.0.1. A request carrying more
 * than one Authorization header is answered 400, as GitHub answers it.
 */
async function startGitHttpServer(root: string): Promise<http.Server> {
  await io.mkdirP(root)
  const httpServer = http.createServer((request, response) => {
    const authorizations = request.rawHeaders.filter(
      (header, i) => i % 2 === 0 && header.toLowerCase() === 'authorization'
    )
    if (authorizations.length > 1) {
      response.statusCode = 400
      response.end()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const backend = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: request.method || 'GET',
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.replace(/^\?/, ''),
          CONTENT_TYPE: request.headers['content-type'] || '',
          CONTENT_LENGTH: `${body.length}`,
          HTTP_CONTENT_ENCODING: request.headers['content-encoding'] || '',
          GIT_PROTOCOL: `${request.headers['git-protocol'] || ''}`,
          REMOTE_ADDR: '127.0.0.1'
        }
      })
      const output: Buffer[] = []
      backend.stdout.on('data', chunk => output.push(chunk))
      backend.stderr.on('data', () => undefined)
      backend.on('close', () => {
        const all = Buffer.concat(output)
        const split = all.indexOf('\r\n\r\n')
        const head = all.subarray(0, split).toString('utf8')
        let status = 200
        for (const line of head.split('\r\n')) {
          const colon = line.indexOf(':')
          const key = line.substring(0, colon)
          const value = line.substring(colon + 1).trim()
          if (key.toLowerCase() === 'status') {
            status = Number(value.split(' ')[0])
          } else if (colon > 0) {
            response.setHeader(key, value)
          }
        }
        response.statusCode = status
        response.end(all.subarray(split + 4))
      })
      backend.stdin.end(body)
    })
  })
  await new Promise<void>(resolve =>
    httpServer.listen(0, '127.0.0.1', () => resolve())
  )
  return httpServer
}
