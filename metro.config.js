const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite's web worker imports a .wasm file (web dev preview only).
config.resolver.assetExts.push('wasm');

module.exports = config;
