// 纯 CommonJS 写法：
// - EdgeOne/OpenNext 构建期以 CJS require 加载本文件，出现 export 会报 Unexpected token 'export'
// - 运行期加载上下文可能没有 require，因此不能调用 require('path')
// 故这里既不用 export，也不用 require，路径直接用 process.cwd() 拼接。
var config = {
  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['de-DE', 'en', 'es', 'zh-CN', 'hi', 'id', 'tr-TR', 'zh-TW'],
    // 关闭自动语言检测，直接使用默认语言，避免重定向耗时
    localeDetection: false,
  },
  localePath: process.cwd() + '/public/locales',
  reloadOnPrerender: process.env.NODE_ENV === 'development',
  keySeparator: false,
  namespaceSeparator: false,
  pluralSeparator: '——',
  contextSeparator: '——',
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = config
  module.exports.i18n = config.i18n
  module.exports.localePath = config.localePath
  module.exports.default = config
}