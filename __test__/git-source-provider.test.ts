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
// A failed fetch is tried three times, 10 to 20 s apart.
const gitTestTimeout = 120000

let server: http.Server
let serverUrl: string
let projectRoot: string
let authorPath: string
let repositoryPath: string

describe('git-source-provider tests', () => {
  beforeAll(async () => {
    await io.rmRF(testWorkspace)
    projectRoot = path.join(testWorkspace, 'server')
    server = await startGitHttpServer(projectRoot)
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
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
  corruptPackedObject(repositoryPath, blob)
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
  authorPath = path.join(root, 'author')
  await io.mkdirP(repositoryPath)
  await io.mkdirP(authorPath)

  // The served repository is <projectRoot>/<owner>/<name>, the path the
  // checkout's fetch URL names.
  const served = path.join(projectRoot, owner, name)
  await io.rmRF(served)
  await io.mkdirP(served)
  git(served, 'init', '--bare', '-q', '-b', 'main')
  git(served, 'config', 'uploadpack.allowFilter', 'true')
  git(served, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
  git(served, 'config', 'http.receivepack', 'false')

  git(authorPath, 'init', '-q', '-b', 'main')
  git(authorPath, 'config', 'user.name', 'test')
  git(authorPath, 'config', 'user.email', 'test@example.com')
  git(authorPath, 'remote', 'add', 'origin', served)
}

/** Writes `files` in the author repository, commits and pushes to main. */
async function commit(files: {[file: string]: string}): Promise<string> {
  for (const [file, text] of Object.entries(files)) {
    const filePath = path.join(authorPath, file)
    await io.mkdirP(path.dirname(filePath))
    await fs.promises.writeFile(filePath, text)
  }
  git(authorPath, 'add', '--all')
  git(authorPath, 'commit', '-q', '-m', 'commit')
  git(authorPath, 'push', '-q', 'origin', 'main')
  return git(authorPath, 'rev-parse', 'HEAD')
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
 * Flips one bit in the last byte of the packed object `objectName`, the
 * adler32 check that closes its zlib stream.
 */
function corruptPackedObject(repository: string, objectName: string): void {
  const packDir = path.join(repository, '.git', 'objects', 'pack')
  for (const idx of fs.readdirSync(packDir).filter(f => f.endsWith('.idx'))) {
    const listing = git(
      repository,
      'verify-pack',
      '-v',
      path.join(packDir, idx)
    )
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
  throw new Error(`No pack of '${repository}' holds ${objectName}`)
}

/**
 * Serves the repositories under `root` over git's smart HTTP protocol through
 * `git http-backend`, on a free port of 127.0.0.1.
 */
async function startGitHttpServer(root: string): Promise<http.Server> {
  await io.mkdirP(root)
  const httpServer = http.createServer((request, response) => {
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
