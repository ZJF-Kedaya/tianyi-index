const path = require('path')

// i18n 配置已内联进 next.config.js，这里同步内联一份供 i18next-parser 使用。
const i18n = {
  defaultLocale: 'zh-CN',
  locales: ['de-DE', 'en', 'es', 'zh-CN', 'hi', 'id', 'tr-TR', 'zh-TW'],
  localeDetection: false,
}

const localePath = path.resolve('public/locales')

module.exports = {
  createOldCatalogs: false,
  defaultNamespace: 'common',
  defaultValue: (lng, _ns, key) => (lng === i18n.defaultLocale ? key : ''),
  keySeparator: false,
  nsSeparator: false,
  pluralSeparator: '——',
  contextSeparator: '——',
  lineEnding: 'lf',
  locales: i18n.locales,
  output: path.join(localePath, '$LOCALE/$NAMESPACE.json'),
  input: ['**/*.{ts,tsx}', '!**/node_modules/**'],
  sort: true,
}
