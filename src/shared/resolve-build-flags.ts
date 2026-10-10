/**
 * Decides the build-time flags that electron.vite.config.ts injects. Pulled out of the config
 * so a test can prove which kinds of build get cloud sync: `electron-vite dev` and the dev
 * build (`package:win:dev`) have it, a release or packaged build never does unless a private
 * build opts in with WINGLOG_CLOUD_SYNC=1 (docs: winglog-backend decisions.md, 2026-10-10,
 * "cloud sync is a parallel dev-build track").
 */
export interface BuildFlags {
  cloudSyncEnabled: boolean
  devBuild: boolean
}

/**
 * Maps the electron-vite command and the environment to the flags the build injects.
 * @param command - `serve` for `electron-vite dev`, `build` for every build.
 * @param env - the environment variables of the build process.
 * @returns the flags to inject.
 */
export function resolveBuildFlags(
  command: 'serve' | 'build',
  env: Record<string, string | undefined>
): BuildFlags {
  const devBuild = env.WINGLOG_DEV_BUILD === '1'
  return {
    devBuild,
    cloudSyncEnabled: command === 'serve' || devBuild || env.WINGLOG_CLOUD_SYNC === '1'
  }
}
