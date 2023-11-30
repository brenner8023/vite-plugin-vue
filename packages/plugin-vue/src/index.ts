import fs from 'node:fs'
import type { Plugin, ViteDevServer } from 'vite'
import { createFilter } from 'vite'
/* eslint-disable import/no-duplicates */
import type {
  SFCBlock,
  SFCScriptCompileOptions,
  SFCStyleCompileOptions,
  SFCTemplateCompileOptions,
} from 'vue/compiler-sfc'
import type * as _compiler from 'vue/compiler-sfc'
/* eslint-enable import/no-duplicates */
import { computed, shallowRef } from 'vue'
import { version } from '../package.json'
import { resolveCompiler } from './compiler'
import { parseVueRequest } from './utils/query'
import {
  getDescriptor,
  getReadCode,
  getSrcDescriptor,
  getTempSrcDescriptor,
} from './utils/descriptorCache'
import { getResolvedScript, typeDepToSFCMap } from './script'
import { transformMain } from './main'
import { handleHotUpdate, handleTypeDepChange } from './handleHotUpdate'
import { transformTemplateAsModule } from './template'
import { transformStyle } from './style'
import { EXPORT_HELPER_ID, helperCode } from './helper'

export { parseVueRequest } from './utils/query'
export type { VueQuery } from './utils/query'

export interface Options {
  include?: string | RegExp | (string | RegExp)[]
  exclude?: string | RegExp | (string | RegExp)[]

  isProduction?: boolean

  // options to pass on to vue/compiler-sfc
  script?: Partial<
    Pick<
      SFCScriptCompileOptions,
      | 'babelParserPlugins'
      | 'globalTypeFiles'
      | 'defineModel'
      | 'propsDestructure'
      | 'fs'
      | 'hoistStatic'
    >
  >
  template?: Partial<
    Pick<
      SFCTemplateCompileOptions,
      | 'compiler'
      | 'compilerOptions'
      | 'preprocessOptions'
      | 'preprocessCustomRequire'
      | 'transformAssetUrls'
    >
  >
  style?: Partial<Pick<SFCStyleCompileOptions, 'trim'>>

  /**
   * Transform Vue SFCs into custom elements.
   * - `true`: all `*.vue` imports are converted into custom elements
   * - `string | RegExp`: matched files are converted into custom elements
   *
   * @default /\.ce\.vue$/
   */
  customElement?: boolean | string | RegExp | (string | RegExp)[]

  /**
   * Use custom compiler-sfc instance. Can be used to force a specific version.
   */
  compiler?: typeof _compiler
}

export interface ResolvedOptions extends Options {
  compiler: typeof _compiler
  root: string
  sourceMap: boolean
  cssDevSourcemap: boolean
  devServer?: ViteDevServer
  devToolsEnabled?: boolean
  readCode: ReturnType<typeof getReadCode>
}

export interface Api {
  get options(): ResolvedOptions
  set options(value: ResolvedOptions)
  version: string
}

export default function vuePlugin(rawOptions: Options = {}): Plugin<Api> {
  const options = shallowRef<ResolvedOptions>({
    isProduction: process.env.NODE_ENV === 'production',
    compiler: null as any, // to be set in buildStart
    include: /\.vue$/,
    customElement: /\.ce\.vue$/,
    ...rawOptions,
    root: process.cwd(),
    sourceMap: true,
    cssDevSourcemap: false,
    devToolsEnabled: process.env.NODE_ENV !== 'production',
    readCode: getReadCode([]),
  })

  const filter = computed(() =>
    createFilter(options.value.include, options.value.exclude),
  )
  const customElementFilter = computed(() =>
    typeof options.value.customElement === 'boolean'
      ? () => options.value.customElement as boolean
      : createFilter(options.value.customElement),
  )

  return {
    name: 'vite:vue',

    api: {
      get options() {
        return options.value
      },
      set options(value) {
        options.value = value
      },
      version,
    },

    handleHotUpdate(ctx) {
      if (options.value.compiler.invalidateTypeCache) {
        options.value.compiler.invalidateTypeCache(ctx.file)
      }
      if (typeDepToSFCMap.has(ctx.file)) {
        return handleTypeDepChange(typeDepToSFCMap.get(ctx.file)!, ctx)
      }
      if (filter.value(ctx.file)) {
        return handleHotUpdate(ctx, options.value)
      }
    },

    config(config) {
      return {
        resolve: {
          dedupe: config.build?.ssr ? [] : ['vue'],
        },
        define: {
          __VUE_OPTIONS_API__: config.define?.__VUE_OPTIONS_API__ ?? true,
          __VUE_PROD_DEVTOOLS__: config.define?.__VUE_PROD_DEVTOOLS__ ?? false,
        },
        ssr: {
          // @ts-ignore -- config.legacy.buildSsrCjsExternalHeuristics will be removed in Vite 5
          external: config.legacy?.buildSsrCjsExternalHeuristics
            ? ['vue', '@vue/server-renderer']
            : [],
        },
      }
    },

    configResolved(config) {
      options.value = {
        ...options.value,
        readCode: getReadCode(config.plugins),
        root: config.root,
        sourceMap: config.command === 'build' ? !!config.build.sourcemap : true,
        cssDevSourcemap: config.css?.devSourcemap ?? false,
        isProduction: config.isProduction,
        devToolsEnabled:
          !!config.define!.__VUE_PROD_DEVTOOLS__ || !config.isProduction,
      }
    },

    configureServer(server) {
      options.value.devServer = server
    },

    buildStart() {
      const compiler = (options.value.compiler =
        options.value.compiler || resolveCompiler(options.value.root))
      if (compiler.invalidateTypeCache) {
        options.value.devServer?.watcher.on('unlink', (file) => {
          compiler.invalidateTypeCache(file)
        })
      }
    },

    async resolveId(id) {
      // component export helper
      if (id === EXPORT_HELPER_ID) {
        return id
      }
      // serve sub-part requests (*?vue) as virtual modules
      if (parseVueRequest(id).query.vue) {
        return id
      }
    },

    async load(id, opt) {
      const ssr = opt?.ssr === true
      if (id === EXPORT_HELPER_ID) {
        return helperCode
      }

      const { filename, query } = parseVueRequest(id)

      // select corresponding block for sub-part virtual modules
      if (query.vue) {
        if (query.src) {
          return fs.readFileSync(filename, 'utf-8')
        }
        const descriptor = (await getDescriptor(filename, options.value))!
        let block: SFCBlock | null | undefined
        if (query.type === 'script') {
          // handle <script> + <script setup> merge via compileScript()
          block = getResolvedScript(descriptor, ssr)
        } else if (query.type === 'template') {
          block = descriptor.template!
        } else if (query.type === 'style') {
          block = descriptor.styles[query.index!]
        } else if (query.index != null) {
          block = descriptor.customBlocks[query.index]
        }
        if (block) {
          return {
            code: block.content,
            map: block.map as any,
          }
        }
      }
    },

    async transform(code, id, opt) {
      const ssr = opt?.ssr === true
      const { filename, query } = parseVueRequest(id)

      if (query.raw || query.url) {
        return
      }

      if (!filter.value(filename) && !query.vue) {
        return
      }

      if (!query.vue) {
        // main request
        return transformMain(
          code,
          filename,
          options.value,
          this,
          ssr,
          customElementFilter.value(filename),
        )
      } else {
        // sub block request
        const descriptor = query.src
          ? getSrcDescriptor(filename, query) ||
            getTempSrcDescriptor(filename, query)
          : (await getDescriptor(filename, options.value))!

        if (query.type === 'template') {
          return transformTemplateAsModule(
            code,
            descriptor,
            options.value,
            this,
            ssr,
          )
        } else if (query.type === 'style') {
          return transformStyle(
            code,
            descriptor,
            Number(query.index || 0),
            options.value,
            this,
            filename,
          )
        }
      }
    },
  }
}
