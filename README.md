# @async-module/bundle-plugin
help the third lib bundle as an async module


## get start

### install
```sh
npm install @async-module/bundle-plugin -D
# or
yarn add @async-module/bundle-plugin -D
```

### webpack config
```js
const AsyncModulePlugin = require("@async-module/bundle-plugin");
const path = require('path');
module.exports = {
   entry: {
    "common/module1": './src/module1.js',
    "common/module2": './src/module2.js',
    "common/module3": './src/module3.js',
  },
   output: {
    filename: '[name].[chunkhash:6].js',
    path: path.resolve(__dirname, 'lib'),
  },
  plugins: [
    new AsyncModulePlugin()
  ]
}
```

### result
1. the `lib/index` is the async module manifest-runtime
1. the other folder is the async module assets

