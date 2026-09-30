export { PLUGIN_ID } from './src/shared/protocol';
export let useCellarDevTools;
// Constant in a release build, where Metro folds the condition and drops the `require` with everything behind it.
const isDev = process.env.NODE_ENV !== 'production';
const isWeb = typeof window !== 'undefined' && window.navigator.product !== 'ReactNative';
if (isDev && !isWeb) {
    useCellarDevTools = require('./src/react-native/use_cellar_devtools').useCellarDevTools;
}
else {
    useCellarDevTools = () => { };
}
