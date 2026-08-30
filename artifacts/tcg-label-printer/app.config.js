const { expo } = require('./app.json');

const buildId = process.env.EXPO_PUBLIC_BUILD_ID || process.env.GITHUB_RUN_NUMBER;
const parsedVersionCode = Number.parseInt(
  process.env.ANDROID_VERSION_CODE || process.env.GITHUB_RUN_NUMBER || '',
  10,
);

module.exports = ({ config }) => ({
  ...expo,
  ...config,
  version: buildId ? `${expo.version}-build.${buildId}` : expo.version,
  android: {
    ...expo.android,
    ...config.android,
    ...(Number.isSafeInteger(parsedVersionCode) && parsedVersionCode > 0
      ? { versionCode: parsedVersionCode }
      : {}),
  },
});