"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useCellarDevTools = exports.PLUGIN_ID = void 0;
var protocol_1 = require("./src/shared/protocol");
Object.defineProperty(exports, "PLUGIN_ID", { enumerable: true, get: function () { return protocol_1.PLUGIN_ID; } });
// Constant in a release build, where Metro folds the condition and drops the `require` with everything behind it.
const isDev = process.env.NODE_ENV !== 'production';
const isWeb = typeof window !== 'undefined' && window.navigator.product !== 'ReactNative';
if (isDev && !isWeb) {
    exports.useCellarDevTools = require('./src/react-native/use_cellar_devtools').useCellarDevTools;
}
else {
    exports.useCellarDevTools = () => { };
}
