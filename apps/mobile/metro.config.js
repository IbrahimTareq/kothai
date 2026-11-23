const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// @kothai/api is a file: dependency, so node_modules/@kothai/api is a symlink to
// packages/api, which ships raw TypeScript. Metro follows the symlink but only
// serves files under a watched folder: without this the bundle fails with
// "Unable to resolve module @kothai/api". Watch that one package, not the repo
// root, so Metro never crawls data/ or sees the web client's own React.
config.watchFolders = [path.resolve(__dirname, '../../packages/api')]

module.exports = config
