const config = require(`${process.cwd()}/package.json`);
const name = config.main.split('.js')[0];

module.exports = [{
  name,
  webpack: {
    devtool: 'source-map',
    entry: {
      [name]: `./src/${config.main}`,
    },
    output: {
      library: '[name].js',
      libraryTarget: 'umd',
    },
    externals: {
      generator: 'node-modules',
      additional: ['readline'],
    },
    resolve: {
      generator: 'npm-and-modules',
      extensions: ['.js', '.json'],
    },
    loaders: [
      {
        test: /\.es6\.js$|\.js$|\.jsx$/,
        exclude: /node_modules/,
        loader: 'babel',
        query: {
          presets: [
            'es2015-native-modules',
          ],
          plugins: [
            'syntax-decorators',
            'syntax-class-properties',
            'transform-decorators-legacy',
            'transform-decorators',
            'transform-class-properties',
            'transform-async-to-generator',
            'transform-object-rest-spread',
          ],
        },
      },
      'json',
    ],
    plugins: [
      'production-loaders',
      'minify-and-treeshake',
      'abort-if-errors',
      'node-load-sourcemaps',
    ],
    node: {
      Buffer: false,
      process: false,
      global: false,
      __filename: true,
      __dirname: true,
    },
  },
}];
