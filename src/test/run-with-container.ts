import { spawn } from 'node:child_process'
import { MySqlContainer } from '@testcontainers/mysql'

function run (cmd: string, args: string[], env: NodeJS.ProcessEnv, shell: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env, shell })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', reject)
  })
}

async function main (): Promise<void> {
  const container = await new MySqlContainer('mysql:8.0').start()

  const testEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: container.getConnectionUri(),
    JWT_SECRET: 'ci-test-secret',
    USE_TESTCONTAINER_DB: '1'
  }

  let exitCode = 1
  try {
    // .cmd shim on Windows can't be exec'd with shell:false (ENOENT); Linux CI doesn't need shell:true but it's harmless there.
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const migrateCode = await run(npxCmd, ['prisma', 'migrate', 'deploy'], testEnv, true)
    if (migrateCode !== 0) {
      exitCode = migrateCode
      return
    }

    // shell:false so node (not a shell) expands the ** glob, matching the `test` script's behavior.
    exitCode = await run(
      'node',
      ['--test', '--test-concurrency=1', 'dist/src/test/**/*.test.js'],
      testEnv,
      false
    )
  } finally {
    await container.stop()
  }

  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
