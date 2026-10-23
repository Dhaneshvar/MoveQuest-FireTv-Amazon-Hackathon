const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// The local file dependency lives outside this Expo app's project root.
config.watchFolders = [...new Set([...config.watchFolders, path.resolve(__dirname, '../../packages/game-kit')])];
module.exports = config;
