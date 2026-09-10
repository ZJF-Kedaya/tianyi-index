import '@fortawesome/fontawesome-svg-core/styles.css'

import '../styles/globals.css'
import '../styles/markdown-github.css'
import '../styles/glassmorphism.css'
import { Analytics } from '@vercel/analytics/react'
import { useRouter } from 'next/router'

const { library, config } = require('@fortawesome/fontawesome-svg-core')
config.autoAddCss = false

import {
  faFileImage,
  faFilePdf,
  faFileWord,
  faFilePowerpoint,
  faFileExcel,
  faFileAudio,
  faFileVideo,
  faFileArchive,
  faFileCode,
  faFileAlt,
  faFile,
  faFolder,
  faCopy,
  faArrowAltCircleDown,
  faTrashAlt,
  faEnvelope,
  faFlag,
  faCheckCircle,
} from '@fortawesome/free-regular-svg-icons'
import {
  faSearch,
  faPen,
  faCheck,
  faPlus,
  faMinus,
  faCopy as faCopySolid,
  faAngleRight,
  faDownload,
  faTh,
  faThLarge,
  faThList,
  faLanguage,
  faCube,
} from '@fortawesome/free-solid-svg-icons'
import {
  faGithub,
  faGitlab,
  faBitbucket,
  faWeibo,
  faZhihu,
  faBilibili,
  faQq,
  faWeixin,
  faTelegram,
  faXTwitter,
  faDiscord,
  faYoutube,
  faMarkdown,
} from '@fortawesome/free-brands-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'

import type { AppProps } from 'next/app'
import NextNProgress from 'nextjs-progressbar'
import BackgroundImage from '../components/BackgroundImage'
import { appWithTranslation } from 'next-i18next'
import siteConfig from '../../config/site.config'
import { useIsAdmin } from '../utils/useIsAdmin'

// i18n 配置内联于此，与 next.config.js 保持一致。
// 原因：EdgeOne/OpenNext 运行期按 ESM 加载 next-i18next.config.js，读不到 CommonJS 的导出，
// 导致 appWithTranslation was called without config.i18n。这里显式传入配置，彻底规避该问题。
const i18nConfig = {
  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['de-DE', 'en', 'es', 'zh-CN', 'hi', 'id', 'tr-TR', 'zh-TW'],
    localeDetection: false,
  },
  localePath: '/public/locales',
  reloadOnPrerender: process.env.NODE_ENV === 'development',
  keySeparator: false,
  namespaceSeparator: false,
  pluralSeparator: '——',
  contextSeparator: '——',
}

// 常用 brand 图标映射：key 是 siteConfig.links 里 name 的小写形式
const brandIconMap: Record<string, IconDefinition> = {
  github: faGithub,
  gitlab: faGitlab,
  bitbucket: faBitbucket,
  weibo: faWeibo,
  zhihu: faZhihu,
  bilibili: faBilibili,
  qq: faQq,
  weixin: faWeixin,
  telegram: faTelegram,
  twitter: faXTwitter,
  x: faXTwitter,
  discord: faDiscord,
  youtube: faYoutube,
  markdown: faMarkdown,
}

const usedBrandIcons = Array.from(
  new Set(
    Object.values(siteConfig.links || {})
      .map((link: { name?: string }) => link?.name?.toLowerCase())
      .filter((name): name is string => !!name && name in brandIconMap)
      .map(name => brandIconMap[name])
  )
)

library.add(
  faFileImage,
  faFilePdf,
  faFileWord,
  faFilePowerpoint,
  faFileExcel,
  faFileAudio,
  faFileVideo,
  faFileArchive,
  faFileCode,
  faFileAlt,
  faFile,
  faFolder,
  faCopy,
  faArrowAltCircleDown,
  faTrashAlt,
  faEnvelope,
  faFlag,
  faCheckCircle,
  faSearch,
  faPen,
  faCheck,
  faPlus,
  faMinus,
  faCopySolid,
  faAngleRight,
  faDownload,
  faTh,
  faThLarge,
  faThList,
  faLanguage,
  faPen,
  faCube,
  faMarkdown,
  ...usedBrandIcons
)

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter()
  // 管理员登录后不加载统计代码（Vercel Analytics）
  const isAdmin = useIsAdmin()
  const isAdminManagePage = router.asPath.startsWith('/@manage') || router.pathname === '/_admin-manage'

  return (
    <>
      {!isAdminManagePage && <BackgroundImage />}

      <NextNProgress height={1} color="rgb(156, 163, 175, 0.9)" options={{ showSpinner: false }} />
      {!isAdmin && <Analytics />}
      <Component {...pageProps} />
    </>
  )
}

export default appWithTranslation(MyApp, i18nConfig)