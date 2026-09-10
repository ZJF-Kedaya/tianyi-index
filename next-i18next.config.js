const config = {
  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['de-DE', 'en', 'es', 'zh-CN', 'hi', 'id', 'tr-TR', 'zh-TW'],
    // 关闭自动语言检测，直接使用默认语言，避免重定向耗时
    localeDetection: false,
  },
  // 用 process.cwd() 拼接，避免在 ESM 运行时里 require('path') 报错
  localePath: `${process.cwd()}/public/locales`,
  reloadOnPrerender: process.env.NODE_ENV === 'development',
  keySeparator: false,
  namespaceSeparator: false,
  pluralSeparator: '——',
  contextSeparator: '——',
}

// EdgeOne 运行时以 ESM 方式加载本文件，Vercel/Node 构建链以 CJS 方式 require 本文件。
// 为了让两条链路都能取到配置，这里同时提供 ESM 的 default 导出与 CJS 的 module.exports 兜底。
export default config

/* eslint-disable */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = config
  module.exports.default = config
  module.exports.i18n = config.i18n
  module.exports.localePath = config.localePath
}
