const path = require('path');

const emitCountMap = new Map();
const transformExtensions = /^(gz|map)$/i

function getFileType(str) {
  str = str.replace(/\?.*/, '');
  const split = str.split('.');
  const ext = split.pop();
  if (transformExtensions.test(ext)) {
    ext = split.pop() + '.' + ext;
  }
  return ext;
}

function getAssetName(chunks, chunkName) {
  const filtered = chunks.filter(function (chunk) {
    return chunk.name === chunkName
  }) || [{ files: [] }]

  return filtered[0].files[0]

}

function standardizeFilePaths(file) {
  file.name = file.name.replace(/\\/g, '/');
  file.path = file.path.replace(/\\/g, '/');
  return file;
};

const defaultSerialize = manifest => `window["webpackModuleFiles"] = window["webpackModuleFiles"] || {};
const rawMainfest = ${JSON.stringify(manifest)}
Object.keys(rawMainfest).forEach(function(key) {
  if(!window["webpackModuleFiles"].hasOwnProperty(key)) {
    window["webpackModuleFiles"][key] = rawMainfest[key]
  } else {
    console.log("存在重名模块:" + key)
  }
})`



function getOptions(options) {
  let { name, packageName, manifestName, serialize, ...others } = options
  if (!name) {
    const cwd = process.cwd();
    const pkg = require(`${cwd}/package.json`)
    name = pkg.name
  }
  if (!name) {
    throw new Error(`缺少库名称，可在项目package.json中设置name属性，或实例化时传递`)
  }
  manifestName = `${name}-manifest`
  packageName = name

  if (!serialize) {
    serialize = defaultSerialize
  }


  return {
    manifestName,
    packageName,
    serialize,
    ...others
  }
}


class AsyncModuleBundlePlugin {
  constructor(options) {
    this.options = getOptions(options || {})
  }

  apply(compiler) {
    const pluginOptions = {
      name: 'AsyncModuleBundlePlugin',
      stage: Infinity
    };

    this.updateEntry(compiler)

    this.syncRuntimeHandler(pluginOptions, compiler);
    this.asyncRuntimeHandler(pluginOptions, compiler);
  }
  updateEntry(compiler) {
    const { packageName } = this.options
    const { entry } = compiler.options
    Object.keys(entry).forEach(key => {
      entry[`${packageName}/${key}`] = entry[key];
      delete entry[key]
    })

  }
  syncRuntimeHandler(pluginOptions, compiler) {

    const { manifestName } = this.options
    if (!compiler.options.optimization.runtimeChunk) {
      compiler.options.optimization.runtimeChunk = {}
    }
    // 更换runtimeChunk名称
    compiler.options.optimization.runtimeChunk.name = manifestName
    // 删除runtimeChunk
    compiler.hooks.emit.tap(pluginOptions, function (compilation) {
      delete compilation.assets[getAssetName(compilation.chunks, manifestName)]
    })

  }
  asyncRuntimeHandler(pluginOptions, compiler) {

    this.outputFolder = compiler.options.output.path;
    this.outputFile = path.resolve(this.outputFolder, this.options.manifestName);
    this.moduleAssets = {}

    compiler.hooks.compilation.tap(pluginOptions, compilation => {

      compilation.hooks.moduleAsset.tap(pluginOptions, this.moduleAsset)

      compilation.hooks.beforeModuleIds.tap(pluginOptions, modules => {
        const { context, entry } = compiler.options;
        const entryMirror = Object.keys(entry).reduce((mirror, key) => {
          mirror[entry[key]] = key;
          return mirror
        }, {})
        for (const module of modules) {
          if (module.id !== null && module.libIdent) {
            let moduleId = module.libIdent({ context });
            if (entryMirror[moduleId]) {
              module.id = entryMirror[module.id]
            }
          }
        }
      })

    })

    compiler.hooks.emit.tap(pluginOptions, this.emitHook);
    compiler.hooks.run.tap(pluginOptions, this.beforeRunHook);
    compiler.hooks.watchRun.tap(pluginOptions, this.beforeRunHook);

  }
  moduleAsset = (module, file) => {
    if (module.userRequest) {
      this.moduleAssets[file] = path.join(
        path.dirname(file),
        path.basename(module.userRequest)
      );
    }
  }
  emitHook = (compilation) => {

    const emitCount = emitCountMap.get(this.outputFile) - 1
    emitCountMap.set(this.outputFile, emitCount);

    const { publicPath } = compilation.options.output;
    const stats = compilation.getStats().toJson({
      // Disable data generation of everything we don't use
      all: false,
      // Add asset Information
      assets: true,
      // Show cached assets (setting this to `false` only shows emitted files)
      cachedAssets: true,
    });

    let files = compilation.chunks.reduce(function (files, chunk) {
      return chunk.files.reduce(function (files, path) {
        let name = chunk.name ? chunk.name : null;
        // if (name) {
        //   name = name + '.' + getFileType(path);
        // } else {
        //   // For nameless chunks, just map the files directly.
        //   name = path;
        // }
        if(!name) {
          name = path;
        }
        return files.concat({
          path: path,
          chunk: chunk,
          name: name,
          isInitial: chunk.isOnlyInitial,
          isChunk: true,
          isAsset: false,
          isModuleAsset: false
        });

      }, files);
    }, []);

    // module assets don't show up in assetsByChunkName.
    // we're getting them this way;
    files = stats.assets.reduce((files, asset) => {
      const name = this.moduleAssets[asset.name];
      if (name) {
        return files.concat({
          path: asset.name,
          name: name,
          isInitial: false,
          isChunk: false,
          isAsset: true,
          isModuleAsset: true
        });
      }

      const isEntryAsset = asset.chunks.length > 0;
      if (isEntryAsset) {
        return files;
      }

      return files.concat({
        path: asset.name,
        name: asset.name,
        isInitial: false,
        isChunk: false,
        isAsset: true,
        isModuleAsset: false
      });
    }, files);

    const [manifestRuntime] = files.filter(file => file.name === `${this.options.manifestName}.js`);

    files = files.filter(file => {
      // Don't add hot updates to manifest
      const isUpdateChunk = file.path.indexOf('hot-update') >= 0;
      // Don't add manifest from another instance
      const isManifest = emitCountMap.get(path.join(this.outputFolder, file.name).replace(/\.js$/, "")) !== undefined;
      return !isUpdateChunk && !isManifest;
    });

    // Append optional basepath onto all references.
    // This allows output path to be reflected in the manifest.
    if (this.options.basePath) {
      files = files.map(function (file) {
        file.name = this.options.basePath + file.name;
        return file;
      }.bind(this));
    }

    if (publicPath) {
      // Similar to basePath but only affects the value (similar to how
      // output.publicPath turns require('foo/bar') into '/public/foo/bar', see
      // https://github.com/webpack/docs/wiki/configuration#outputpublicpath
      files = files.map(function (file) {
        file.path = publicPath + file.path;
        return file;
      }.bind(this));
    }

    files = files.map(standardizeFilePaths);

    const manifest = files.reduce(function (manifest, file) {
      manifest[file.name] = file.path;
      return manifest;
    }, {});

    const isLastEmit = emitCount === 0
    if (isLastEmit) {
      const output = this.options.serialize(manifest);

      compilation.assets["index.js"] = {
        source: function () {
          return output;
        },
        size: function () {
          return output.length;
        }
      };
    }

  }
  beforeRunHook = (compiler, callback) => {
    let emitCount = emitCountMap.get(this.outputFile) || 0;
    emitCountMap.set(this.outputFile, emitCount + 1);
    if (callback) {
      callback();
    }
  }
  afterEmitHook

}


module.exports = AsyncModuleBundlePlugin;
